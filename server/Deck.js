// server/Deck.js

"use strict";

import { Constants } from "../public/scripts/Constants.js";
import { NormalizeUtils } from "../public/scripts/utils/NormalizeUtils.js";
import { Card } from "./Card.js";
import { Serializable } from "./Serializable.js";

/**
 * Owns the draw pile.
 */
export class Deck extends Serializable {
    /**
     * Creates a deck.
     *
     * @param {boolean} isShuffled - Whether to shuffle after reset.
     * @throws {Error}
     */
    constructor(isShuffled = true) {
        super();

        /** @type {Card[]} */
        this.cards = [];

        this.reset(isShuffled);
    }

    /**
     * Rebuilds the deck.
     *
     * @param {boolean} isShuffled - Whether to shuffle after reset.
     * @throws {Error}
     */
    reset(isShuffled = true) {
        NormalizeUtils.boolean(isShuffled, "Deck shuffle flag");

        this.clear();

        for (const suit of Constants.CARD.STANDARD_SUITS) {
            for (const value of Constants.CARD.STANDARD_VALUES) {
                this.cards.push(new Card(value, suit));
            }
        }

        this.cards.push(new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.BLACK));
        this.cards.push(new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.RED));

        if (isShuffled) {
            this.shuffle();
        }
    }

    /**
     * Shuffles the deck in-place.
     */
    shuffle() {
        for (let index = this.cards.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            const card = this.cards[index];

            this.cards[index] = this.cards[swapIndex];
            this.cards[swapIndex] = card;
        }
    }

    /**
     * Draws one card from the top of the deck.
     *
     * @returns {Card|null} Drawn card.
     */
    draw() {
        return this.cards.pop() ?? null;
    }

    /**
     * Draws up to count cards from the top of the deck.
     *
     * @param {number} count - Number of cards to draw.
     * @returns {Card[]} Drawn cards.
     * @throws {Error}
     */
    drawMany(count) {
        NormalizeUtils.nonNegativeInteger(count, "Draw count");

        const drawn = [];

        while (drawn.length < count && !this.isEmpty()) {
            const card = this.draw();

            if (card !== null) {
                drawn.push(card);
            }
        }

        return drawn;
    }

    /**
     * Places a card on top of the deck.
     *
     * @param {Card|Object} card - Card to place.
     */
    putTop(card) {
        this.cards.push(Card.from(card));
    }

    /**
     * Places a card on bottom of the deck.
     *
     * @param {Card|Object} card - Card to place.
     */
    #putBottom(card) {
        this.cards.unshift(Card.from(card));
    }

    /**
     * Places cards on top of the deck.
     *
     * @param {(Card|Object)[]} cards - Cards to place.
     * @throws {Error}
     */
    putManyTop(cards) {
        NormalizeUtils.array(cards, "Cards");

        for (const card of cards) {
            this.putTop(card);
        }
    }

    /**
     * Places cards on bottom while preserving the provided order.
     *
     * @param {(Card|Object)[]} cards - Cards to place.
     * @throws {Error}
     */
    putManyBottom(cards) {
        NormalizeUtils.array(cards, "Cards");

        for (let index = cards.length - 1; index >= 0; index -= 1) {
            this.#putBottom(cards[index]);
        }
    }

    /**
     * Returns the top card without removing it.
     *
     * @returns {Card|null} Top card.
     */
    getTopCard() {
        return this.cards[this.cards.length - 1] ?? null;
    }

    /**
     * Removes all cards.
     */
    clear() {
        this.cards.length = 0;
    }

    /**
     * Creates a defensive copy of the deck cards.
     *
     * @returns {Card[]} Cards.
     */
    toArray() {
        return [...this.cards];
    }

    /**
     * Returns whether deck is empty.
     *
     * @returns {boolean} True when empty.
     */
    isEmpty() {
        return this.cards.length === 0;
    }

    /**
     * Iterates cards from bottom to top.
     *
     * @returns {IterableIterator<Card>} Card iterator.
     */
    *[Symbol.iterator]() {
        yield* this.cards;
    }

}
