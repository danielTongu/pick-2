"use strict";

import { Constants } from "../core/Constants.js";
import { DomUtils } from "./DomUtils.js";
import { PlayingCard } from "./PlayingCard.js";

/** Initializes the session's game guide and shared card controls. */
export class GuideController {
    /** Initializes guide content derived from canonical game constants. */
    initialize() {
        GuideController.#renderSortOptions();
        GuideController.#renderScores();
        GuideController.#renderSpecialCards();
    }

    /** Renders canonical hand-sort options. */
    static #renderSortOptions() {
        const select = DomUtils.require("#card-sort-key-select", HTMLSelectElement);
        select.replaceChildren(...Constants.CARD.SORT_OPTIONS.map((sortKey) => {
            const option = document.createElement("option");
            option.value = sortKey;
            option.textContent = sortKey;
            return option;
        }));
    }

    /** Renders canonical score examples. */
    static #renderScores() {
        for (const cell of DomUtils.require("#scores-tables").querySelectorAll("td[data-card-value][data-card-suit]")) {
            cell.textContent = String(Constants.getCardScore(cell.dataset.cardValue, cell.dataset.cardSuit));
        }
    }

    /** Renders special-card examples. */
    static #renderSpecialCards() {
        const { VALUE, SUIT } = Constants.CARD;
        const suits = [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS, SUIT.SPADES];
        const cards = (value, selectedSuits = suits) => selectedSuits.map((suit) => ({value, suit}));
        const groups = {
            "all-eights": cards(VALUE.EIGHT.id),
            "all-jacks": cards(VALUE.JACK.id),
            "aces-except-spades": cards(VALUE.ACE.id, [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS]),
            "all-twos": cards(VALUE.TWO.id),
            "all-jokers": cards(VALUE.JOKER.id, [SUIT.BLACK, SUIT.RED]),
            "ace-of-spades": cards(VALUE.ACE.id, [SUIT.SPADES]),
            "seven-of-hearts": cards(VALUE.SEVEN.id, [SUIT.HEARTS])
        };

        for (const [id, group] of Object.entries(groups)) {
            const element = DomUtils.require(`#${id}`, HTMLElement);
            element.replaceChildren(...group.map((card) => PlayingCard.create(card)));
            element.removeAttribute("id");
        }
    }
}
