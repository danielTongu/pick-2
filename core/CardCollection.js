"use strict";

import { Serializable } from "./Serializable.js";
import { Constants } from "./Constants.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { Card } from "./Card.js";

/** Stores normalized cards for a deck, hand, or play pile. */
export class CardCollection extends Serializable {
    /**
     * Creates the canonical 54-card Pick 2 deck in deterministic or shuffled order.
     * @param {boolean} [isShuffled] - Whether to randomize the deck.
     * @returns {CardCollection} New deck.
     */
    static createDeck(isShuffled = true) {
        ValidationUtils.boolean(isShuffled, "Deck shuffle flag");
        const cards = [];

        for (const suit of Constants.CARD.STANDARD_SUITS) {
            for (const value of Constants.CARD.STANDARD_VALUES) {
                cards.push(new Card(value, suit));
            }
        }

        cards.push(new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.BLACK));
        cards.push(new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.RED));

        const deck = new CardCollection(cards);
        return isShuffled ? deck.shuffle() : deck;
    }

    /**

     * Creates card storage and normalizes every initial card.
     * @param {Array<Card|Object>} [cards] - Initial cards.
     */
    constructor(cards = []) {
        super();
        ValidationUtils.array(cards, "CardCollection cards");
        this.items = [];
        this.addMany(cards);
    }

    /**
     * @returns {number} Number of cards currently held.
     */
    get size() {
        return this.items.length;
    }

    /**
     * @returns {number} Sum of finite item scores.
     */
    get score() {
        return this.items.reduce(function totalScore(total, item) {
            return total + (Number.isFinite(item.score) ? item.score : 0);
        }, 0);
    }

    /**

     * Appends one normalized item and returns it.
     * @param {Card|Object} item - Card to append.
     * @returns {Card} Stored card.
     */
    add(item) {
        const value = Card.from(item);
        this.items.push(value);
        return value;
    }

    /**

     * Appends normalized items in supplied order.
     * @param {Array<Card|Object>} items - Cards to append.
     * @returns {Card[]} Stored cards.
     */
    addMany(items) {
        ValidationUtils.array(items, "CardCollection cards");
        const added = [];
        for (const item of items) {
            added.push(this.add(item));
        }
        return added;
    }

    /**

     * Prepends one normalized item and returns it.
     * @param {Card|Object} item - Card to prepend.
     * @returns {Card} Stored card.
     */
    addFirst(item) {
        const value = Card.from(item);
        this.items.unshift(value);
        return value;
    }

    /**

     * Prepends normalized items while preserving supplied order.
     * @param {Array<Card|Object>} items - Cards to prepend.
     * @returns {Card[]} Stored cards.
     */
    addManyFirst(items) {
        ValidationUtils.array(items, "CardCollection cards");
        const added = [];
        for (let index = items.length - 1; index >= 0; index -= 1) {
            added.unshift(this.addFirst(items[index]));
        }
        return added;
    }

    /** Removes and returns the last item, or null when empty. */
    take() {
        return this.items.pop() ?? null;
    }

    /**

     * Removes up to the requested number of items from the end.
     * @param {number} count - Maximum cards to remove.
     * @returns {Card[]} Removed cards.
     */
    takeMany(count) {
        ValidationUtils.nonNegativeInteger(count, "Take count");
        const taken = [];
        while (taken.length < count && !this.isEmpty()) {
            taken.push(this.take());
        }
        return taken;
    }

    /** Returns the last item without removing it. */
    peek() {
        return this.items[this.items.length - 1] ?? null;
    }

    /**

     * Returns whether the collection contains an item identity.
     * @param {Card|Object|string} item - Card identity to find.
     * @returns {boolean} Whether it is present.
     */
    has(item) {
        return this.#findIndex(item) >= 0;
    }

    /**

     * Removes the matching item identity, or returns null when absent.
     * @param {Card|Object|string} item - Card identity to remove.
     * @returns {Card|null} Removed card.
     */
    remove(item) {
        const index = this.#findIndex(item);
        return index < 0 ? null : this.items.splice(index, 1)[0];
    }

    /** Removes and returns every stored item. */
    clear() {
        const removed = [...this.items];
        this.items.length = 0;
        return removed;
    }

    /**

     * Sorts this collection in place and returns it.
     * @param {function(Card, Card): number} compare - Card comparator.
     * @returns {CardCollection} This collection.
     */
    sort(compare) {
        if (typeof compare !== "function") {
            throw new Error("Sort compare must be a function.");
        }
        this.items.sort(compare);
        return this;
    }

    /** Randomizes this collection in place and returns it. */
    shuffle() {
        for (let index = this.items.length - 1; index > 0; index -= 1) {
            const other = Math.floor(Math.random() * (index + 1));
            [this.items[index], this.items[other]] = [this.items[other], this.items[index]];
        }
        return this;
    }

    /** Returns a shallow item-array copy. */
    toArray() {
        return [...this.items];
    }

    /** Returns whether no items are stored. */
    isEmpty() {
        return this.items.length === 0;
    }

    *[Symbol.iterator]() {
        yield* this.items;
    }

    /** Serializes items and their current score total. */
    toJSON() {
        return {
            items: this.items.map(function serialize(item) {
                return item.toJSON();
            }),
            score: this.score
        };
    }

    /**

     * Returns the index of a card with the same canonical identity, or -1 when absent.
     * @param {Card|Object|string} item - Card identity to find.
     * @returns {number} Matching index or -1.
     */
    #findIndex(item) {
        const target = typeof item === "string" ? item : Card.from(item).id;
        return this.items.findIndex(function matches(entry) {
            return entry.id === target;
        });
    }
}
