
"use strict";

import {Constants} from "../core/Constants.js";
import {NormalizeUtils} from "../core/NormalizeUtils.js";
import {TurnUtils} from "../core/TurnUtils.js";
import {CountdownController} from "../ui/CountdownController.js";
import {DomUtils} from "../ui/DomUtils.js";
import {GameEndController} from "../ui/GameEndController.js";
import {LocalPlayerController} from "../ui/LocalPlayerController.js";
import {OpponentUtils} from "../ui/OpponentUtils.js";
import {PlayingCard} from "../ui/PlayingCard.js";
import {SuitSelectionController} from "../ui/SuitSelectionController.js";
import {ViewController} from "../ui/ViewController.js";
import {RoomRowUtils} from "./RoomRowUtils.js";

/**
 * Controls the room view UI.
 */
export class ServerRoomController extends ViewController {
    /** @type {Object|null} */
    #room = null;

    /** @type {string} */
    #previousRoomStatus = "";

    /** @type {LocalPlayerController} */
    #localPlayerController;

    /** @type {SuitSelectionController} */
    #suitSelectionController;

    /** @type {CountdownController} */
    #countdownController;

    /** @type {GameEndController} */
    #gameEndController;

    /**
     * Creates a room view controller.
     *
     * @param {import("./ConnectionService.js").ConnectionService} client - Browser-tab client.
     */
    constructor(client) {
        super("#room-view", client);
        this.#localPlayerController = new LocalPlayerController("#local-player-region");
        this.#suitSelectionController = new SuitSelectionController("#suit-selection-dialog");
        this.#countdownController = new CountdownController("#countdown-dialog");
        this.#gameEndController = new GameEndController("#game-end-dialog");
    }

    /**
     * Initializes room dependencies and events.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        await Promise.all([
            RoomRowUtils.load(),
            OpponentUtils.load()
        ]);

        PlayingCard.setDiscardTarget("#discard-pile");

        this.#bindEvents();
        this.#bindCardDropEvent();
        this.#initializeLocalPlayerController();
        this.#bindSuitSelectionOverlay();
    }

    /**
     * Hides the room view.
     */
    hide() {
        super.hide();
        this.#hideTransientOverlays();
    }

    /**
     * Stores and renders room state.
     *
     * @param {Object|null} room - Room payload.
     */
    render(room) {
        const previousStatus = this.#previousRoomStatus;
        const nextStatus = NormalizeUtils.optionalString(room?.status, "");
        const localPlayer = ServerRoomController.#getLocalPlayer(room);

        this.#room = room;
        this.#previousRoomStatus = nextStatus;

        this.#hideTransientOverlays();
        this.#renderRoomInformation(room);
        this.#renderOpponentPlayers(room);
        this.#renderDiscardPile(room?.discardPile);
        this.#renderLocalPlayer(localPlayer, room);
        this.#showCountdownIfGameStarted(previousStatus, nextStatus, localPlayer);
        this.#showSuitSelectionIfNeeded(room, localPlayer);
        this.#showGameEndIfNeeded(room, localPlayer);
    }

    /**
     * Initializes the local-player controller and its callbacks.
     */
    #initializeLocalPlayerController() {
        this.#localPlayerController.initialize();

