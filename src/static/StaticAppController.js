"use strict";

import { Constants } from "../core/Constants.js";
import { DomUtils } from "../ui/DomUtils.js";
import { PlayingCard } from "../ui/PlayingCard.js";

/**
 * Coordinates the single-table static application.
 */
export class StaticAppController {
    /** @type {import("./LocalGameService.js").LocalGameService} */
    #gameService;

    /** @type {import("./StaticRoomController.js").StaticRoomController} */
    #roomController;

    /**
     * Creates the static app controller.
     *
     * @param {import("./LocalGameService.js").LocalGameService} gameService - Local game service.
     * @param {import("./StaticRoomController.js").StaticRoomController} roomController - Table controller.
     */
    constructor(gameService, roomController) {
        this.#gameService = gameService;
        this.#roomController = roomController;
        this.#gameService.setAppController(this);
    }

    /**
     * Initializes the UI and creates the waiting table.
     *
     * @returns {Promise<void>}
     */
    async start() {
        StaticAppController.#renderCopyrightYear();
        await this.#roomController.initialize();
        this.#bindTableControls();
        StaticAppController.#synchronizeCardSortOptions();
        StaticAppController.#synchronizeGameGuideCardScores();
        StaticAppController.#renderGameGuideSpecialCards();
        this.#roomController.show();
        await this.#gameService.connect();
    }

    /**
     * Renders a new room snapshot and join-seat state.
     *
     * @param {Object} room - Table snapshot.
     */
    handleRoomSync(room) {
        const isJoined = room?.session?.playerName !== null;
        const isBusy = room?.isBusy === true;
        const isActive = room?.status === Constants.STATUS.PLAYING || room?.status === Constants.STATUS.PENDING;
        const isRunningWithoutLocalPlayer = !isJoined && isActive;
        const canJoin = !isJoined && room?.status === Constants.STATUS.WAITING;
        const leaveButton = DomUtils.require("#leave-table-button", HTMLButtonElement);

        DomUtils.require("#join-panel", HTMLElement).hidden = !canJoin;
        leaveButton.hidden = !isJoined && !isRunningWithoutLocalPlayer;
        leaveButton.disabled = isJoined && isBusy;
        leaveButton.dataset.action = isRunningWithoutLocalPlayer ? "stop" : "leave";
        leaveButton.textContent = isRunningWithoutLocalPlayer ? "stop" : "leave";
        DomUtils.require("#new-table-button", HTMLButtonElement).disabled = isBusy;
        this.#roomController.render(room);
    }

    /**
     * Binds join, leave, and restart controls.
     */
    #bindTableControls() {
        const form = DomUtils.require("#join-form", HTMLFormElement);
        const nameInput = DomUtils.require("#player-name-input", HTMLInputElement);

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            void this.#gameService.join(nameInput.value);
        }.bind(this));

        DomUtils.require("#new-table-button", HTMLButtonElement).addEventListener("click", function () {
            if (window.confirm("Start a fresh table? The current game will be discarded.")) {
                void this.#gameService.reset();
            }
        }.bind(this));

        DomUtils.require("#leave-table-button", HTMLButtonElement).addEventListener("click", function (event) {
            const button = event.currentTarget;

            if (button instanceof HTMLButtonElement && button.dataset.action === "stop") {
                void this.#gameService.stop();
            } else {
                void this.#gameService.leave();
            }

            nameInput.focus();
        }.bind(this));
    }

    /** Synchronizes the hand-sort menu with canonical options. */
    static #synchronizeCardSortOptions() {
        const select = DomUtils.require("#card-sort-key-select", HTMLSelectElement);
        select.replaceChildren(...Constants.CARD.SORT_OPTIONS.map(function (sortKey) {
            const option = document.createElement("option");
            option.value = sortKey;
            option.textContent = sortKey;
            return option;
        }));
    }

    /** Synchronizes score examples with canonical rules. */
    static #synchronizeGameGuideCardScores() {
        for (const scoreCell of DomUtils.require("#scores-tables").querySelectorAll("td[data-card-value][data-card-suit]")) {
            scoreCell.textContent = String(Constants.getCardScore(scoreCell.dataset.cardValue, scoreCell.dataset.cardSuit));
        }
    }

    /** Renders special-card examples in the game guide. */
    static #renderGameGuideSpecialCards() {
        const { VALUE, SUIT } = Constants.CARD;
        const ordinarySuits = [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS, SUIT.SPADES];
        const suitedCards = (value, suits = ordinarySuits) => suits.map((suit) => ({ value, suit }));
        const cardsByListId = {
            "all-eights": suitedCards(VALUE.EIGHT.id),
            "all-jacks": suitedCards(VALUE.JACK.id),
            "aces-except-spades": suitedCards(VALUE.ACE.id, [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS]),
            "all-twos": suitedCards(VALUE.TWO.id),
            "all-jokers": suitedCards(VALUE.JOKER.id, [SUIT.BLACK, SUIT.RED]),
            "ace-of-spades": suitedCards(VALUE.ACE.id, [SUIT.SPADES]),
            "seven-of-hearts": suitedCards(VALUE.SEVEN.id, [SUIT.HEARTS])
        };

        for (const [listId, cards] of Object.entries(cardsByListId)) {
            const cardList = DomUtils.require(`#${listId}`, HTMLElement);
            cardList.replaceChildren(...cards.map((card) => PlayingCard.create(card)));
            cardList.removeAttribute("id");
        }
    }

    /** Renders the current copyright year. */
    static #renderCopyrightYear() {
        const year = String(new Date().getFullYear());
        const yearElement = DomUtils.require("#copyright-year", HTMLTimeElement);
        yearElement.dateTime = year;
        yearElement.textContent = year;
    }
}
