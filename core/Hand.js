
"use strict";

import { Card } from "./Card.js";
import { Serializable } from "./Serializable.js";
import { CardSortUtils } from "./CardSortUtils.js";
import { ValidationUtils } from "./ValidationUtils.js";

/**
 * Owns a collection of cards.
 */
export class Hand extends Serializable {
    /**
     * Creates a hand.
     *
     * @param {(Card|Object)[]} [cards=[]] Initial cards.
     * @throws {Error}
     */
    constructor(cards = []) {
        super();

        ValidationUtils.array(cards, "Cards");

        /** @type {Card[]} */
        this.cards = [];

        /** @type {number} */
        this.score = 0;

        for (const card of cards) {
            this.draw(card);
        }
    }

    /**
     * Adds one card.
     *
     * @param {Card|Object} card - Card to add.
     * @returns {Card} Added card.
     */
    draw(card) {
        const next = Card.from(card);

        this.cards.push(next);
        this.score += next.score;

        return next;
    }

    /**
     * Adds many cards.
     *
     * @param {(Card|Object)[]} cards - Cards to add.
     * @returns {Card[]} Added cards.
     * @throws {Error}
     */
    drawMany(cards) {
        ValidationUtils.array(cards, "Cards");

        const drawn = [];

        for (const card of cards) {
            drawn.push(this.draw(card));
        }

        return drawn;
    }

    /**
     * Removes a matching card.
     *
     * @param {Card|Object} card - Card to remove.
     * @returns {Card} Removed card.
     * @throws {Error}
     */
    discard(card) {
        const found = this.#findCard(card);

        if (found === null) {
            throw new Error(`Card not found: ${Card.from(card)}`);
        }

        const index = this.cards.indexOf(found);
        const discarded = this.cards.splice(index, 1)[0];

        this.score -= discarded.score;

        return discarded;
    }

    /**
     * Finds a matching card.
     *
     * @param {Card|Object} card - Card to locate.
     * @returns {Card|null} Matching card.
     */
    #findCard(card) {
        const target = Card.from(card);

        let found = null;

        for (const entry of this.cards) {
            if (entry.value === target.value && entry.suit === target.suit) {
                found = entry;
                break;
            }
        }

        return found;
    }

    /**
     * Checks whether the hand contains a card.
     *
     * @param {Card|Object} card - Card to locate.
     * @returns {boolean} True when present.
     */
    isCardPresent(card) {
        return this.#findCard(card) !== null;
    }

    /**
     * Sorts cards in-place.
     *
     * @param {Function} compare - Comparison function.
     * @throws {Error}
     */
    #sort(compare) {
        if (typeof compare !== "function") {
            throw new Error("Sort compare must be a function.");
        }

        this.cards.sort(compare);
    }

    /**
     * Permanently sorts the cards currently in the hand.
     *
     * Cards drawn later are appended normally and are not automatically sorted.
     *
     * @param {string} sortKey - Sort key.
     * @throws {Error}
     */
    sortBy(sortKey) {
        if (sortKey !== "none") {
            this.#sort(CardSortUtils.comparator(sortKey));
        }
    }

    /**
     * Removes all cards.
     */
    clear() {
        this.cards.length = 0;
        this.score = 0;
    }

    /**
     * Creates a defensive copy of the cards.
     *
     * @returns {Card[]} Cards.
     */
    toArray() {
        return [...this.cards];
    }

    /**
     * Checks whether the hand is empty.
     *
     * @returns {boolean} True when empty.
     */
    isEmpty() {
        return this.cards.length === 0;
    }

    /**
     * Iterates over the cards.
     *
     * @returns {IterableIterator<Card>}
     */
    *[Symbol.iterator]() {
        yield* this.cards;
    }

}
