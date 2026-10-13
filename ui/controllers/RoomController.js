"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { ViewController } from "./ViewController.js";
import { AlertController } from "./AlertController.js";
import { CountdownController } from "./CountdownController.js";
import { ResultsController } from "./ResultsController.js";
import { LocalPlayerController } from "./LocalPlayerController.js";
import { SuitSelectionController } from "./SuitSelectionController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { PlayerUtils } from "../utilities/PlayerUtils.js";
import { CardListUtils } from "../utilities/CardListUtils.js";

/** Controls the complete Pick2 Room. */
export class RoomController extends ViewController {
    /**
     * @type {Object|null} Latest authoritative Room transport snapshot.
     */
    room = null;

    /**
     * @type {Object} Current transport and room-command capabilities.
     */
    capabilities = {};

    /**
     * @type {Function|null} Navigation callback invoked when Room returns Home.
     */
    #homeHandler = null;

    /**
     * @type {Function|null} Callback invoked after the first authoritative Room snapshot.
     */
    #readyHandler = null;

    /**
     * @type {boolean} Whether a leave request is suppressing further Room work.
     */
    #isLeaving = false;

    /**
     * @type {AlertController} Room-level notification overlay.
     */
    #alertController = new AlertController("#alert-dialog");

    /** Initializes required state and event bindings. */
    async _initializeRoomSession() {
        await RoomRowUtils.load();
        DomUtils.require("#room-leave-button", HTMLButtonElement).addEventListener("click", this.#leave.bind(this));
        DomUtils.require("#app-home-link", HTMLAnchorElement).addEventListener("click", this.#leave.bind(this));
        DomUtils.require("#room-join-button", HTMLButtonElement).addEventListener("click", this.#join.bind(this));
        DomUtils.require("#room-invite-button", HTMLButtonElement).addEventListener("click", this.#handleInvite.bind(this));
    }

    /**
     * Renders the current authoritative state.
     * @param {Object|null} room - Room snapshot.
     */
    _renderRoom(room) {
        if (room === null) return;
        this.room = room;
        this.renderRoomInformation(room);
        this.renderMatchCommands(room.localPlayerName === null ? null : room.localPlayerName);
    }

    /** Resolves Room shell elements and initializes shared subcontrollers. */
    constructor() {
        super("#room-view");
    }

    /**
     * Sets the active endpoint view.
     * @param {import("../Session.js").Session} view - Active Room session.
     */
    setView(view) {
        this.view = view;
    }

    /**
     * Sets the Home navigation callback.
     * @param {Function} handler - Home navigation callback.
     */
    setHomeHandler(handler) {
        this.#homeHandler = handler;
    }

    /**
     * Sets the first-room-snapshot callback.
     * @param {Function} handler - Ready callback.
     */
    setReadyHandler(handler) {
        this.#readyHandler = handler;
    }

    /**
     * Prevents duplicate exits and submits the authenticated leave command.
     * @param {Event} event - Leave-button or link event.
     */
    #leave(event) {
        event.preventDefault();
        this.#isLeaving = true;
        const requestAccepted = this.view?.request(Constants.COMMANDS.LEAVE, {}) === true;

        if (requestAccepted) {
            this.#homeHandler?.(null);
        } else {
            this.#isLeaving = false;
        }
    }

    /** Copies or shares the current Room URL when Hosted invite capability is available. */
    #handleInvite() {
        void this.#copyInvite();
    }

    /** Requests room admission when the client connection becomes available. */
    handleClientOpen() {
        this.view?.openRoom();
    }

    /**
     * Routes Home transitions or stores and renders an authoritative Room snapshot.
     * @param {string} view - Destination view name.
     * @param {Object} data - Authoritative view data.
     * @param {Object|null} message - Optional Home transition message.
     */
    handleData(view, data, message = null) {
        if (view === Constants.VIEWS.ROOM) {
            this.capabilities = ValidationUtils.object(data.capabilities, "Capabilities");
            this.#readyHandler?.(data);
            this.render(data);
        } else if (view === Constants.VIEWS.HOME && (this.#isLeaving || message !== null)) {
            this.#homeHandler?.(message);
        }
    }

    /**
     * Normalizes and presents a Room notification.
     * @param {Object} message - Notification payload.
     */
    handleNotification(message) {
        if (this.room === null && !this.#isLeaving) {
            this.#homeHandler?.(message);
            return;
        }

        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /**
     * Reflects endpoint status and label in the shared application header.
     * @param {string} status - Connection status.
     * @param {string} label - Status display label.
     */
    handleConnectionStatus(status, label) {
        DomUtils.require("#app-header > aside", HTMLElement).dataset.connectionStatus = status;
        DomUtils.require("#site-shell", HTMLElement).dataset.connectionMode = this.view?.mode ?? "direct";
        DomUtils.require("#app-header > aside", HTMLElement).setAttribute("aria-label", `Connection: ${label}`);
    }

    /**
     * Renders room information.
     * @param {Object} room - Room snapshot.
     */
    renderRoomInformation(room) {
        const body = DomUtils.require("#info-table-body", HTMLTableSectionElement);
        const row = body.firstElementChild;
        if (row instanceof HTMLTableRowElement && row.querySelector("[data-name]") !== null) {
            RoomRowUtils.updateElement(row, room);
        } else {
            body.replaceChildren(RoomRowUtils.create(room));
        }
    }

    /**
     * Renders match commands.
     * @param {string|null} localPlayer - Local player name, if joined.
     */
    renderMatchCommands(localPlayer) {
        this.root.dataset.membership = localPlayer === null ? "viewer" : "player";
    }

    /** Reads the join form and submits a join command for the current Room. */
    #join() {
        if (this.room === null || this.room.localPlayerName !== null || this.capabilities.join !== true) return;
        const playerName = window.prompt("Enter your name:");

        if (playerName?.trim() && this.room?.name) {
            this.view?.request(Constants.COMMANDS.JOIN, {
                roomName: this.room.name,
                playerName
            });
        }
    }

    /** Uses native sharing when available, otherwise copies the Room URL. */
    async #copyInvite() {
        if (!this.room?.name || this.capabilities.invite !== true) {
            return;
        }

        const url = new URL("./room.html", location.href);
        url.searchParams.set("mode", "hosted");
        url.searchParams.set("room", this.room.name);

        try {
            await navigator.clipboard.writeText(url.href);
            this.handleNotification({
                status: Constants.STATUS.INFO,
                ...Constants.NOTIFICATIONS.INVITE_COPIED
            });
        } catch (_error) {
            this.handleNotification({
                status: Constants.STATUS.ERROR,
                ...Constants.NOTIFICATIONS.COPY_FAILED
            });
        }
    }

    /**
     * @type {string} Previously rendered Room lifecycle state for transition detection.
     */
    #previousState = "";

    /**
     * @type {LocalPlayerController} Local player hand and command controller.
     */
    #playerController = new LocalPlayerController("#local-player-region");

    /**
     * @type {SuitSelectionController} Pending ace suit-declaration dialog.
     */
    #suitController = new SuitSelectionController("#suit-selection-dialog");

    /**
     * @type {CountdownController} Match-transition countdown overlay.
     */
    #countdownController = new CountdownController("#countdown-dialog");

    /**
     * @type {ResultsController} Finished-match results dialog.
     */
    #resultsController = new ResultsController("#results-dialog");

    /** @type {HTMLElement} Play mode choice overlay. */
    #playDialog = null;

    /** Initializes required state and event bindings. */
    async initialize() {
        await this._initializeRoomSession();
        await PlayerUtils.load();
        this.#playerController.initialize();
        this.#playerController.setCommandHandler(this.#handlePlayerCommand.bind(this));
        this.#playerController.setSortHandler(this.#handleSortChange.bind(this));
        this.#suitController.setSubmitHandler(this.#handleSuitSelection.bind(this));
        this.#playDialog = DomUtils.require("#play-dialog", HTMLElement);
        DomUtils.require("#play-one-button", HTMLButtonElement).addEventListener("click",
            this.#chooseKnockout.bind(this, false));
        DomUtils.require("#play-knockout-button", HTMLButtonElement).addEventListener("click",
            this.#chooseKnockout.bind(this, true));
        DomUtils.require("#play-cancel-button", HTMLButtonElement).addEventListener("click",
            this.#closePlayDialog.bind(this));
        DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement).addEventListener(
            "card_drop",
            this.#handleCardDrop.bind(this)
        );
    }

    /**
     * Submits a local player command and clears temporary sort after drawing.
     * @param {string} command - Room command.
     */
    #handlePlayerCommand(command) {
        if (!this.#canSubmitPlayerCommand(command)) return;
        if (command === Constants.COMMANDS.START) {
            if (this.room?.match?.nextMatchAvailable === true) {
                this.view?.request(Constants.COMMANDS.START, {});
            } else {
                this.#playDialog.dataset.state = Constants.PLAY_DIALOG_STATE.OPEN;
            }
        } else if (RoomController.#isCardMove(command)) {
            this.#sendCardMove(command, {});
        } else {
            this.view?.request(command, {});
        }
    }

    /**
     * Checks the latest room state before a local player button action.
     * @param {string} command - Room command.
     * @returns {boolean} Whether the action is currently permitted.
     */
    #canSubmitPlayerCommand(command) {
        const player = RoomController.#getLocalPlayer(this.room);
        if (player === null) return false;
        const match = this.room.match;
        if (match.pending !== null) return false;

        if (command === Constants.COMMANDS.START) {
            const canStart = match.state === Constants.ROOM_STATE.WAITING ||
                (this.capabilities.restart === true && match.state === Constants.ROOM_STATE.FINISHED);
            return canStart && match.turnOrder?.playerCount >= 2 &&
                (!match.isKnockout || match.isKnockoutComplete || match.nextMatchAvailable);
        }
        if (command === Constants.COMMANDS.PASS) {
            return match.state === Constants.ROOM_STATE.ACTIVE && match.turnOrder?.ownerKey === player.key;
        }
        if (command === Constants.COMMANDS.DRAW) {
            if (match.state === Constants.ROOM_STATE.WAITING ||
                (match.state === Constants.ROOM_STATE.FINISHED && !match.isKnockout)) return true;
            const ownerKey = match.turnOrder?.ownerKey ?? null;
            return match.state === Constants.ROOM_STATE.ACTIVE &&
                (!ownerKey || (ownerKey === player.key && player.drawAllowance > 0));
        }
        return true;
    }

    /** Submits the Knockout choice from the Play dialog. */
    #chooseKnockout(knockout) {
        this.#closePlayDialog();
        if (!this.#canSubmitPlayerCommand(Constants.COMMANDS.START)) return;
        this.view?.request(Constants.COMMANDS.START, { knockout });
    }

    /** Closes the Play dialog without starting a match. */
    #closePlayDialog() {
        this.#playDialog.dataset.state = Constants.PLAY_DIALOG_STATE.CLOSED;
    }

    /**
     * Stores and immediately rerenders the local hand’s presentation order.
     * @param {string} sortKey - Selected hand sort order.
     */
    #handleSortChange(sortKey) {
        this.view.sortKey = ValidationUtils.requiredString(sortKey, "Sort key");
        this.#renderLocalPlayer(RoomController.#getLocalPlayer(this.room), this.room);
    }

    /**
     * Submits the selected suit for the pending declaration.
     * @param {string} suit - Declared suit.
     */
    #handleSuitSelection(suit) {
        this.view?.request(Constants.COMMANDS.DECLARE, { suit });
    }

