"use strict";

import { CardCollection } from "../../core/CardCollection.js";
import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { PlayingCard } from "../PlayingCard.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the local-player area within the shared Room play area.
 */
export class LocalPlayerController extends ViewController {
    /**
     * @type {Function|null} Optional application callback registered by the owning page.
     */
    #commandHandler = null;

    /**
     * @type {Function|null} Optional application callback registered by the owning page.
     */
    #sortHandler = null;

    /**
     * @type {HTMLElement} Required UI element owned by this controller.
     */
    #gameRegion;

    /**
     * @type {HTMLSpanElement} Required actor identity and status output.
     */
    #playerStatus;

    /**
     * @type {HTMLSpanElement} Required text output synchronized during rendering.
     */
    #playerCardCount;

    /**
     * @type {HTMLSpanElement} Card-hand container and drop target.
     */
    #handElement;

    /**
     * @type {HTMLButtonElement} Required command control owned by this controller.
     */
    #drawButton;

    /**
     * @type {HTMLSpanElement} Required text output synchronized during rendering.
     */
    #drawAllowanceOutput;

    /**
     * @type {HTMLSelectElement} Required selection control owned by this controller.
     */
    #sortControl;

    /**
     * @type {HTMLElement|null} Optional UI output present only in supported room modes.
     */
    #idleSecondsOutput = null;

    /**
     * @type {HTMLButtonElement} Required command control owned by this controller.
     */
    #playButton;

    /**
     * @type {HTMLButtonElement} Required command control owned by this controller.
     */
    #passButton;

    /**
     * @type {boolean} Current controller capability or lifecycle flag.
     */
    #canRestartFinishedGame;

    /**
     * Creates a player-area controller.
     *
     * @param {string} selector - Player-area selector.
     * @param {boolean} canRestartFinishedGame - Whether Play is available after a finished round.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(selector, canRestartFinishedGame) {
        super(selector);
        this.#canRestartFinishedGame = canRestartFinishedGame === true;
        const gameRegion = this.root.closest(':is([data-game-region="act"], [data-game-region="view"])');

        if (!(gameRegion instanceof HTMLElement)) {
            throw new Error("Player area must belong to the room play area.");
        }

        this.#gameRegion = gameRegion;
        this.#playerStatus = DomUtils.requireChild(this.root, "[data-actor-name]", HTMLSpanElement);
        this.#playerCardCount = DomUtils.requireChild(this.root, "[data-item-count]", HTMLSpanElement);
        this.#handElement = DomUtils.requireChild(this.root, "#player-hand > [data-is-drag-over]", HTMLSpanElement);
        this.#drawButton = DomUtils.requireChild(this.root, "#draw-button", HTMLButtonElement);
        this.#drawAllowanceOutput = DomUtils.requireChild(this.root, "[data-draw-allowance]", HTMLSpanElement);
        const idleSecondsOutput = this.root.querySelector("[data-idle-seconds]");

        if (idleSecondsOutput instanceof HTMLElement) {
            this.#idleSecondsOutput = idleSecondsOutput;
        }

        this.#sortControl = DomUtils.requireChild(this.root, "#sort-key-select", HTMLSelectElement);
        this.#playButton = DomUtils.requireChild(this.root, "#room-play-button", HTMLButtonElement);
        this.#passButton = DomUtils.requireChild(this.root, "#turn-pass-button", HTMLButtonElement);

        if (this.#idleSecondsOutput !== null) {
            const idleSeconds = Constants.MAX_IDLE_MS / 1000;
            this.#idleSecondsOutput.dataset.idleSeconds = String(idleSeconds);
        }
    }

    /**
     * Sets the callback invoked for local-player commands.
     *
     * @param {Function} handler - Command callback.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    setCommandHandler(handler) {
        if (typeof handler !== "function") {
            throw new Error("Local player command handler must be a function.");
        }

        this.#commandHandler = handler;
    }

    /**
     * Sets the callback invoked when the sort key changes.
     *
     * @param {Function} handler - Sort callback.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    setSortHandler(handler) {
        if (typeof handler !== "function") {
            throw new Error("Local player sort handler must be a function.");
        }

        this.#sortHandler = handler;
    }

    /**
     * Controls whether a finished Local room can restart.
     *
     * @param {boolean} value - Restart capability.
     */
    setCanRestartFinishedGame(value) {
        this.#canRestartFinishedGame = value === true;
    }

