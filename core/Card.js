"use strict";

import { Constants } from "./Constants.js";
import { Serializable } from "./Serializable.js";

/** Immutable validated card identity shared by rules, collections, bots, and snapshots.*/
export class Card extends Serializable {
    /** @type {string} Stable card identity. */
    #id;

    /** @type {number} Card score. */
    #score;

    /**
     * Creates a validated card.
     *
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {number} rotation - Visual rotation in degrees.
     * @throws {Error} When supplied card identity, text, rotation, or legality input is invalid.
     */
    constructor(value, suit, rotation = Math.random() * 360) {
        const normalizedValue = Card.#normalizeText(value, "Card.value");
        const normalizedSuit = Card.#normalizeText(suit, "Card.suit");

        Card.#validateIdentity(normalizedValue, normalizedSuit);
        super();

        this.#id = `${normalizedValue}-${normalizedSuit}`;
        this.#score = Constants.getCardScore(normalizedValue, normalizedSuit);
        this.value = normalizedValue;
        this.suit = normalizedSuit;
        this.rotation = Card.#normalizeRotation(rotation);

        Object.freeze(this); // Prevent further mutation.
    }

    /** @returns {string} Stable card identity. */
    get id() {
        return this.#id;
    }

    /** @returns {string} Stable item key used by Room messages and commands. */
    get key() {
        return this.#id;
    }

    /** @returns {number} Pick2 score. */
    get score() {
        return this.#score;
    }

    /** Returns whether another card has the same identity. */
    equals(source) {
        return source instanceof Card && source.id === this.id;
    }

    /** @returns {string} Stable card identity. */
    toString() {
        return this.id;
    }

    /** Serializes this card with its derived score when requested. */
    toJSON(include = null, exclude = []) {
        const fields = typeof include === "string" ? null : include;
        const snapshot = super.toJSON(fields, exclude);

        if (!exclude.includes("score") && (fields === null || fields.includes("score"))) snapshot.score = this.score;
        return snapshot;
    }

    /** @returns {number} Natural rank derived from the card value. */
    get rank() {
        return Constants.getCardValue(this.value).rank;
    }

    /**
     * Creates a card from a Card instance or card-like object.
     *
     * @param {*} source - Card or card-like object.
     * @returns {Card} Card instance.
     * @throws {Error} When supplied card identity, text, rotation, or legality input is invalid.
     */
    static from(source) {
        let card;

        if (source instanceof Card) {
            card = new Card(source.value, source.suit, source.rotation);
        } else if (typeof source === "object" && source !== null) {
            card = new Card(
                source.value,
                source.suit,
                Number.isFinite(source.rotation) ? source.rotation : Math.random() * 360
            );
        } else {
            throw new Error("Card source must be an object.");
        }

        return card;
    }

    /**
     * Enforces the allowed value-and-suit combinations for standard cards and jokers.
     *
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @throws {Error} When supplied card identity, text, rotation, or legality input is invalid.
     */
    static #validateIdentity(value, suit) {
        const isJoker = value === Constants.CARD.VALUE.JOKER.id;

        if (!Card.#isValueValid(value)) {
            throw new Error(`Invalid card value: ${value}`);
        }

        if (isJoker && !Constants.isJokerSuit(suit)) {
            throw new Error("Joker must use red or black suit.");
        }

