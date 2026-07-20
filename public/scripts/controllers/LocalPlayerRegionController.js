// public/scripts/LocalPlayerRegionController.js

"use strict";

import { Constants } from "../Constants.js";
import { PlayingCardUtils } from "../utils/PlayingCardUtils.js";
import { DomUtils } from "../utils/DomUtils.js";
import { CardSortUtils } from "../utils/CardSortUtils.js";

/**
 * Controls the singleton local-player region already present in the page HTML.
 */
export class LocalPlayerRegionController {
    /** @type {Function|null} */
    #actionHandler = null;

    /** @type {Function|null} */
    #sortHandler = null;

    /** @type {HTMLElement} */
    #region;

    /** @type {HTMLElement} */
    #playerHeader;

    /** @type {HTMLDivElement} */
    #handElement;

    /** @type {HTMLButtonElement} */
    #drawButton;

    /** @type {HTMLSpanElement} */
    #drawAllowanceOutput;

    /** @type {HTMLSelectElement} */
    #sortControl;

    /** @type {HTMLElement} */
    #idleSecondsOutput;

    /** @type {HTMLButtonElement} */
    #startButton;

    /** @type {HTMLButtonElement} */
    #passButton;

    /**
     * Creates a local-player region controller.
     *
     * @param {string} selector - Local-player region selector.
     * @throws {Error}
     */
    constructor(selector) {
        this.#region = DomUtils.require(selector, HTMLElement);
        this.#playerHeader = DomUtils.requireChild(this.#region, "header", HTMLElement);
        this.#handElement = DomUtils.requireChild(this.#region, "#local-player-hand", HTMLDivElement);
        this.#drawButton = DomUtils.requireChild(this.#region, "#draw-card-button", HTMLButtonElement);
        this.#drawAllowanceOutput = DomUtils.requireChild(this.#region, "#draw-card-button > span", HTMLSpanElement);
        this.#idleSecondsOutput = DomUtils.requireChild(this.#region, "#local-player-idle-warning > em", HTMLElement);
        this.#sortControl = DomUtils.requireChild(this.#region, "#card-sort-key-select", HTMLSelectElement);
        this.#startButton = DomUtils.requireChild(this.#region, "#start-game-button", HTMLButtonElement);
        this.#passButton = DomUtils.requireChild(this.#region, "#pass-turn-button", HTMLButtonElement);

        const idleSeconds = Constants.MAX_IDLE_MS / 1000;
        this.#idleSecondsOutput.dataset.idleSeconds = String(idleSeconds);
    }

    /**
     * Sets the callback invoked for local-player actions.
     *
     * @param {Function} handler - Action callback.
     * @throws {Error}
     */
    setActionHandler(handler) {
        if (typeof handler !== "function") {
            throw new Error("Local player action handler must be a function.");
        }

        this.#actionHandler = handler;
    }

    /**
     * Sets the callback invoked when the sort key changes.
     *
     * @param {Function} handler - Sort callback.
     * @throws {Error}
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
        this.#bindActionButton(this.#drawButton, Constants.ACTIONS.DRAW_CARD);
        this.#bindActionButton(this.#passButton, Constants.ACTIONS.PASS_PLAYER);
        this.#bindActionButton(this.#startButton, Constants.ACTIONS.START_GAME);

        this.#sortControl.addEventListener("change", function () {
            this.#submitSortChange();
        }.bind(this));
    }

    /**
     * Shows and updates the local-player region.
     *
     * @param {Object} player - Player payload.
     * @param {Object} room - Room payload.
     * @param {string} sortKey - Selected sort key.
     * @throws {Error}
     */
    show(player, room, sortKey) {
        const data = {
            ...player,
            status: room.status
        };

        DomUtils.show(this.#region);

        this.#renderRootState(data);
        this.#renderHeader(data);
        this.#renderControls(data, sortKey);
        this.#renderCards(data.cards, LocalPlayerRegionController.#isCardDiscardAllowed(data), sortKey);
    }

    /**
     * Clears and hides the local-player region.
     */
    hide() {
        this.#clear();
        DomUtils.hide(this.#region);
    }

    /**
     * Clears local-player UI state.
     */
    #clear() {
        this.#region.dataset.status = Constants.STATUS.WAITING;
        this.#region.dataset.isActive = "false";
        this.#region.dataset.isWinner = "false";
        this.#playerHeader.dataset.cardCount = "0";
        this.#drawAllowanceOutput.dataset.drawAllowance = "0";
        this.#drawButton.disabled = true;
        this.#handElement.replaceChildren(this.#drawButton);
    }

    /**
     * Binds one button to one local-player action.
     *
     * @param {HTMLButtonElement} button - Button element.
     * @param {string} action - Server action.
     */
    #bindActionButton(button, action) {
        button.addEventListener("click", function (event) {
            event.preventDefault();
            this.#submitAction(action);
        }.bind(this));
    }

