"use strict";

import { CardCollection } from "../../core/CardCollection.js";
import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { CardListUtils } from "../utilities/CardListUtils.js";
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
     * @type {HTMLSpanElement} Required player identity and status output.
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

    // ---- Public API ----

    /**
     * Creates a player-area controller.
     *
     * @param {string} selector - Player-area selector.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(selector) {
        super(selector);
        this.#playerStatus = DomUtils.requireChild(this.root, "[data-player-name]", HTMLSpanElement);
        this.#playerCardCount = DomUtils.requireChild(this.root, "[data-item-count]", HTMLSpanElement);
        this.#handElement = DomUtils.requireChild(this.root, "#player-hand > .playing-card-area", HTMLSpanElement);
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
            const idleSeconds = Constants.ROOM_WAIT_MS / 1000;
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
        this.#renderRootState(player);
        this.#renderHeader(player);
        this.#renderControls(player, sortKey);
        this.#renderCards(player, room, sortKey);
    }

    /**
     * Clears and hides the player area.
     */
    hide() {
        this.#clear();
    }

    // ---- Implementation ----

    /**
     * Clears local-player UI state.
     */
    #clear() {
        this.root.dataset.playerState = Constants.PLAYER_STATE.READY;
        this.#playerStatus.dataset.playerName = "";
        this.#playerCardCount.dataset.itemCount = "0";
        this.#drawAllowanceOutput.dataset.drawAllowance = "0";
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
     * Renders turn ownership and final player state on the local-area root.
     * @param {Object} player - Local player snapshot.
     */
    #renderRootState(player) {
        this.root.dataset.playerState = player.state;
    }

    /**
     * Renders the canonical local player identity and item count.
     * @param {Object} player - Local player snapshot.
     */
    #renderHeader(player) {
        this.#playerStatus.dataset.playerName = player.name ?? "";
        this.#playerCardCount.dataset.itemCount = String(player.collection.items.length);
    }

    /**
     * Renders draw allowance and sort selection.
     * @param {Object} player - Local player snapshot.
     * @param {string} sortKey - Selected hand sort order.
     */
    #renderControls(player, sortKey) {
        this.#drawAllowanceOutput.dataset.drawAllowance = String(player.drawAllowance);
        this.#sortControl.value = sortKey;
    }

    /**
     * Renders the sorted local collection and enables dragging only when discarding is legal.
     * @param {Object} player - Local player snapshot.
     * @param {Object} room - Authoritative room snapshot.
     * @param {string} sortKey - Selected hand sort order.
     */
    #renderCards(player, room, sortKey) {
        const orderedCards = new CardCollection(player.collection.items).sorted(sortKey);
        const ownerKey = room.match.turnOrder?.ownerKey ?? null;
        const allowsFreeTransactions = room.match.state === Constants.ROOM_STATE.WAITING
            || (room.match.state === Constants.ROOM_STATE.FINISHED && !room.match.isKnockout);
        const canDiscard = room.match.pending === null && (allowsFreeTransactions
            || (room.match.state === Constants.ROOM_STATE.ACTIVE && (!ownerKey || ownerKey === player.key)));
        const destination = canDiscard ? DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement) : null;

        CardListUtils.update(this.#handElement, orderedCards.reverse(), destination);
    }
}
