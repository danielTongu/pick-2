"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { TurnUtils } from "../core/TurnUtils.js";
import { RoomRowUtils } from "../server/RoomRowUtils.js";
import { DomUtils } from "../ui/DomUtils.js";
import { GameEndController } from "../ui/GameEndController.js";
import { LocalPlayerController } from "../ui/LocalPlayerController.js";
import { OpponentUtils } from "../ui/OpponentUtils.js";
import { PlayingCard } from "../ui/PlayingCard.js";
import { SuitSelectionController } from "../ui/SuitSelectionController.js";
import { ViewController } from "../ui/ViewController.js";

/**
 * Controls the single static table and its four player positions.
 */
export class StaticRoomController extends ViewController {
    /** @type {Object|null} */
    #room = null;

    /** @type {LocalPlayerController} */
    #localPlayerController;

    /** @type {SuitSelectionController} */
    #suitSelectionController;

    /** @type {GameEndController} */
    #gameEndController;

    /**
     * Creates the table controller.
     *
     * @param {import("./LocalGameService.js").LocalGameService} client - Local game service.
     */
    constructor(client) {
        super("#room-view", client);
        this.#localPlayerController = new LocalPlayerController("#local-player-region");
        this.#suitSelectionController = new SuitSelectionController("#suit-selection-dialog");
        this.#gameEndController = new GameEndController("#game-end-dialog");
    }

    /**
     * Loads templates and binds table events.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        await Promise.all([
            OpponentUtils.load(),
            RoomRowUtils.load()
        ]);
        PlayingCard.setDiscardTarget("#discard-pile");
        this.#bindCardDropEvent();
        this.#initializeLocalPlayerController();
        this.#bindSuitSelectionOverlay();
    }

    /**
     * Stores and renders a room snapshot.
     *
     * @param {Object|null} room - Room payload.
     */
    render(room) {
        const localPlayer = StaticRoomController.#getLocalPlayer(room);

        this.#room = room;
        this.#suitSelectionController.hide();
        this.#renderRoomInformation(room);
        this.#renderOpponentPlayers(room);
        this.#renderDiscardPile(room?.discardPile);
        this.#renderLocalPlayer(localPlayer, room);
        this.#showSuitSelectionIfNeeded(room, localPlayer);
        this.#showGameEndIfNeeded(room, localPlayer);
    }

    /**
     * Initializes local-player controls.
     */
    #initializeLocalPlayerController() {
        this.#localPlayerController.initialize();

        this.#localPlayerController.setActionHandler(function (action) {
            if (StaticRoomController.#isCardMove(action)) {
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
     * Sends a card action and resets local sorting after acceptance.
     *
     * @param {string} action - Card action.
     * @param {Object} [payload={}] - Action data.
     */
    #sendCardMove(action, payload = {}) {
        if (this.connectionService.send(action, payload)) {
            this.connectionService.sortKey = Constants.CARD.SORT_OPTIONS[0];
        }
    }

    /**
     * Checks whether an action commits the local card ordering.
     *
     * @param {string} action - Action identifier.
     * @returns {boolean} True for draw, discard, or pass.
     */
    static #isCardMove(action) {
        return action === Constants.ACTIONS.DRAW_CARD ||
            action === Constants.ACTIONS.DISCARD_CARD ||
            action === Constants.ACTIONS.PASS_PLAYER;
    }

    /**
     * Binds suit-choice submissions.
     */
    #bindSuitSelectionOverlay() {
        this.#suitSelectionController.setSubmitHandler(function (suit) {
            this.connectionService.send(Constants.ACTIONS.SUIT_CHANGE, {
                suit: NormalizeUtils.requiredString(suit, "Suit")
            });
        }.bind(this));
    }

    /**
     * Binds dragged cards to discard actions.
     */
    #bindCardDropEvent() {
        const discardPile = DomUtils.require("#discard-pile", HTMLElement);

        discardPile.addEventListener("card_drop", function (event) {
            if (event instanceof CustomEvent && event.detail?.card) {
                this.#sendCardMove(Constants.ACTIONS.DISCARD_CARD, {
                    card: event.detail.card
                });
            }
        }.bind(this));
    }

    /**
     * Updates the static room metadata table and session status.
     *
     * @param {Object|null} room - Room payload.
     */
    #renderRoomInformation(room) {
        const session = DomUtils.require("#room-game-session", HTMLElement);
        const body = DomUtils.require("#room-info-table-body", HTMLTableSectionElement);
        const row = RoomRowUtils.create(room ?? {});

        session.dataset.roomStatus = NormalizeUtils.optionalString(room?.status, Constants.STATUS.WAITING);
        DomUtils.remove(DomUtils.requireChild(row, "[data-visitor-count]", HTMLTableCellElement));
        body.replaceChildren(row);
    }

    /**
     * Renders the three non-local player positions.
     *
     * @param {Object|null} room - Room payload.
     */
    #renderOpponentPlayers(room) {
        const row = DomUtils.require("#opponent-player-list", HTMLElement);
        const localPlayerName = StaticRoomController.#getLocalPlayerName(room);

        row.replaceChildren();

        for (const player of StaticRoomController.#getPlayers(room)) {
            if (player.name !== localPlayerName) {
                row.appendChild(OpponentUtils.create(player, room.circle));
            }
        }
    }

    /**
     * Renders the discard pile.
     *
     * @param {*} discardPile - Discard pile payload.
     */
    #renderDiscardPile(discardPile) {
        const pile = DomUtils.require("#discard-pile", HTMLElement);
        const cards = Array.isArray(discardPile) ? discardPile : [];

        pile.replaceChildren(...cards.map(function (card) {
            return PlayingCard.create(card);
        }));
    }

    /**
     * Renders or hides the local player position.
     *
     * @param {Object|null} player - Local player payload.
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
     * Shows suit selection when the human played a wild ace.
     *
     * @param {Object|null} room - Room payload.
     * @param {Object|null} localPlayer - Local player payload.
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
     * Shows final scores after the game ends.
     *
     * @param {Object|null} room - Room payload.
     * @param {Object|null} localPlayer - Local player payload.
     */
    #showGameEndIfNeeded(room, localPlayer) {
        if (localPlayer !== null && room?.status === Constants.STATUS.FINISHED) {
            this.#gameEndController.show(room);
        }
    }

    /** @returns {Object[]} Room player payloads. */
    static #getPlayers(room) {
        return Array.isArray(room?.circle?.players) ? room.circle.players : [];
    }

    /** @returns {string|null} Local player name. */
    static #getLocalPlayerName(room) {
        return room?.session?.playerName ?? null;
    }

    /** @returns {Object|null} Local player payload. */
    static #getLocalPlayer(room) {
        const playerName = StaticRoomController.#getLocalPlayerName(room);

        return StaticRoomController.#getPlayers(room).find(function (player) {
            return player.name === playerName;
        }) ?? null;
    }
}
