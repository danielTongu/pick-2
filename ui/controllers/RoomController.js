"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { ViewController } from "./ViewController.js";
import { AlertController } from "./AlertController.js";
import { CountdownController } from "./CountdownController.js";
import { ResultsController } from "./ResultsController.js";
import { LocalActorController } from "./LocalActorController.js";
import { SuitSelectionController } from "./SuitSelectionController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { ActorUtils } from "../utilities/ActorUtils.js";
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
        this.renderMatchCommands(room.localActorName === null ? null : room.localActorName);
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
        const root = DomUtils.require("#app-header > aside[data-status]", HTMLElement);
        root.dataset.status = status;
        DomUtils.require("#connection-status-label", HTMLElement).textContent = label;
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
     * @param {string|null} localActor - Local actor name, if joined.
     */
    renderMatchCommands(localActor) {
        DomUtils.require("#room-leave-button", HTMLButtonElement).hidden = false;
        DomUtils.require("#room-join-button", HTMLButtonElement).hidden =
            localActor !== null || this.capabilities.join !== true;
        DomUtils.require("#room-invite-button", HTMLButtonElement).hidden = this.capabilities.invite !== true;
    }

    /** Reads the join form and submits a join command for the current Room. */
    #join() {
        if (this.room === null || this.room.localActorName !== null || this.capabilities.join !== true) return;
        const actorName = window.prompt("Enter your name:");

        if (actorName?.trim() && this.room?.name) {
            this.view?.request(Constants.COMMANDS.JOIN, {
                roomName: this.room.name,
                actorName
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
     * @type {LocalActorController} Local actor hand and command controller.
     */
    #actorController = new LocalActorController("#local-actor-region");

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
        await ActorUtils.load();
        this.#actorController.initialize();
        this.#actorController.setCommandHandler(this.#handleActorCommand.bind(this));
        this.#actorController.setSortHandler(this.#handleSortChange.bind(this));
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
     * Submits a local actor command and clears temporary sort after drawing.
     * @param {string} command - Room command.
     */
    #handleActorCommand(command) {
        if (!this.#canSubmitActorCommand(command)) return;
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
     * Checks the latest room state before a local actor button action.
     * @param {string} command - Room command.
     * @returns {boolean} Whether the action is currently permitted.
     */
    #canSubmitActorCommand(command) {
        const actor = RoomController.#getLocalActor(this.room);
        if (actor === null) return false;
        const match = this.room.match;
        if (match.pending !== null) return false;

        if (command === Constants.COMMANDS.START) {
            const canStart = match.state === Constants.ROOM_STATE.WAITING ||
                (this.capabilities.restart === true && match.state === Constants.ROOM_STATE.FINISHED);
            return canStart && match.turnOrder?.actorCount >= 2 &&
                (!match.isKnockout || match.isKnockoutComplete || match.nextMatchAvailable);
        }
        if (command === Constants.COMMANDS.PASS) {
            return match.state === Constants.ROOM_STATE.ACTIVE && match.turnOrder?.ownerKey === actor.key;
        }
        if (command === Constants.COMMANDS.DRAW) {
            if (match.state === Constants.ROOM_STATE.WAITING ||
                (match.state === Constants.ROOM_STATE.FINISHED && !match.isKnockout)) return true;
            const ownerKey = match.turnOrder?.ownerKey ?? null;
            return match.state === Constants.ROOM_STATE.ACTIVE &&
                (!ownerKey || (ownerKey === actor.key && actor.drawAllowance > 0));
        }
        return true;
    }

    /** Submits the Knockout choice from the Play dialog. */
    #chooseKnockout(knockout) {
        this.#closePlayDialog();
        if (!this.#canSubmitActorCommand(Constants.COMMANDS.START)) return;
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
        this.#renderLocalActor(RoomController.#getLocalActor(this.room), this.room);
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
        const localActor = RoomController.#getLocalActor(room);

        if (nextState === Constants.ROOM_STATE.ACTIVE && this.#playDialog !== null) {
            this.#closePlayDialog();
        }

        this.room = room;
        this.#previousState = nextState;

        this._renderRoom(room);

        const playRegion = DomUtils.require('[data-has-local-actor]', HTMLElement);
        playRegion.dataset.connectionMode = room.connectionMode;
        playRegion.dataset.matchState = room.match.state;

        this.#renderActors(room);
        this.#renderDiscardPile(room);
        this.#renderLocalActor(localActor, room);

        if (
            localActor !== null &&
            previousState !== Constants.ROOM_STATE.ACTIVE &&
            nextState === Constants.ROOM_STATE.ACTIVE
        ) {
            this.#countdownController.show(Constants.COUNTDOWN_SECONDS, room.match.isKnockout
                ? "Knockout match starting" : "Game starting");
        }

        const requiresSuitSelection =
            room.match.pending?.command === Constants.COMMANDS.DECLARE &&
            localActor !== null &&
            room.match.turnOrder?.ownerKey === localActor.key;

        if (requiresSuitSelection) {
            this.#suitController.show();
        } else {
            this.#suitController.hide();
        }

        if (
            localActor !== null &&
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
            this.#renderLocalActor(RoomController.#getLocalActor(this.room), this.room);
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
     * Renders remote actors.
     * @param {Object} room - Room snapshot.
     */
    #renderActors(room) {
        const container = DomUtils.require("#actors-list", HTMLUListElement);
        const localName = room.localActorName ?? null;

        const actors = ResultsController.localFirst(RoomController.#getActors(room), localName);
        const rows = new Map(Array.from(container.children, function indexRow(element) {
            return [element.dataset.actorKey, element];
        }));
        const ordered = [];

        for (const actor of actors) {
            if (actor.name !== localName) {
                const data = { ...actor, itemCount: actor.collection.items.length,
                    pieceName: "card" };
                const row = rows.get(actor.key) ?? ActorUtils.create(data);
                if (rows.has(actor.key)) ActorUtils.updateElement(row, data);
                row.dataset.actorKey = actor.key;
                rows.delete(actor.key);
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
     * Renders the local actor.
     * @param {Object|null} actor - Local actor snapshot, if joined.
     * @param {Object} room - Room snapshot.
     */
    #renderLocalActor(actor, room) {
        if (actor === null) {
            this.#actorController.hide();
            return;
        }

        this.#actorController.show(actor, room, this.view.sortKey);
    }

    /**
     * Returns the authoritative actors array or an empty fallback.
     * @param {Object} room - Room snapshot.
     * @returns {Object[]} Actor snapshots.
     */
    static #getActors(room) {
        return Array.isArray(room?.match?.turnOrder?.actors) ? room.match.turnOrder.actors : [];
    }

    /**
     * Resolves the local actor snapshot by the Room’s canonical local name.
     * @param {Object} room - Room snapshot.
     * @returns {Object|null} Local actor snapshot, if joined.
     */
    static #getLocalActor(room) {
        const actorName = room?.localActorName ?? null;

        for (const actor of RoomController.#getActors(room)) {
            if (actor.name === actorName) {
                return actor;
            }
        }

        return null;
    }
}
