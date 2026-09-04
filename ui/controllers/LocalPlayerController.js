
"use strict";

import { CardSortUtils } from "../../core/CardSortUtils.js";
import { Constants } from "../../core/Constants.js";
import { TurnUtils } from "../../core/TurnUtils.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { PlayingCard } from "../PlayingCard.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the local-player area within the shared Room play area.
 */
export class LocalPlayerController extends ViewController {
    /** @type {Function|null} */
    #actionHandler = null;

    /** @type {Function|null} */
    #sortHandler = null;

    /** @type {HTMLElement} */
    #playArea;

    /** @type {HTMLSpanElement} */
    #playerCardCount;

    /** @type {HTMLDivElement} */
    #handElement;

    /** @type {HTMLButtonElement} */
    #drawButton;

    /** @type {HTMLSpanElement} */
    #drawAllowanceOutput;

    /** @type {HTMLSelectElement} */
    #sortControl;

    /** @type {HTMLElement|null} */
    #idleSecondsOutput = null;

    /** @type {HTMLButtonElement} */
    #playButton;

    /** @type {HTMLButtonElement} */
    #passButton;

    /** @type {boolean} */
    #canRestartFinishedGame;

    /**
     * Creates a player-area controller.
     *
     * @param {string} selector - Player-area selector.
     * @param {boolean} canRestartFinishedGame - Whether Play is available after a finished round.
     * @throws {Error}
     */
    constructor(selector, canRestartFinishedGame) {
        super(selector);
        this.#canRestartFinishedGame = canRestartFinishedGame === true;
        const playArea = this.root.closest("#play-area");

        if (!(playArea instanceof HTMLElement)) {
            throw new Error("Player area must belong to the room play area.");
        }

        this.#playArea = playArea;
        const playerSummary = DomUtils.requireChild(this.root, "#player-summary", HTMLElement);
        this.#playerCardCount = DomUtils.requireChild(playerSummary, "[data-card-count]", HTMLSpanElement);
        this.#handElement = DomUtils.requireChild(this.root, "#player-hand", HTMLDivElement);
        this.#drawButton = DomUtils.requireChild(this.root, "#card-draw-button", HTMLButtonElement);
        this.#drawAllowanceOutput = DomUtils.requireChild(this.root, "#card-draw-button > span", HTMLSpanElement);
        const idleSecondsOutput = this.root.querySelector("#player-idle-warning > em");

        if (idleSecondsOutput instanceof HTMLElement) {
            this.#idleSecondsOutput = idleSecondsOutput;
        }
        this.#sortControl = DomUtils.requireChild(this.root, "#card-sort-key-select", HTMLSelectElement);
        this.#playButton = DomUtils.requireChild(this.root, "#play-button", HTMLButtonElement);
        this.#passButton = DomUtils.requireChild(this.root, "#turn-pass-button", HTMLButtonElement);

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
        this.#bindActionButton(this.#drawButton, Constants.ACTIONS.DRAW);
        this.#bindActionButton(this.#passButton, Constants.ACTIONS.PASS);
        this.#bindActionButton(this.#playButton, Constants.ACTIONS.START);

        this.#sortControl.addEventListener("change", function () {
            this.#submitSortChange();
        }.bind(this));
    }

    /**
     * Shows and updates the player area.
     *
     * @param {Object} player - Player data.
     * @param {Object} room - Room data.
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

        DomUtils.setBooleanState(this.#playArea, "isPlayerView", true);
        this.#renderRootState(data);
        this.#renderHeader(data);
        this.#renderControls(data, sortKey);
        this.#renderCards(data.hand.cards, sortKey);
    }

    /**
     * Clears and hides the player area.
     */
    hide() {
        this.#clear();
        DomUtils.setBooleanState(this.#playArea, "isPlayerView", false);
    }

    /**
     * Clears local-player UI state.
     */
    #clear() {
        this.root.dataset.isTurnOwner = "false";
        this.root.dataset.isWinner = "false";
        this.#playerCardCount.dataset.cardCount = "0";
        this.#drawAllowanceOutput.dataset.drawAllowance = "0";
        this.#drawButton.disabled = true;
        this.#handElement.replaceChildren(this.#drawButton);
    }

    /**
     * Binds one button to one local-player action.
     *
     * @param {HTMLButtonElement} button - Button element.
     * @param {string} action - Room action.
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
     * @param {string} action - Room action.
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
        DomUtils.setBooleanState(
            this.root,
            "isTurnOwner",
            TurnUtils.isTurnOwner(data.turnOwnerKey, data.key)
        );
        DomUtils.setBooleanState(this.root, "isWinner", data.isWinner);
    }

    /**
     * Renders local-player summary state.
     *
     * @param {Object} data - Normalized player state.
     */
    #renderHeader(data) {
        const cardCount = data.hand.cards.length;
        this.#playerCardCount.dataset.cardCount = String(cardCount);
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
        this.#sortControl.disabled = false;
        const canStartGame = data.status === Constants.STATUS.WAITING ||
            (this.#canRestartFinishedGame && data.status === Constants.STATUS.FINISHED);

        this.#playButton.disabled = data.isBusy || !canStartGame;
        this.#passButton.disabled = data.isBusy ||
            data.status !== Constants.STATUS.PLAYING ||
            !TurnUtils.isTurnOwner(data.turnOwnerKey, data.key);
    }

    /**
     * Renders local-player hand cards.
     *
     * @param {Object[]} cards - Card data objects.
     * @param {string} sortKey - Current local sort key.
     */
    #renderCards(cards, sortKey) {
        this.#handElement.replaceChildren(this.#drawButton);
        const orderedCards = CardSortUtils.sorted(cards, sortKey);

        // The server appends drawn cards to the hand, so render from the end
        // without mutating Room data to keep the newest cards first.
        for (let index = orderedCards.length - 1; index >= 0; index -= 1) {
            const card = orderedCards[index];

            this.#handElement.appendChild(PlayingCard.create(card, true));
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
