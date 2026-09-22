"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { TurnUtils } from "../../core/TurnUtils.js";
import { ViewController } from "./ViewController.js";
import { AlertController } from "./AlertController.js";
import { CountdownController } from "./CountdownController.js";
import { ResultsController } from "./ResultsController.js";
import { LocalPlayerController } from "./LocalPlayerController.js";
import { SuitSelectionController } from "./SuitSelectionController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { OpponentUtils } from "../utilities/OpponentUtils.js";
import { PlayingCard } from "../PlayingCard.js";

/** Controls the complete Pick2 Room. */
export class RoomController extends ViewController {
    /** @type {Object|null} Latest authoritative Room transport snapshot. */
    room = null;

    /** @type {Object} Current transport and room-command capabilities. */
    capabilities = {};

    /** @type {Object|null} Pending create, join, or view request. */
    #intent = null;

    /** @type {Function|null} Navigation callback invoked when Room returns Home. */
    #homeHandler = null;

    /** @type {Function|null} Callback invoked after the first authoritative Room snapshot. */
    #readyHandler = null;

    /** @type {boolean} Whether the client-open intent has already been submitted. */
    #hasOpened = false;

    /** @type {boolean} Whether a leave request is suppressing further Room work. */
    #isLeaving = false;

    /** @type {AlertController} Room-level notification overlay. */
    #alertController = new AlertController("#alert-dialog");