    /**
     * Initializes local-player event bindings.
     */
    initialize() {
        this.#bindCommandButton(this.#drawButton, Constants.COMMANDS.DRAW);
        this.#bindCommandButton(this.#passButton, Constants.COMMANDS.PASS);
        this.#bindCommandButton(this.#playButton, Constants.COMMANDS.START);

        this.#sortControl.addEventListener(
            "change",
            function () {
                this.#submitSortChange();
            }.bind(this)
        );
    }

    /**
     * Shows and updates the player area.
     *
     * @param {Object} player - Player data.
     * @param {Object} room - Room data.
     * @param {string} sortKey - Selected sort key.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    show(player, room, sortKey) {
        this.#gameRegion.dataset.gameRegion = "act";
        this.#renderRootState(player, room);
        this.#renderHeader(player);
        this.#renderControls(player, room, sortKey);
        this.#renderCards(player, room, sortKey);
    }

    /**
     * Clears and hides the player area.
     */
    hide() {
        this.#clear();
        this.#gameRegion.dataset.gameRegion = "view";
    }

    /**
     * Clears local-player UI state.
     */
    #clear() {
        this.root.dataset.isTurnOwner = "false";
        this.root.dataset.isWinner = "false";
        this.#playerStatus.dataset.actorName = "";
        this.#playerCardCount.dataset.itemCount = "0";
        this.#drawAllowanceOutput.dataset.drawAllowance = "0";
        this.#drawButton.disabled = true;
        this.#handElement.replaceChildren();
    }

    /**
     * Binds one button to one local-player command.
     *
     * @param {HTMLButtonElement} button - Button element.
     * @param {string} command - Room command.
     */
    #bindCommandButton(button, command) {
        button.addEventListener(
            "click",
            function (event) {
                event.preventDefault();
                this.#submitCommand(command);
            }.bind(this)
        );
    }

    /**
     * Submits a local-player command.
     *
     * @param {string} command - Room command.
     */
    #submitCommand(command) {
        if (this.#commandHandler !== null) {
            this.#commandHandler(command);
        }
    }

    /**
     * Submits the selected sort key.
     */
    #submitSortChange() {
        if (this.#sortHandler !== null) {
            this.#sortHandler(this.#sortControl.value);
        }
    }

    /**
     * Renders turn ownership and final actor state on the local-area root.
     * @param {Object} actor - Local actor snapshot.
     * @param {Object} room - Authoritative room snapshot.
     */
    #renderRootState(actor, room) {
        DomUtils.setBooleanState(this.root, "isTurnOwner", room.turnOrder?.ownerKey === actor.key);
        DomUtils.setBooleanState(this.root, "isWinner", actor.state === Constants.ACTOR_STATE.WON);
    }

    /**
     * Renders the canonical local actor identity and item count.
     * @param {Object} actor - Local actor snapshot.
     */
    #renderHeader(actor) {
        this.#playerStatus.dataset.actorName = actor.name ?? "";
        this.#playerCardCount.dataset.itemCount = String(actor.collection.items.length);
    }

    /**
     * Enables controls from canonical actor ownership and Room lifecycle state.
     * @param {Object} actor - Local actor snapshot.
     * @param {Object} room - Authoritative room snapshot.
     * @param {string} sortKey - Selected hand sort order.
     */
    #renderControls(actor, room, sortKey) {
        this.#drawAllowanceOutput.dataset.drawAllowance = String(actor.drawAllowance);
        this.#drawButton.disabled = !LocalPlayerController.#isDrawButtonUsable(actor, room);
        this.#sortControl.value = sortKey;
        this.#sortControl.disabled = false;
        const canStartGame =
            room.state === Constants.ROOM_STATE.WAITING ||
            (this.#canRestartFinishedGame && room.state === Constants.ROOM_STATE.FINISHED);

        this.#playButton.disabled = room.pending !== null || !canStartGame;
        this.#passButton.disabled =
            room.pending !== null ||
            room.state !== Constants.ROOM_STATE.ACTIVE ||
            room.turnOrder?.ownerKey !== actor.key;
    }

    /**
     * Renders the sorted local collection and enables dragging only when discarding is legal.
     * @param {Object} actor - Local actor snapshot.
     * @param {Object} room - Authoritative room snapshot.
     * @param {string} sortKey - Selected hand sort order.
     */
    #renderCards(actor, room, sortKey) {
        this.#handElement.replaceChildren();
        const orderedCards = new CardCollection(actor.collection.items).sorted(sortKey);
        const ownerKey = room.turnOrder?.ownerKey ?? null;
        const allowsFreeTransactions =
            room.state === Constants.ROOM_STATE.WAITING || room.state === Constants.ROOM_STATE.FINISHED;
        const canDiscard =
            room.pending === null &&
            (allowsFreeTransactions ||
                (room.state === Constants.ROOM_STATE.ACTIVE &&
                    (!ownerKey || ownerKey === actor.key)));
        const destination = canDiscard ? DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement) : null;

        for (let index = orderedCards.length - 1; index >= 0; index -= 1) {
            this.#handElement.appendChild(PlayingCard.create(orderedCards[index], destination));
        }
    }

    /**
     * Returns whether the local actor may draw in the authoritative Room state.
     * @param {Object} actor - Local actor snapshot.
     * @param {Object} room - Authoritative room snapshot.
     * @returns {boolean} Whether drawing is enabled.
     */
    static #isDrawButtonUsable(actor, room) {
        if (room.pending !== null) {
            return false;
        }

        if (room.state === Constants.ROOM_STATE.WAITING || room.state === Constants.ROOM_STATE.FINISHED) {
            return true;
        }

        let isDrawAllowed = room.state === Constants.ROOM_STATE.ACTIVE && actor.drawAllowance > 0;

        if (room.state === Constants.ROOM_STATE.ACTIVE) {
            const ownerKey = room.turnOrder?.ownerKey ?? null;
            isDrawAllowed = !ownerKey || (isDrawAllowed && ownerKey === actor.key);
        }

        return isDrawAllowed;
    }
}
