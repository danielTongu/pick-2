"use strict";

import { Constants } from "./Constants.js";
import { ValidationUtils } from "./ValidationUtils.js";

/**
 * Shared card ordering used by both the browser and the server.
 */
export class CardSortUtils {
    /**
     * Returns a sorted copy without changing the source array.
     *
     * @param {Object[]} cards - Cards to order.
     * @param {string} sortKey - Sort key.
     * @returns {Object[]} Ordered copy.
     * @throws {Error}
     */
    static sorted(cards, sortKey = "none") {
        ValidationUtils.array(cards, "Cards");

        const result = [...cards];

        if (sortKey !== "none") {
            result.sort(CardSortUtils.comparator(sortKey));
        }

        return result;
    }

    /**
     * Returns the comparator for a supported sort key.
     *
     * @param {string} sortKey - Sort key.
     * @returns {Function} Comparator.
     * @throws {Error}
     */
    static comparator(sortKey) {
        const comparators = {
            rank: CardSortUtils.#compareRank,
            score: CardSortUtils.#compareScore,
            suit: CardSortUtils.#compareSuit,
            value: CardSortUtils.#compareValue
        };
        const compare = comparators[sortKey];

        if (typeof compare !== "function") {
            throw new Error(`Invalid card sort key: ${sortKey}`);
        }

        return compare;
    }

    static #compareRank(left, right) {
        return CardSortUtils.#rank(left) - CardSortUtils.#rank(right) ||
            String(left.suit).localeCompare(String(right.suit));
    }

    static #compareScore(left, right) {
        return CardSortUtils.#calculateCardScore(left) - CardSortUtils.#calculateCardScore(right);
    }

    static #compareSuit(left, right) {
        return String(left.suit).localeCompare(String(right.suit)) ||
            CardSortUtils.#rank(left) - CardSortUtils.#rank(right);
    }

    static #compareValue(left, right) {
        return CardSortUtils.#rank(left) - CardSortUtils.#rank(right) ||
            String(left.suit).localeCompare(String(right.suit));
    }

    /**
     * Gets a card's natural rank.
     *
     * @param {Object} card - Card-like object.
     * @returns {number} Rank.
     */
    static #rank(card) {
        return Constants.getCardValue(card.value).rank;
    }

    /**
     * Gets a card's score from a server model or browser DTO.
     *
     * @param {Object} card - Card-like object.
     * @returns {number} Score.
     */
    static #calculateCardScore(card) {
        let score;

        if (Number.isFinite(card.score)) {
            score = card.score;
        } else {
            score = Constants.getCardScore(card.value, card.suit);
        }

        return score;
    }
}