    /** Initializes required state and event bindings. */
    async _initializeRoomView() {
        await RoomRowUtils.load();
        DomUtils.require("#room-leave-button", HTMLButtonElement).addEventListener("click", this.#leave.bind(this));
        DomUtils.require("#app-home-link", HTMLAnchorElement).addEventListener("click", this.#leave.bind(this));
        DomUtils.require("#room-join-button", HTMLButtonElement).addEventListener("click", this.#join.bind(this));
        DomUtils.require("#room-invite-button", HTMLButtonElement).addEventListener("click", this.#handleInvite.bind(this));
    }

    /** Renders the current authoritative state. */
    _renderRoom(room) {
        if (room === null) return;
        this.room = room;
        this.renderRoomInformation(room);
        this.renderGameCommands(room.localActorName === null ? null : room.localActorName);
    }

    /** Resolves Room shell elements and initializes shared subcontrollers. */
    constructor() {
        super("#room-view");
    }

    /** Sets client. */
    setClient(client) {
        this.client = client;
    }

    /** Sets intent. */
    setIntent(intent) {
        this.#intent = intent;
    }

    /** Sets home handler. */
    setHomeHandler(handler) {
        this.#homeHandler = handler;
    }

    /** Sets ready handler. */
    setReadyHandler(handler) {
        this.#readyHandler = handler;
    }

    /** Prevents duplicate exits and submits the authenticated leave command. */
    #leave(event) {
        event.preventDefault();
        this.#isLeaving = true;
        const requestAccepted = this.client?.request(Constants.COMMANDS.LEAVE, {}) === true;

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

    /** Submits the saved Room intent once the endpoint becomes available. */
    handleClientOpen() {
        if (this.#intent === null) {
            this.#homeHandler?.(null);
            return;
        }

        let command = this.#intent.command;

        if (this.#hasOpened && command === Constants.COMMANDS.CREATE) {
            command = Constants.COMMANDS.JOIN;
        }

        this.#hasOpened = true;
        this.client?.request(command, this.#intent.data);
    }

    /** Routes Home transitions or stores and renders an authoritative Room snapshot. */
    handleData(view, data, message = null) {
        if (view === Constants.VIEWS.ROOM) {
            this.capabilities = ValidationUtils.object(data.capabilities, "Capabilities");
            this.#readyHandler?.(data);
            this.render(data);
        } else if (view === Constants.VIEWS.HOME && (this.#isLeaving || message !== null)) {
            this.#homeHandler?.(message);
        }
    }

    /** Normalizes and presents a Room notification. */
    handleNotification(message) {
        if (this.room === null && !this.#isLeaving) {
            this.#homeHandler?.(message);
            return;
        }

        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /** Reflects endpoint status and label in the shared application header. */
    handleConnectionStatus(status, label) {
        const root = DomUtils.require("#app-header > aside[data-status]", HTMLElement);
        root.dataset.status = status;
        DomUtils.require("#connection-status-label", HTMLElement).textContent = label;
    }

    /** Renders room information. */
    renderRoomInformation(room) {
        DomUtils.require("#info-table-body", HTMLTableSectionElement).replaceChildren(RoomRowUtils.create(room));
    }

    /** Renders game commands. */
    renderGameCommands(localPlayer) {
        DomUtils.require("#room-leave-button", HTMLButtonElement).hidden = false;
        DomUtils.require("#room-join-button", HTMLButtonElement).hidden =
            localPlayer !== null || this.capabilities.join !== true;
        DomUtils.require("#room-invite-button", HTMLButtonElement).hidden = this.capabilities.invite !== true;
    }

    /** Reads the join form and submits a join command for the current Room. */
    #join() {
        const playerName = window.prompt("Enter your name:");

        if (playerName?.trim() && this.room?.name) {
            this.client?.request(Constants.COMMANDS.JOIN, {
                roomName: this.room.name,
                playerName
            });
        }
    }

    /** Uses native sharing when available, otherwise copies the Room URL. */
    async #copyInvite() {
        if (!this.room?.name) {
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

    /** @type {string} Previously rendered Room lifecycle state for transition detection. */
    #previousState = "";

    /** @type {LocalPlayerController} Local actor hand and command controller. */
    #playerController = new LocalPlayerController("#actor-region", false);

    /** @type {SuitSelectionController} Pending ace suit-declaration dialog. */
    #suitController = new SuitSelectionController("#suit-selection-dialog");

    /** @type {CountdownController} Round-transition countdown overlay. */
    #countdownController = new CountdownController("#countdown-dialog");

    /** @type {ResultsController} Finished-round results dialog. */
    #resultsController = new ResultsController("#results-dialog");

    /** Initializes required state and event bindings. */
    async initialize() {
        await this._initializeRoomView();
        await OpponentUtils.load();
        this.#playerController.initialize();
        this.#playerController.setCommandHandler(this.#handlePlayerCommand.bind(this));
        this.#playerController.setSortHandler(this.#handleSortChange.bind(this));
        this.#suitController.setSubmitHandler(this.#handleSuitSelection.bind(this));
        DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement).addEventListener(
            "card_drop",
            this.#handleCardDrop.bind(this)
        );
        DomUtils.require("#player-hand > [data-is-drag-over]", HTMLElement).addEventListener(
            "card_drop",
            this.#handleCardReturn.bind(this)
        );
    }

    /** Submits a local actor command and clears temporary sort after drawing. */
    #handlePlayerCommand(command) {
        if (RoomController.#isCardMove(command)) {
            this.#sendCardMove(command, {});
        } else {
            this.client?.request(command, {});
        }
    }

    /** Stores and immediately rerenders the local hand’s presentation order. */
    #handleSortChange(sortKey) {
        this.client.sortKey = ValidationUtils.requiredString(sortKey, "Sort key");
        this.render(this.room);
    }

    /** Submits the selected suit for the pending declaration. */
    #handleSuitSelection(suit) {
        this.client?.request(Constants.COMMANDS.DECLARE, { suit });
    }

    /** Converts a hand-to-pile card drop into a discard request. */
    #handleCardDrop(event) {
        if (event instanceof CustomEvent && event.detail?.card) {
            this.#sendCardMove(Constants.COMMANDS.DISCARD, { card: event.detail.card });
        }
    }

    /** Converts an eligible pile-to-hand card drop into a return request. */
    #handleCardReturn(event) {
        const allowsFreeTransactions =
            this.room?.state === Constants.ROOM_STATE.WAITING ||
            this.room?.state === Constants.ROOM_STATE.FINISHED;

        if (event instanceof CustomEvent && event.detail?.card && allowsFreeTransactions) {
            this.#sendCardMove(Constants.COMMANDS.RETURN, { card: event.detail.card });
        }
    }

    /** Renders the current authoritative state. */
    render(room) {
        if (room === null) {
            return;
        }

        const previousState = this.#previousState;
        const nextState = ValidationUtils.optionalString(room.state, "");
        const localPlayer = RoomController.#getLocalPlayer(room);

        this.room = room;
        this.#previousState = nextState;

        this._renderRoom(room);

        const playRegion = DomUtils.require(':is([data-game-region="act"], [data-game-region="view"])', HTMLElement);
        playRegion.dataset.mode = room.mode;
        playRegion.dataset.state = room.state;

        this.#renderPlayers(room);
        this.#renderDiscardPile(room, localPlayer);
        this.#renderLocalPlayer(localPlayer, room);

        if (
            localPlayer !== null &&
            previousState === Constants.ROOM_STATE.WAITING &&
            nextState === Constants.ROOM_STATE.ACTIVE
        ) {
            this.#countdownController.show(Constants.COUNTDOWN_SECONDS);
        }

        const requiresSuitSelection =
            room.pending?.command === Constants.COMMANDS.DECLARE &&
            localPlayer !== null &&
            TurnUtils.isTurnOwner(room.turnOrder?.ownerKey, localPlayer.key);

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
        } else if (localPlayer === null || nextState !== Constants.ROOM_STATE.FINISHED) {
            this.#resultsController.hide();
        }
    }