    /**
     * Converts a hand-to-pile card drop into a discard request.
     * @param {Event} event - Card-drop event.
     */
    #handleCardDrop(event) {
        if (event instanceof CustomEvent && event.detail?.card) {
            this.#sendCardMove(Constants.COMMANDS.DISCARD, { card: event.detail.card });
        }
    }

    /**
     * Renders the current authoritative state.
     * @param {Object|null} room - Room snapshot.
     */
    render(room) {
        if (room === null) {
            return;
        }

        const previousState = this.#previousState;
        const nextState = ValidationUtils.optionalString(room.match.state, "");
        const localPlayer = RoomController.#getLocalPlayer(room);

        if (nextState === Constants.ROOM_STATE.ACTIVE && this.#playDialog !== null) {
            this.#closePlayDialog();
        }

        this.room = room;
        this.#previousState = nextState;

        this._renderRoom(room);

        const playerCommands = DomUtils.require("#player-commands", HTMLElement);
        DomUtils.require("#site-shell", HTMLElement).dataset.connectionMode = room.connectionMode;
        playerCommands.dataset.matchState = room.match.state;

        this.#renderPlayers(room);
        this.#renderDiscardPile(room);
        this.#renderLocalPlayer(localPlayer, room);

        if (
            localPlayer !== null &&
            previousState !== Constants.ROOM_STATE.ACTIVE &&
            nextState === Constants.ROOM_STATE.ACTIVE
        ) {
            this.#countdownController.show(Constants.COUNTDOWN_SECONDS, room.match.isKnockout
                ? "Knockout match starting" : "Game starting");
        }

        const requiresSuitSelection =
            room.match.pending?.command === Constants.COMMANDS.DECLARE &&
            localPlayer !== null &&
            room.match.turnOrder?.ownerKey === localPlayer.key;

        if (requiresSuitSelection) {
            this.#suitController.show();
        } else {
            this.#suitController.hide();
        }

        if (
            localPlayer !== null &&
            previousState !== Constants.ROOM_STATE.FINISHED &&
            nextState === Constants.ROOM_STATE.FINISHED
        ) {
            this.#resultsController.show(room);
        } else if (nextState !== Constants.ROOM_STATE.FINISHED) {
            this.#resultsController.hide();
        }
    }

    /**
     * Sends the named card movement command and restores the default sort order.
     * @param {string} command - Card movement command.
     * @param {Object} data - Command payload.
     */
    #sendCardMove(command, data) {
        if (this.view?.request(command, data)) {
            this.view.sortKey = Constants.CARD.SORT_OPTIONS[0];
            this.#renderLocalPlayer(RoomController.#getLocalPlayer(this.room), this.room);
        }
    }

    /**
     * Returns whether a command moves cards.
     * @param {string} command - Room command.
     * @returns {boolean} Whether the command moves cards.
     */
    static #isCardMove(command) {
        return (
            command === Constants.COMMANDS.DRAW ||
            command === Constants.COMMANDS.DISCARD ||
            command === Constants.COMMANDS.PASS
        );
    }

    /**
     * Renders remote players.
     * @param {Object} room - Room snapshot.
     */
    #renderPlayers(room) {
        const container = DomUtils.require("#players-list", HTMLUListElement);
        const localName = room.localPlayerName ?? null;

        const players = ResultsController.localFirst(RoomController.#getPlayers(room), localName);
        const rows = new Map(Array.from(container.children, function indexRow(element) {
            return [element.dataset.playerKey, element];
        }));
        const ordered = [];

        for (const player of players) {
            if (player.name !== localName) {
                const data = { ...player, itemCount: player.collection.items.length,
                    pieceName: "card" };
                const row = rows.get(player.key) ?? PlayerUtils.create(data);
                if (rows.has(player.key)) PlayerUtils.updateElement(row, data);
                row.dataset.playerKey = player.key;
                rows.delete(player.key);
                ordered.push(row);
            }
        }
        for (const row of rows.values()) row.remove();
        for (let index = ordered.length - 1; index >= 0; index -= 1) {
            if (ordered[index].parentElement !== container ||
                ordered[index].nextElementSibling !== (ordered[index + 1] ?? null)) {
                container.insertBefore(ordered[index], ordered[index + 1] ?? null);
            }
        }
    }

    /**
     * Renders the discard pile.
     * @param {Object} room - Room snapshot.
     */
    #renderDiscardPile(room) {
        const cards = Array.isArray(room.match.collections?.play?.items) ? room.match.collections.play.items : [];
        const pile = DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement);
        CardListUtils.update(pile, cards);
    }

    /**
     * Renders the local player.
     * @param {Object|null} player - Local player snapshot, if joined.
     * @param {Object} room - Room snapshot.
     */
    #renderLocalPlayer(player, room) {
        if (player === null) {
            this.#playerController.hide();
            return;
        }

        this.#playerController.show(player, room, this.view.sortKey);
    }

    /**
     * Returns the authoritative players array or an empty fallback.
     * @param {Object} room - Room snapshot.
     * @returns {Object[]} Player snapshots.
     */
    static #getPlayers(room) {
        return Array.isArray(room?.match?.turnOrder?.players) ? room.match.turnOrder.players : [];
    }

    /**
     * Resolves the local player snapshot by the Room’s canonical local name.
     * @param {Object} room - Room snapshot.
     * @returns {Object|null} Local player snapshot, if joined.
     */
    static #getLocalPlayer(room) {
        const playerName = room?.localPlayerName ?? null;

        for (const player of RoomController.#getPlayers(room)) {
            if (player.name === playerName) {
                return player;
            }
        }

        return null;
    }
}