        this.#localPlayerController.setActionHandler(function (action) {
            if (ServerRoomController.#isCardMove(action)) {
                this.#sendCardMove(action);
            } else {
                this.connectionService.send(action);
            }
        }.bind(this));

        this.#localPlayerController.setSortHandler(function (sortKey) {
            this.connectionService.sortKey = NormalizeUtils.requiredString(sortKey, "Sort key");
            this.render(this.#room);
        }.bind(this));
    }

    /**
     * Sends a move with the selected sort key, then resets local sorting.
     *
     * @param {string} action - Card move action.
     * @param {Object} payload - Move payload.
     */
    #sendCardMove(action, payload = {}) {
        const sent = this.connectionService.send(action, payload);

        if (sent) {
            this.connectionService.sortKey = Constants.CARD.SORT_OPTIONS[0];
            this.render(this.#room);
        }
    }

    /**
     * Checks whether an action commits the locally selected card order.
     *
     * @param {string} action - Action.
     * @returns {boolean} True for draw, discard, or pass.
     */
    static #isCardMove(action) {
        return action === Constants.ACTIONS.DRAW_CARD ||
            action === Constants.ACTIONS.DISCARD_CARD ||
            action === Constants.ACTIONS.PASS_PLAYER;
    }

    /**
     * Binds suit-selection overlay callbacks.
     */
    #bindSuitSelectionOverlay() {
        this.#suitSelectionController.setSubmitHandler(function (suit) {
            this.connectionService.send(Constants.ACTIONS.SUIT_CHANGE, {
                suit: NormalizeUtils.requiredString(suit, "Suit")
            });
        }.bind(this));
    }

    /**
     * Binds one-time room UI events.
     */
    #bindEvents() {
        this.#bindHeaderButton("#evict-occupant-button", Constants.ACTIONS.EVICT_OCCUPANT);
        this.#bindHeaderButton("#promote-visitor-button", "promote");
        this.#bindHeaderButton("#copy-invite-button", "invite");
    }

    /**
     * Binds the discard-pile card-drop event.
     */
    #bindCardDropEvent() {
        const discardPile = DomUtils.require("#discard-pile", HTMLElement);

        discardPile.addEventListener("card_drop", function (event) {
            this.#submitCardDrop(event);
        }.bind(this));
    }

    /**
     * Binds a room header button to a server action or local command.
     *
     * @param {string} selector - Button selector.
     * @param {string} action - Server action or local command.
     */
    #bindHeaderButton(selector, action) {
        const button = DomUtils.require(selector, HTMLButtonElement);

        button.addEventListener("click", function (event) {
            event.preventDefault();
            this.#handleHeaderAction(action);
        }.bind(this));
    }

    /**
     * Handles one room header action.
     *
     * @param {string} action - Server action or local command.
     */
    #handleHeaderAction(action) {
        if (action === "promote") {
            this.#promoteCurrentVisitor();
        } else if (action === "invite") {
            this.#copyRoomInvite();
        } else {
            this.connectionService.send(action);
        }
    }

    /**
     * Submits a discarded card drop to the server.
     *
     * @param {Event} event - Card event.
     */
    #submitCardDrop(event) {
        if (event instanceof CustomEvent && event.detail?.card) {
            this.#sendCardMove(Constants.ACTIONS.DISCARD_CARD, {
                card: event.detail.card
            });
        }
    }

    /**
     * Hides overlays that should not persist across renders.
     */
    #hideTransientOverlays() {
        this.#suitSelectionController.hide();
    }

    /**
     * Renders room metadata table and session status.
     *
     * @param {Object|null} room - Room payload.
     */
    #renderRoomInformation(room) {
        const body = DomUtils.require("#room-info-table-body", HTMLTableSectionElement);
        const session = DomUtils.require("#room-game-session", HTMLElement);

        session.dataset.roomStatus = NormalizeUtils.optionalString(room?.status, "");
        body.replaceChildren(RoomRowUtils.create(room));
    }

    /**
     * Renders opponent player cards.
     *
     * @param {Object|null} room - Room payload.
     */
    #renderOpponentPlayers(room) {
        const row = DomUtils.require("#opponent-player-list", HTMLElement);
        const localPlayerName = ServerRoomController.#getLocalPlayerName(room);

        row.replaceChildren();

        for (const player of ServerRoomController.#getPlayers(room)) {
            if (player.name !== localPlayerName) {
                row.appendChild(OpponentUtils.create(player, room.circle));
            }
        }
    }

    /**
     * Renders discard pile cards.
     *
     * @param {*} discardPile - Discard pile payload.
     */
    #renderDiscardPile(discardPile) {
        const pile = DomUtils.require("#discard-pile", HTMLElement);
        const cards = Array.isArray(discardPile) ? discardPile : [];

        pile.replaceChildren();

        for (const card of cards) {
            pile.appendChild(PlayingCard.create(card));
        }
    }

    /**
     * Renders the local player region.
     *
     * @param {Object|null} player - Local player payload, or null for a visitor.
     * @param {Object|null} room - Room payload.
     */
    #renderLocalPlayer(player, room) {
        if (player === null) {
            this.#localPlayerController.hide();
        } else {
            this.#localPlayerController.show(player, room, this.connectionService.sortKey);
        }
    }

    /**
     * Shows countdown when a waiting room enters playing state.
     *
     * @param {string} previousStatus - Previous room status.
     * @param {string} nextStatus - Next room status.
     * @param {Object|null} localPlayer - Local player payload, or null for a visitor.
     */
    #showCountdownIfGameStarted(previousStatus, nextStatus, localPlayer) {
        if (
            localPlayer !== null &&
            previousStatus === Constants.STATUS.WAITING &&
            nextStatus === Constants.STATUS.PLAYING
        ) {
            this.#countdownController.show(5);
        }
    }

    /**
     * Shows suit selection when the local player must choose suit.
     *
     * @param {Object|null} room - Room payload.
     * @param {Object|null} localPlayer - Local player payload, or null for a visitor.
     */
    #showSuitSelectionIfNeeded(room, localPlayer) {
        if (
            room?.status === Constants.STATUS.PENDING &&
            localPlayer !== null &&
            TurnUtils.isTurnOwner(room.circle?.turnOwnerKey, localPlayer.key)
        ) {
            this.#suitSelectionController.show();
        }
    }

    /**
     * Shows game-end overlay when the room is finished.
     *
     * @param {Object|null} room - Room payload.
     * @param {Object|null} localPlayer - Local player payload, or null for a visitor.
     */
    #showGameEndIfNeeded(room, localPlayer) {
        if (localPlayer !== null && room?.status === Constants.STATUS.FINISHED) {
            this.#gameEndController.show(room);
        }
    }

    /**
     * Prompts a visitor for the player name used during promotion.
     */
    #promoteCurrentVisitor() {
        const roomName = NormalizeUtils.optionalString(this.#room?.name, "");
        const playerName = window.prompt("Enter your name:");

        if (roomName && playerName !== null && playerName.trim()) {
            this.connectionService.send(Constants.ACTIONS.PROMOTE_VISITOR, {
                roomName,
                playerName: NormalizeUtils.requiredString(playerName, "Player name")
            });
        }
    }

    /**
     * Copies a room invite link to the clipboard.
     */
    #copyRoomInvite() {
        const roomName = NormalizeUtils.optionalString(this.#room?.name, "");

        if (roomName) {
            const url = `${location.origin}?room=${encodeURIComponent(roomName)}`;

            navigator.clipboard.writeText(url)
                .then(function () {
                    this.connectionService.showAlert({
                        status: Constants.STATUS.INFO,
                        title: "Invite Copied",
                        message: "The room link is ready to share."
                    });
                }.bind(this))
                .catch(function () {
                    this.connectionService.showAlert({
                        status: Constants.STATUS.ERROR,
                        title: "Copy Failed",
                        message: "Copy the address from your browser instead."
                    });
                }.bind(this));
        }
    }

    /**
     * Gets room players.
     *
     * @param {Object|null} room - Room payload.
     * @returns {Object[]} Player payloads.
     */
    static #getPlayers(room) {
        return Array.isArray(room?.circle?.players) ? room.circle.players : [];
    }

    /**
     * Gets local player name.
     *
     * @param {Object|null} room - Room payload.
     * @returns {string|null} Local player name, or null for a visitor.
     */
    static #getLocalPlayerName(room) {
        return room.session.playerName;
    }

    /**
     * Gets local player payload.
     *
     * @param {Object|null} room - Room payload.
     * @returns {Object|null} Local player payload.
     */
    static #getLocalPlayer(room) {
        const playerName = ServerRoomController.#getLocalPlayerName(room);
        let localPlayer = null;

        for (const player of ServerRoomController.#getPlayers(room)) {
            if (player.name === playerName) {
                localPlayer = player;
                break;
            }
        }

        return localPlayer;
    }
}