    /** Extracts card identity from a drop event and sends the named movement command. */
    #sendCardMove(command, data) {
        if (this.client?.request(command, data)) {
            this.client.sortKey = Constants.CARD.SORT_OPTIONS[0];
            this.render(this.room);
        }
    }

    /** Returns whether card move. */
    static #isCardMove(command) {
        return (
            command === Constants.COMMANDS.DRAW ||
            command === Constants.COMMANDS.DISCARD ||
            command === Constants.COMMANDS.RETURN ||
            command === Constants.COMMANDS.PASS
        );
    }

    /** Renders players. */
    #renderPlayers(room) {
        const container = DomUtils.require("#opponent-list", HTMLUListElement);
        const localName = room.localActorName ?? null;

        container.replaceChildren();

        const players = ResultsController.localFirst(RoomController.#getPlayers(room), localName);

        for (const player of players) {
            if (player.name !== localName) {
                container.appendChild(
                    OpponentUtils.create(
                        {
                            ...player,
                            itemCount: player.collection.items.length
                        },
                        room.turnOrder.ownerKey,
                        "card"
                    )
                );
            }
        }
    }

    /** Renders discard pile. */
    #renderDiscardPile(room, localPlayer) {
        const cards = Array.isArray(room.collections?.play?.items) ? room.collections.play.items : [];
        const allowsFreeTransactions =
            room.state === Constants.ROOM_STATE.WAITING || room.state === Constants.ROOM_STATE.FINISHED;
        const destination =
            allowsFreeTransactions && localPlayer !== null && room.pending === null
                ? DomUtils.require("#player-hand > [data-is-drag-over]", HTMLElement)
                : null;

        const elements = [];

        for (const card of cards) {
            elements.push(PlayingCard.create(card, card.value ? destination : null));
        }

        DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement).replaceChildren(...elements);
    }

    /** Renders local player. */
    #renderLocalPlayer(player, room) {
        if (player === null) {
            this.#playerController.hide();
            return;
        }

        this.#playerController.setCanRestartFinishedGame(this.capabilities.restart === true);
        this.#playerController.show(player, room, this.client.sortKey);
    }

    /** Returns the authoritative actors array or an empty fallback. */
    static #getPlayers(room) {
        return Array.isArray(room?.turnOrder?.actors) ? room.turnOrder.actors : [];
    }

    /** Resolves the local actor snapshot by the Room’s canonical local name. */
    static #getLocalPlayer(room) {
        const playerName = room?.localActorName ?? null;

        for (const player of RoomController.#getPlayers(room)) {
            if (player.name === playerName) {
                return player;
            }
        }

        return null;
    }
}
