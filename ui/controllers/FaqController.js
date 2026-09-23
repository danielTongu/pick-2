"use strict";

import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../../ui/utilities/DomUtils.js";
import { PlayingCard } from "../PlayingCard.js";

/** Initializes the FAQ and shared card controls. */
export class FaqController {
    /** Initializes FAQ content derived from canonical game constants. */
    initialize() {
        FaqController.#renderSortOptions();
        FaqController.#renderRanks();
        FaqController.#renderSpecialCards();
    }

    /** Renders canonical hand-sort options. */
    static #renderSortOptions() {
        const select = DomUtils.require("#sort-key-select", HTMLSelectElement);
        const options = [];

        for (const sortKey of Constants.CARD.SORT_OPTIONS) {
            const option = document.createElement("option");
            option.value = sortKey;
            option.textContent = sortKey;
            options.push(option);
        }

        select.replaceChildren(...options);
    }

    /** Renders canonical rank examples. */
    static #renderRanks() {
        for (const cell of DomUtils.require("#ranks-tables", HTMLElement).querySelectorAll(
            "td[data-card-value][data-card-suit]"
        )) {
            cell.textContent = String(Constants.getCardRank(cell.dataset.cardValue, cell.dataset.cardSuit));
        }
    }

    /** Renders special-card examples. */
    static #renderSpecialCards() {
        const { VALUE, SUIT } = Constants.CARD;
        const suits = [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS, SUIT.SPADES];
        const groups = {
            eights: FaqController.#createCards(VALUE.EIGHT.id, suits),
            jacks: FaqController.#createCards(VALUE.JACK.id, suits),
            "aces-except-spades": FaqController.#createCards(VALUE.ACE.id, [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS]),
            twos: FaqController.#createCards(VALUE.TWO.id, suits),
            jokers: FaqController.#createCards(VALUE.JOKER.id, [SUIT.BLACK, SUIT.RED]),
            "ace-of-spades": FaqController.#createCards(VALUE.ACE.id, [SUIT.SPADES]),
            "seven-of-hearts": FaqController.#createCards(VALUE.SEVEN.id, [SUIT.HEARTS])
        };

        for (const [id, group] of Object.entries(groups)) {
            const element = DomUtils.require(`#${id}`, HTMLElement);
            const cards = [];

            for (const card of group) {
                cards.push(PlayingCard.create(card));
            }

            element.replaceChildren(...cards);
            element.removeAttribute("id");
        }
    }

    /**
     * Builds card records for one value and an explicit suit list.
     * @param {string} value - Card value.
     * @param {string[]} suits - Suits to pair with the value.
     * @returns {Object[]} Card records.
     */
    static #createCards(value, suits) {
        const cards = [];

        for (const suit of suits) {
            cards.push({ value, suit });
        }

        return cards;
    }
}
