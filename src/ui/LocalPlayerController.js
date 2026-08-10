
"use strict";

import { CardSortUtils } from "../core/CardSortUtils.js";
import { Constants } from "../core/Constants.js";
import { TurnUtils } from "../core/TurnUtils.js";
import { DomUtils } from "./DomUtils.js";
import { PlayingCard } from "./PlayingCard.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton local-player region already present in the page HTML.
 */
export class LocalPlayerController extends ViewController {
    /** @type {Function|null} */
    #actionHandler = null;

    /** @type {Function|null} */
    #sortHandler = null;

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

    /** @type {HTMLButtonElement} */
    #sortButton;

    /** @type {HTMLElement|null} */
    #idleSecondsOutput = null;

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
        super(selector);
        this.#playerHeader = DomUtils.requireChild(this.root, "header", HTMLElement);
        this.#handElement = DomUtils.requireChild(this.root, "#local-player-hand", HTMLDivElement);
        this.#drawButton = DomUtils.requireChild(this.root, "#draw-card-button", HTMLButtonElement);
        this.#drawAllowanceOutput = DomUtils.requireChild(this.root, "#draw-card-button > span", HTMLSpanElement);
        const idleSecondsOutput = this.root.querySelector("#local-player-idle-warning > em");

        if (idleSecondsOutput instanceof HTMLElement) {
            this.#idleSecondsOutput = idleSecondsOutput;
        }
        this.#sortButton = DomUtils.requireChild(this.root, "#card-sort-control-button", HTMLButtonElement);
        this.#sortControl = DomUtils.requireChild(this.#sortButton, "#card-sort-key-select", HTMLSelectElement);
        this.#startButton = DomUtils.requireChild(this.root, "#start-game-button", HTMLButtonElement);
        this.#passButton = DomUtils.requireChild(this.root, "#pass-turn-button", HTMLButtonElement);

        if (this.#idleSecondsOutput !== null) {
            const idleSeconds = Constants.MAX_IDLE_MS / 1000;
            this.#idleSecondsOutput.dataset.idleSeconds = String(idleSeconds);
        }
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

        this.#sortButton.addEventListener("click", function (event) {
            if (event.target === this.#sortControl || this.#sortControl.disabled) {
                return;
            }

            event.preventDefault();

            if (typeof this.#sortControl.showPicker === "function") {
                this.#sortControl.showPicker();
            } else {
                this.#sortControl.focus();
                this.#sortControl.click();
            }
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
            status: room.status,
            turnOwnerKey: room.circle?.turnOwnerKey ?? null,
            isBusy: room.isBusy === true
        };

        super.show();

        this.#renderRootState(data);
        this.#renderHeader(data);
        this.#renderControls(data, sortKey);
        this.#renderCards(data.hand.cards, sortKey);
    }

    /**
     * Clears and hides the local-player region.
     */
    hide() {
        this.#clear();
        super.hide();
    }

    /**
     * Clears local-player UI state.
     */
    #clear() {
        this.root.dataset.status = Constants.STATUS.WAITING;
        this.root.dataset.isTurnOwner = "false";
        this.root.dataset.isWinner = "false";
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
        this.root.dataset.status = data.status;

        DomUtils.setBooleanState(
            this.root,
            "isTurnOwner",
            TurnUtils.isTurnOwner(data.turnOwnerKey, data.key)
        );
        DomUtils.setBooleanState(this.root, "isWinner", data.isWinner);
    }

    /**
     * Renders local-player header state.
     *
     * @param {Object} data - Normalized player state.
     */
    #renderHeader(data) {
        this.#playerHeader.dataset.cardCount = String(data.hand.cards.length);
    }

    /**
     * Renders local-player controls.
     *
     * @param {Object} data - Normalized player state.
     * @param {string} sortKey - Selected sort key.
     */
    #renderControls(data, sortKey) {
        this.#drawAllowanceOutput.dataset.drawAllowance = String(data.drawAllowance);
        this.#drawButton.disabled = !LocalPlayerController.#isDrawButtonUsable(data);
        this.#sortControl.value = sortKey;
        this.#sortControl.disabled = data.isBusy;
        this.#startButton.disabled = data.isBusy || data.status !== Constants.STATUS.WAITING;
        this.#passButton.disabled = data.isBusy ||
            data.status !== Constants.STATUS.PLAYING ||
            !TurnUtils.isTurnOwner(data.turnOwnerKey, data.key);
    }

    /**
     * Renders local-player hand cards.
     *
     * @param {Object[]} cards - Card payloads.
     * @param {string} sortKey - Current local sort key.
     */
    #renderCards(cards, sortKey) {
        this.#handElement.replaceChildren(this.#drawButton);
        const orderedCards = CardSortUtils.sorted(cards, sortKey);

        // The server appends drawn cards to the hand, so render from the end
        // without mutating the payload to keep the newest cards first.
        for (let index = orderedCards.length - 1; index >= 0; index -= 1) {
            const card = orderedCards[index];

            this.#handElement.appendChild(PlayingCard.create(card));
        }
    }

    /**
     * Checks whether the draw button should be enabled.
     *
     * @param {{key:string,status:string,drawAllowance:number,turnOwnerKey:string|null}} player - Player state.
     * @returns {boolean} True when draw button should be enabled.
     */
    static #isDrawButtonUsable(player) {
        let isDrawAllowed = !player.isBusy && player.drawAllowance > 0;

        if (player.status === Constants.STATUS.PLAYING) {
            isDrawAllowed = !TurnUtils.hasTurnOwner(player.turnOwnerKey) ||
                (isDrawAllowed && TurnUtils.isTurnOwner(player.turnOwnerKey, player.key));
        }

        if (player.status === Constants.STATUS.PENDING) {
            isDrawAllowed = false;
        }

        return isDrawAllowed;
    }
}
