"use strict";

import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { PlayingCard } from "../PlayingCard.js";

/** Initializes the game guide and shared card controls. */
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
        const options = [];

        for (const sortKey of Constants.CARD.SORT_OPTIONS) {
            const option = document.createElement("option");
            option.value = sortKey;
            option.textContent = sortKey;
            options.push(option);
        }

        select.replaceChildren(...options);
    }

    /** Renders canonical score examples. */
    static #renderScores() {
        for (const cell of DomUtils.require("#scores-tables", HTMLElement).querySelectorAll("td[data-card-value][data-card-suit]")) {
            cell.textContent = String(Constants.getCardScore(cell.dataset.cardValue, cell.dataset.cardSuit));
        }
    }

    /** Renders special-card examples. */
    static #renderSpecialCards() {
        const { VALUE, SUIT } = Constants.CARD;
        const suits = [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS, SUIT.SPADES];
        const groups = {
            eights: GuideController.#createCards(VALUE.EIGHT.id, suits),
            jacks: GuideController.#createCards(VALUE.JACK.id, suits),
            "aces-except-spades": GuideController.#createCards(
                VALUE.ACE.id,
                [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS]
            ),
            twos: GuideController.#createCards(VALUE.TWO.id, suits),
            jokers: GuideController.#createCards(VALUE.JOKER.id, [SUIT.BLACK, SUIT.RED]),
            "ace-of-spades": GuideController.#createCards(VALUE.ACE.id, [SUIT.SPADES]),
            "seven-of-hearts": GuideController.#createCards(VALUE.SEVEN.id, [SUIT.HEARTS])
        };

        for (const [id, group] of Object.entries(groups)) {
            const element = DomUtils.require(`#${id}`, HTMLElement);
            const cards = [];

            for (const card of group) {
                cards.push(PlayingCard.create(card, false));
            }

            element.replaceChildren(...cards);
            element.removeAttribute("id");
        }
    }

    /** Builds card records for one value and an explicit suit list. */
    static #createCards(value, suits) {
        const cards = [];

        for (const suit of suits) {
            cards.push({value, suit});
        }

        return cards;
    }
}
