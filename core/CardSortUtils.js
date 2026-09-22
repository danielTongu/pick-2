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
     * @throws {Error} When the card array or requested sort key is invalid.
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
     * @throws {Error} When the card array or requested sort key is invalid.
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

    /**

     * Orders by natural rank, then suit for deterministic ties.
     * @param {Object} left - First card.
     * @param {Object} right - Second card.
     * @returns {number} Comparator result.
     */
    static #compareRank(left, right) {
        return (
            CardSortUtils.#rank(left) - CardSortUtils.#rank(right) ||
            String(left.suit).localeCompare(String(right.suit))
        );
    }

    /**

     * Orders by Pick 2 score, preserving stable order for ties.
     * @param {Object} left - First card.
     * @param {Object} right - Second card.
     * @returns {number} Comparator result.
     */
    static #compareScore(left, right) {
        return CardSortUtils.#calculateCardScore(left) - CardSortUtils.#calculateCardScore(right);
    }

    /**

     * Orders lexically by suit, then by natural rank.
     * @param {Object} left - First card.
     * @param {Object} right - Second card.
     * @returns {number} Comparator result.
     */
    static #compareSuit(left, right) {
        return (
            String(left.suit).localeCompare(String(right.suit)) ||
            CardSortUtils.#rank(left) - CardSortUtils.#rank(right)
        );
    }

    /**

     * Orders by natural value rank, then suit for deterministic ties.
     * @param {Object} left - First card.
     * @param {Object} right - Second card.
     * @returns {number} Comparator result.
     */
    static #compareValue(left, right) {
        return (
            CardSortUtils.#rank(left) - CardSortUtils.#rank(right) ||
            String(left.suit).localeCompare(String(right.suit))
        );
    }

    /**
     * Resolves the natural rank of a card-like value through canonical constants.
     *
     * @param {Object} card - Card-like object.
     * @returns {number} Rank.
     */
    static #rank(card) {
        return Constants.getCardValue(card.value).rank;
    }

    /**
     * Uses a finite supplied score or derives the canonical Pick 2 score.
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
