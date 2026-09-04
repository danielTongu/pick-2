"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { TurnUtils } from "../../core/TurnUtils.js";
import { AlertController } from "./AlertController.js";
import { CountdownController } from "./CountdownController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { ResultsController } from "./ResultsController.js";
import { LocalPlayerController } from "./LocalPlayerController.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { OpponentUtils } from "../utilities/OpponentUtils.js";
import { PlayerDisplayUtils } from "../utilities/PlayerDisplayUtils.js";
import { PlayingCard } from "../PlayingCard.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { SuitSelectionController } from "./SuitSelectionController.js";
import { ViewController } from "./ViewController.js";

/** Controls the active Room for both Local and Network play. */
export class RoomController extends ViewController {
    /** @type {Object|null} */
    #room = null;

    /** @type {Object} */
    #capabilities = {};

    /** @type {{action:string,data:Object}|null} */
    #intent = null;

    /** @type {Function|null} */
    #homeHandler = null;

    /** @type {Function|null} */
    #readyHandler = null;

    /** @type {string} */
    #previousStatus = "";

    /** @type {boolean} */
    #hasOpened = false;

    /** @type {boolean} */
    #isLeaving = false;

    /** @type {AlertController} */
    #alertController = new AlertController("#alert-dialog");

    /** @type {LocalPlayerController} */
    #playerController = new LocalPlayerController("#player-area", false);

    /** @type {SuitSelectionController} */
    #suitController = new SuitSelectionController("#suit-selection-dialog");

    /** @type {CountdownController} */
    #countdownController = new CountdownController("#countdown-dialog");

    /** @type {ResultsController} */
    #resultsController = new ResultsController("#results-dialog");

    /** Creates the shared active-Room controller. */
    constructor() {
        super("#room-view");
    }

    /** @param {import("../../runtime/Client.js").Client} client - Active endpoint client. */
    setClient(client) {
        this.client = client;
    }

    /** @param {{action:string,data:Object}} intent - Initial Room action. */
    setIntent(intent) {
        this.#intent = intent;
    }

    /** @param {Function} handler - Home-navigation callback. */
    setHomeHandler(handler) {
        this.#homeHandler = handler;
    }

    /** @param {Function} handler - Successful Room-open callback. */
    setReadyHandler(handler) {
        this.#readyHandler = handler;
    }

    /** Loads Room dependencies and binds play controls. */
    async initialize() {
        await Promise.all([RoomRowUtils.load(), OpponentUtils.load()]);
        PlayingCard.setDiscardTarget("#discard-pile");
        this.#playerController.initialize();
        this.#playerController.setActionHandler(this.#handlePlayerAction.bind(this));
        this.#playerController.setSortHandler(this.#handleSortChange.bind(this));
        this.#suitController.setSubmitHandler(this.#handleSuitSelection.bind(this));
        DomUtils.require("#discard-pile", HTMLElement).addEventListener("card_drop", this.#handleCardDrop.bind(this));
        DomUtils.require("#leave-button", HTMLButtonElement).addEventListener("click", this.#leave.bind(this));
        DomUtils.require("#join-button", HTMLButtonElement).addEventListener("click", this.#join.bind(this));
        DomUtils.require("#invite-button", HTMLButtonElement).addEventListener("click", this.#handleInvite.bind(this));
    }

    /** Routes an action selected from the local-player controls. */
    #handlePlayerAction(action) {
        if (RoomController.#isCardMove(action)) {
            this.#sendCardMove(action, {});
        } else {
            this.client?.request(action, {});
        }
    }

    /** Stores and applies a local-only hand sort. */
    #handleSortChange(sortKey) {
        this.client.sortKey = ValidationUtils.requiredString(sortKey, "Sort key");
        this.render(this.#room);
    }

    /** Sends the chosen suit to the host. */
    #handleSuitSelection(suit) {
        this.client?.request(Constants.ACTIONS.DECLARE, {suit});
    }

    /** Sends a dragged card to the discard action. */
    #handleCardDrop(event) {
        if (event instanceof CustomEvent && event.detail?.card) {
            this.#sendCardMove(Constants.ACTIONS.DISCARD, {card: event.detail.card});
        }
    }

    /** Leaves the current room. */
    #leave() {
        this.#isLeaving = true;
        this.client?.request(Constants.ACTIONS.LEAVE, {});
    }