    /**
     * Submits a local-player action.
     *
     * @param {string} action - Server action.
     */
    #submitAction(action) {
        if (this.#actionHandler !== null) {
            this.#actionHandler(action);
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
     * Renders root datasets.
     *
     * @param {Object} data - Normalized player state.
     */
    #renderRootState(data) {
        this.#region.dataset.status = data.status;

        DomUtils.setBooleanState(this.#region, "isActive", data.isActive);
        DomUtils.setBooleanState(this.#region, "isWinner", data.isWinner);
    }

    /**
     * Renders local-player header state.
     *
     * @param {Object} data - Normalized player state.
     */
    #renderHeader(data) {
        this.#playerHeader.dataset.cardCount = String(data.cardCount);
    }

    /**
     * Renders local-player controls.
     *
     * @param {Object} data - Normalized player state.
     * @param {string} sortKey - Selected sort key.
     */
    #renderControls(data, sortKey) {
        this.#drawAllowanceOutput.dataset.drawAllowance = String(data.drawAllowance);
        this.#drawButton.disabled = !LocalPlayerRegionController.#isDrawButtonUsable(data);
        this.#sortControl.value = sortKey;
    }

    /**
     * Renders local-player hand cards.
     *
     * @param {Object[]} cards - Card payloads.
     * @param {boolean} isCardDiscardAllowed - Whether cards may be discarded.
     * @param {string} sortKey - Current local sort key.
     */
    #renderCards(cards, isCardDiscardAllowed, sortKey) {
        this.#handElement.replaceChildren(this.#drawButton);
        const orderedCards = CardSortUtils.sorted(cards, sortKey);

        // The server appends drawn cards to the hand, so render from the end
        // without mutating the payload to keep the newest cards first.
        for (let index = orderedCards.length - 1; index >= 0; index -= 1) {
            const card = orderedCards[index];

            this.#handElement.appendChild(PlayingCardUtils.create({
                ...card,
                isDiscardable: isCardDiscardAllowed
            }));
        }
    }

    /**
     * Checks whether the draw button should be enabled.
     *
     * @param {{status:string,drawAllowance:number,isActive:boolean}} player - Player state.
     * @returns {boolean} True when draw button should be enabled.
     */
    static #isDrawButtonUsable(player) {
        let isDrawAllowed = player.drawAllowance > 0;

        if (player.status === Constants.STATUS.PLAYING) {
            isDrawAllowed = isDrawAllowed && player.isActive;
        }

        if (player.status === Constants.STATUS.PENDING) {
            isDrawAllowed = false;
        }

        return isDrawAllowed;
    }

    /**
     * Checks whether cards may be discarded.
     *
     * @param {{status:string,isActive:boolean}} player - Player state.
     * @returns {boolean} True when cards may be discarded.
     */
    static #isCardDiscardAllowed(player) {
        let isDiscardAllowed = true;

        if (player.status === Constants.STATUS.PLAYING) {
            isDiscardAllowed = player.isActive;
        }

        if (player.status === Constants.STATUS.PENDING) {
            isDiscardAllowed = false;
        }

        return isDiscardAllowed;
    }

}