        if (!isJoker && !Constants.isStandardSuit(suit)) {
            throw new Error(`Invalid card suit: ${suit}`);
        }
    }

    /**
     * Returns whether canonical constants contain the supplied card value.
     *
     * @param {string} value - Card value.
     * @returns {boolean} True when the value exists.
     */
    static #isValueValid(value) {
        let isValueValid = true;

        try {
            Constants.getCardValue(value);
        } catch (_error) {
            isValueValid = false;
        }

        return isValueValid;
    }

    /**
     * Normalizes required card text.
     *
     * @param {*} value - Text value.
     * @param {string} label - Error label.
     * @returns {string} Normalized text.
     * @throws {Error} When supplied card identity, text, rotation, or legality input is invalid.
     */
    static #normalizeText(value, label) {
        if (typeof value !== "string") {
            throw new Error(`${label} must be a string.`);
        }

        const text = value.trim().toLowerCase();

        if (!text) {
            throw new Error(`${label} cannot be empty.`);
        }

        return text;
    }

    /**
     * Normalizes rotation.
     *
     * @param {*} rotation - Rotation value.
     * @returns {number} Normalized rotation.
     * @throws {Error} When supplied card identity, text, rotation, or legality input is invalid.
     */
    static #normalizeRotation(rotation) {
        if (!Number.isFinite(rotation)) {
            throw new Error("Card.rotation must be a finite number.");
        }

        return rotation;
    }

    /**
     * Returns whether this is the seven of hearts, which immediately ends a round.
     *
     * @returns {boolean} True when this card ends the game.
     */
    isRoundEndingCard() {
        return this.value === Constants.CARD.VALUE.SEVEN.id && this.suit === Constants.CARD.SUIT.HEARTS;
    }

    /**
     * Returns whether this joker applies a four-card draw penalty.
     *
     * @returns {boolean} True when this is a draw-four card.
     */
    isDrawFour() {
        return this.value === Constants.CARD.VALUE.JOKER.id;
    }

    /**
     * Returns whether this two applies a two-card draw penalty.
     *
     * @returns {boolean} True when this is a draw-two card.
     */
    isDrawTwo() {
        return this.value === Constants.CARD.VALUE.TWO.id;
    }

    /**
     * Returns whether this card contributes a draw penalty.
     *
     * @returns {boolean} True when this is any draw card.
     */
    isDrawCard() {
        return this.isDrawFour() || this.isDrawTwo();
    }

    /**
     * Returns whether this is the ace of spades draw-defense wild card.
     *
     * @returns {boolean} True when this is the ace of spades.
     */
    isAceOfSpades() {
        return this.value === Constants.CARD.VALUE.ACE.id && this.suit === Constants.CARD.SUIT.SPADES;
    }

    /**
     * Returns whether this is a non-spade ace requiring a suit declaration.
     *
     * @returns {boolean} True when this card changes suit.
     */
    isSuitChange() {
        return this.value === Constants.CARD.VALUE.ACE.id && this.suit !== Constants.CARD.SUIT.SPADES;
    }

    /**
     * Returns whether this card bypasses ordinary value-and-suit matching.
     *
     * @returns {boolean} True when this card is wild.
     */
    isWild() {
        return this.isDrawFour() || this.isAceOfSpades();
    }

    /**
     * Returns whether discarding this card applies behavior beyond ordinary matching.
     *
     * @returns {boolean} True when this card has a special rule.
     */
    isSpecial() {
        return (
            this.isRoundEndingCard() ||
            this.value === Constants.CARD.VALUE.TWO.id ||
            this.value === Constants.CARD.VALUE.EIGHT.id ||
            this.value === Constants.CARD.VALUE.JACK.id ||
            this.value === Constants.CARD.VALUE.ACE.id ||
            this.value === Constants.CARD.VALUE.JOKER.id
        );
    }

    /**
     * Applies player-count-sensitive skip semantics for eights and jacks.
     *
     * @param {number} playerCount - Number of players.
     * @returns {boolean} True when this card skips.
     */
    isSkip(playerCount) {
        return (
            this.value === Constants.CARD.VALUE.EIGHT.id ||
            (this.value === Constants.CARD.VALUE.JACK.id && playerCount === 2)
        );
    }

    /**
     * Returns whether this card has ace value regardless of suit.
     *
     * @returns {boolean} True when this card is an ace.
     */
    isAce() {
        return this.value === Constants.CARD.VALUE.ACE.id;
    }

    /**
     * Returns whether a jack reverses a circle containing more than two actors.
     *
     * @param {number} playerCount - Number of players.
     * @returns {boolean} True when this card reverses direction.
     */
    isReverse(playerCount) {
        return this.value === Constants.CARD.VALUE.JACK.id && playerCount > 2;
    }

    /**
     * Returns whether this discard empties the hand or invokes the seven-of-hearts rule.
     *
     * @param {number} remaining - Remaining cards.
     * @returns {boolean} True when playing this card ends the Game.
     */
    isRoundEndingMove(remaining) {
        return remaining === 0 || this.isRoundEndingCard();
    }

    /**
     * Evaluates this card against the active penalty, declared suit, and top discard.
     *
     * Rules:
     * - No top discard: any card is legal.
     * - Active draw penalty: only draw cards may be stacked, and only with an equal or higher rank.
     * - Declared suit: any card matching the declared suit, any ace, or any joker may be played.
     * - Otherwise: normal compatibility rules apply.
     *
     * @param {*|null} topDiscard - Current top discard card.
     * @param {string|null} declaredSuit - Currently declared suit, if any.
     * @param {number} drawAllowance - Current draw allowance.
     * @returns {boolean} True when this card may be played.
     * @throws {Error} When supplied card identity, text, rotation, or legality input is invalid.
     */
    isLegalOn(topDiscard, declaredSuit = null, drawAllowance = 1) {
        let isLegal = true;

        if (topDiscard !== null && topDiscard !== undefined) {
            const top = Card.from(topDiscard);

            if (drawAllowance > 1) {
                isLegal = (this.isDrawCard() && this.rank >= top.rank) || this.isAceOfSpades();
            } else if (declaredSuit) {
                isLegal = this.suit === declaredSuit || this.isAce() || this.isDrawFour();
            } else {
                isLegal = this.isCompatibleWith(top);
            }
        }

        return isLegal;
    }

    /**
     * Applies ordinary value, suit, and wild-card compatibility against another card.
     *
     * @param {Card} other - Other card.
     * @returns {boolean} True when this card is compatible.
     */
    isCompatibleWith(other) {
        return this.value === other.value || this.suit === other.suit || this.isWild() || other.isWild();
    }
}