    /** Starts copying the current Network invite. */
    #handleInvite() {
        void this.#copyInvite();
    }

    /** Sends the initial Room action after the endpoint opens. */
    handleClientOpen() {
        if (this.#intent === null) {
            this.#homeHandler?.(null);
            return;
        }

        let action = this.#intent.action;

        if (this.#hasOpened && action === Constants.ACTIONS.CREATE) {
            action = Constants.ACTIONS.JOIN;
        }

        this.#hasOpened = true;
        this.client?.request(action, this.#intent.data);
    }

    /** Renders Room data received from the endpoint. @param {string} view @param {Object} data */
    handleData(view, data) {
        if (view === Constants.VIEWS.ROOM) {
            this.#capabilities = ValidationUtils.object(data.capabilities, "Capabilities");
            this.#readyHandler?.(data);
            this.render(data);
        } else if (view === Constants.VIEWS.HOME && this.#isLeaving) {
            this.#homeHandler?.(null);
        }
    }

    /** Shows a canonical notification. */
    /** Displays a Room notification. @param {Object} message */
    handleNotification(message) {
        if (this.#room === null && !this.#isLeaving) {
            this.#homeHandler?.(message);
            return;
        }

        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /** Updates the connection badge. */
    /** Updates the Room connection indicator. @param {string} status @param {string} label */
    handleConnectionStatus(status, label) {
        const root = DomUtils.require("#connection-status", HTMLElement);
        root.dataset.status = status;
        DomUtils.require("#connection-status-label", HTMLElement).textContent = label;
    }

    /** Renders the current Room data. @param {Object} room - Room data. */
    render(room) {
        if (room === null) {
            return;
        }

        const previousStatus = this.#previousStatus;
        const nextStatus = ValidationUtils.optionalString(room.status, "");
        const localPlayer = RoomController.#getLocalPlayer(room);

        this.#room = room;
        this.#previousStatus = nextStatus;
        this.#renderRoomInformation(room);
        this.#renderPlayers(room);
        this.#renderDiscardPile(room.discardPile);
        this.#renderLocalPlayer(localPlayer, room);
        this.#renderGameActions(localPlayer);

        if (
            localPlayer !== null &&
            previousStatus === Constants.STATUS.WAITING &&
            nextStatus === Constants.STATUS.PLAYING
        ) {
            this.#countdownController.show(Constants.COUNTDOWN_SECONDS);
        }

        const requiresSuitSelection =
            room.status === Constants.STATUS.PENDING &&
            localPlayer !== null &&
            TurnUtils.isTurnOwner(room.circle?.turnOwnerKey, localPlayer.key);

        if (requiresSuitSelection) {
            this.#suitController.show();
        } else {
            this.#suitController.hide();
        }

        if (
            localPlayer !== null &&
            previousStatus !== Constants.STATUS.FINISHED &&
            nextStatus === Constants.STATUS.FINISHED
        ) {
            this.#resultsController.show(room);
        } else if (localPlayer === null || nextStatus !== Constants.STATUS.FINISHED) {
            this.#resultsController.hide();
        }
    }

    /** Sends a card move and resets local sorting after acceptance. */
    #sendCardMove(action, data) {
        if (this.client?.request(action, data)) {
            this.client.sortKey = Constants.CARD.SORT_OPTIONS[0];
            this.render(this.#room);
        }
    }

    /** @returns {boolean} Whether an action commits card order. */
    static #isCardMove(action) {
        return action === Constants.ACTIONS.DRAW ||
            action === Constants.ACTIONS.DISCARD ||
            action === Constants.ACTIONS.PASS;
    }

    /** Renders room metadata. */
    #renderRoomInformation(room) {
        DomUtils.require("#play-area", HTMLElement).dataset.status = room.status;
        DomUtils.require("#info-table-body", HTMLTableSectionElement)
            .replaceChildren(RoomRowUtils.create(room));
    }

    /** Renders all non-local players. */
    #renderPlayers(room) {
        const container = DomUtils.require("#opponent-list", HTMLElement);
        const localName = room.localPlayerName ?? null;
        container.replaceChildren();

        const players = PlayerDisplayUtils.localFirst(
            RoomController.#getPlayers(room),
            localName
        );

        for (const player of players) {
            if (player.name !== localName) {
                container.appendChild(OpponentUtils.create(player, room.circle));
            }
        }
    }

    /** Renders discard cards. */
    #renderDiscardPile(discardPile) {
        const cards = Array.isArray(discardPile) ? discardPile : [];
        const elements = [];

        for (const card of cards) {
            elements.push(PlayingCard.create(card, true));
        }

        DomUtils.require("#discard-pile", HTMLElement).replaceChildren(...elements);
    }

    /** Renders the local player's hand and controls. */
    #renderLocalPlayer(player, room) {
        if (player === null) {
            this.#playerController.hide();
            return;
        }

        this.#playerController.setCanRestartFinishedGame(this.#capabilities.restart === true);
        this.#playerController.show(player, room, this.client.sortKey);
        const idleWarning = document.querySelector("#player-idle-warning");

        if (idleWarning instanceof HTMLElement) {
            idleWarning.hidden = room.mode === "local";
        }
    }

    /** Shows actions supported by the current room host. */
    #renderGameActions(localPlayer) {
        DomUtils.require("#leave-button", HTMLButtonElement).hidden = false;
        DomUtils.require("#join-button", HTMLButtonElement).hidden =
            localPlayer !== null || this.#capabilities.join !== true;
        DomUtils.require("#invite-button", HTMLButtonElement).hidden =
            this.#capabilities.invite !== true;
    }

    /** Joins the viewed Room as a player. */
    #join() {
        const playerName = window.prompt("Enter your name:");

        if (playerName?.trim() && this.#room?.roomName) {
            this.client?.request(Constants.ACTIONS.JOIN, {
                roomName: this.#room.roomName,
                playerName
            });
        }
    }

    /** Copies a Network room link. */
    async #copyInvite() {
        if (!this.#room?.roomName) {
            return;
        }

        const base = new URL("../", location.href);
        const url = new URL("room.html", base);
        url.searchParams.set("mode", "network");
        url.searchParams.set("room", this.#room.roomName);

        try {
            await navigator.clipboard.writeText(url.href);
            this.handleNotification({status: Constants.STATUS.INFO, title: "Invite copied", message: "The room link is ready to share."});
        } catch (_error) {
            this.handleNotification({status: Constants.STATUS.ERROR, title: "Copy failed", message: "Copy the address from your browser instead."});
        }
    }

    /** @returns {Object[]} Players in the current Room. */
    static #getPlayers(room) {
        return Array.isArray(room?.circle?.players) ? room.circle.players : [];
    }

    /** @returns {Object|null} Local player. */
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
