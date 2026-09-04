
"use strict";

import { Constants } from "./Constants.js";
import { Serializable } from "./Serializable.js";

/**
 * Card representation used by server-side rules, deck logic, and snapshots.
 */
export class Card extends Serializable {
    /**
     * Creates a validated card.
     *
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {number} rotation - Visual rotation in degrees.
     * @throws {Error}
     */
    constructor(value, suit, rotation = Math.random() * 360) {
        super();

        this.value = Card.#normalizeText(value, "Card.value");
        this.suit = Card.#normalizeText(suit, "Card.suit");

        Card.#validateIdentity(this.value, this.suit);

        this.score = Card.#calculateScore(this.value, this.suit);
        this.rotation = Card.#normalizeRotation(rotation);
    }

    /**
     * Creates a card from a Card instance or card-like object.
     *
     * @param {*} source - Card or card-like object.
     * @returns {Card} Card instance.
     * @throws {Error}
     */
    static from(source) {
        let card;

        if (source instanceof Card) {
            card = new Card(source.value, source.suit, source.rotation);
        } else if (typeof source === "object" && source !== null) {
            card = new Card(source.value, source.suit, Number.isFinite(source.rotation) ? source.rotation : Math.random() * 360);
        } else {
            throw new Error("Card source must be an object.");
        }

        return card;
    }

    /**
     * Creates a stable card id.
     *
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @returns {string} Stable card id.
     * @throws {Error}
     */
    static #createId(value, suit) {
        const normalizedValue = Card.#normalizeText(value, "Card.value");
        const normalizedSuit = Card.#normalizeText(suit, "Card.suit");

        Card.#validateIdentity(normalizedValue, normalizedSuit);

        return `${normalizedValue}-${normalizedSuit}`;
    }

    /**
     * Validates card attributes.
     *
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @throws {Error}
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
     * Checks whether a card value is valid.
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
     * Calculates card score.
     *
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @returns {number} Card score.
     * @throws {Error}
     */
    static #calculateScore(value, suit) {
        Card.#validateIdentity(value, suit);

        return Constants.getCardScore(value, suit);
    }

    /**
     * Gets stable card id.
     *
     * @returns {string} Stable card id.
     */
    getId() {
        return Card.#createId(this.value, this.suit);
    }

    /**
     * Stringifies the card as its stable id.
     *
     * @returns {string} Stable card id.
     */
    toString() {
        return this.getId();
    }

    /**
     * Checks whether this card immediately ends the game.
     *
     * @returns {boolean} True when this card ends the game.
     */
    isRoundEndingCard() {
        return this.value === Constants.CARD.VALUE.SEVEN.id && this.suit === Constants.CARD.SUIT.HEARTS;
    }

    /**
     * Checks whether this is a draw-four card.
     *
     * @returns {boolean} True when this is a draw-four card.
     */
    isDrawFour() {
        return this.value === Constants.CARD.VALUE.JOKER.id;
    }

    /**
     * Checks whether this is a draw-two card.
     *
     * @returns {boolean} True when this is a draw-two card.
     */
    isDrawTwo() {
        return this.value === Constants.CARD.VALUE.TWO.id;
    }

    /**
     * Checks whether this is any draw card.
     *
     * @returns {boolean} True when this is any draw card.
     */
    isDrawCard() {
        return this.isDrawFour() || this.isDrawTwo();
    }

    /**
     * Checks whether this is the ace of spades.
     *
     * @returns {boolean} True when this is the ace of spades.
     */
    isAceOfSpades() {
        return this.value === Constants.CARD.VALUE.ACE.id && this.suit === Constants.CARD.SUIT.SPADES;
    }

    /**
     * Checks whether this card changes suit.
     *
     * @returns {boolean} True when this card changes suit.
     */
    isSuitChange() {
        return this.value === Constants.CARD.VALUE.ACE.id && this.suit !== Constants.CARD.SUIT.SPADES;
    }

    /**
     * Checks whether this card is wild.
     *
     * @returns {boolean} True when this card is wild.
     */
    isWild() {
        return this.isDrawFour() || this.isAceOfSpades();
    }

    /**
     * Checks whether this card has a special rule.
     *
     * @returns {boolean} True when this card has a special rule.
     */
    isSpecial() {
        return this.isRoundEndingCard() ||
            this.value === Constants.CARD.VALUE.TWO.id ||
            this.value === Constants.CARD.VALUE.EIGHT.id ||
            this.value === Constants.CARD.VALUE.JACK.id ||
            this.value === Constants.CARD.VALUE.ACE.id ||
            this.value === Constants.CARD.VALUE.JOKER.id;
    }

    /**
     * Checks whether this card skips the next player.
     *
     * @param {number} playerCount - Number of players.
     * @returns {boolean} True when this card skips.
     */
    isSkip(playerCount) {
        return this.value === Constants.CARD.VALUE.EIGHT.id ||
            (this.value === Constants.CARD.VALUE.JACK.id && playerCount === 2);
    }

    /**
     * Checks whether this card is any ace.
     *
     * @returns {boolean} True when this card is an ace.
     */
    isAce() {
        return this.value === Constants.CARD.VALUE.ACE.id;
    }

    /**
     * Checks whether this card reverses direction.
     *
     * @param {number} playerCount - Number of players.
     * @returns {boolean} True when this card reverses direction.
     */
    isReverse(playerCount) {
        return this.value === Constants.CARD.VALUE.JACK.id && playerCount > 2;
    }

    /**
     * Checks whether playing this card ends the Game.
     *
     * @param {number} remaining - Remaining cards.
     * @returns {boolean} True when playing this card ends the Game.
     */
    isRoundEndingMove(remaining) {
        return remaining === 0 || this.isRoundEndingCard();
    }

    /**
     * Checks whether this card may be played on the current discard.
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
     * @throws {Error}
     */
    isLegalOn(topDiscard, declaredSuit = null, drawAllowance = 1) {
        let isLegal = true;

        if (topDiscard !== null && topDiscard !== undefined) {
            const top = Card.from(topDiscard);

            if (drawAllowance > 1) {
                isLegal = (this.isDrawCard() && this.getRank() >= top.getRank()) || this.isAceOfSpades();
            } else if (declaredSuit) {
                isLegal = this.suit === declaredSuit || this.isAce() || this.isDrawFour();
            } else {
                isLegal = this.isCompatibleWith(top);
            }
        }

        return isLegal;
    }

    /**
     * Checks compatibility with another card.
     *
     * @param {Card} other - Other card.
     * @returns {boolean} True when this card is compatible.
     */
    isCompatibleWith(other) {
        return this.value === other.value || this.suit === other.suit || this.isWild() || other.isWild();
    }

    /**
     * Gets this card's natural rank.
     *
     * @returns {number} Card rank.
     */
    getRank() {
        return Constants.getCardValue(this.value).rank;
    }

    /**
     * Normalizes required card text.
     *
     * @param {*} value - Text value.
     * @param {string} label - Error label.
     * @returns {string} Normalized text.
     * @throws {Error}
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
     * @throws {Error}
     */
    static #normalizeRotation(rotation) {
        if (!Number.isFinite(rotation)) {
            throw new Error("Card.rotation must be a finite number.");
        }

        return rotation;
    }
}
