// server/Player.js

"use strict";

import { Constants } from "../public/scripts/Constants.js";
import { Hand } from "./Hand.js";
import { UserNotification } from "./UserNotification.js";
import { Serializable } from "./Serializable.js";

/**
 * Represents a game participant.
 */
export class Player extends Serializable {
    /** @type {*} */
    #webSocket = null;

    /** @type {Function|null} */
    #idleHandler = null;

    /** @type {*|null} */
    #idleTimeoutId = null;

    /**
     * Creates a player.
     *
     * @param {string} name - Player display name.
     * @param {*} ws - WebSocket connection.
     * @throws {Error}
     */
    constructor(name, ws = null) {
        super();

        this.name = Player.normalizeName(name);
        this.key = Player.normalizeKey(this.name);

        this.createdAt = Date.now();
        this.lastActiveAt = this.createdAt;

        this.hand = new Hand();
        this.drawAllowance = 1;
        this.isWinner = false;

        this.nextKey = this.key;
        this.prevKey = this.key;

        this.#webSocket = ws;
    }

    /**
     * Normalizes player name.
     *
     * @param {*} value - Raw player name.
     * @returns {string} Normalized name.
     * @throws {Error}
     */
    static normalizeName(value) {
        if (typeof value !== "string") {
            throw new Error("Player name must be a string.");
        }

        const name = value.trim();

        if (!name) {
            throw new UserNotification("Player name cannot be empty.");
        }

        return name;
    }

    /**
     * Normalizes stable player key.
     *
     * @param {*} value - Raw player name or key.
     * @returns {string} Normalized key.
     * @throws {Error}
     */
    static normalizeKey(value) {
        return Player.normalizeName(value)
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9_-]/g, "");
    }


    /**
     * Gets this player's websocket.
     *
     * @returns {*} WebSocket connection.
     */
    get ws() {
        return this.#webSocket;
    }

    /**
     * Sets this player's websocket.
     *
     * @param {*} ws - WebSocket connection.
     */
    set ws(ws) {
        this.#webSocket = ws ?? null;
    }

    /**
     * Sets idle callback.
     *
     * @param {Function|null} callback - Idle callback.
     */
    set onIdle(callback) {
        this.#idleHandler = typeof callback === "function" ? callback : null;
    }

    /**
     * Updates activity timestamp and restarts idle timer when enabled.
     *
     * @returns {number} Last active timestamp.
     */
    recordActivity() {
        this.lastActiveAt = Date.now();
        this.#clearIdleTimeout();

        if (this.#idleHandler !== null) {
            this.#idleTimeoutId = globalThis.setTimeout(this.#handleIdleTimeout.bind(this), Constants.MAX_IDLE_MS);
        }

        return this.lastActiveAt;
    }

    /**
     * Clears the idle timer.
     */
    #clearIdleTimeout() {
        if (this.#idleTimeoutId !== null) {
            globalThis.clearTimeout(this.#idleTimeoutId);
            this.#idleTimeoutId = null;
        }
    }

    /**
     * Handles idle timeout by firing the idle callback.
     */
    #handleIdleTimeout() {
        this.#idleTimeoutId = null;

        if (this.#idleHandler !== null) {
            this.#idleHandler(this);
        }
    }

    /**
     * Stops idle monitoring.
     */
    stopIdleMonitoring() {
        this.#clearIdleTimeout();
        this.#idleHandler = null;
    }

    /**
     * Gets next player key.
     *
     * @returns {string|null} Next player key.
     */
    getNextKey() {
        return this.nextKey;
    }

    /**
     * Gets previous player key.
     *
     * @returns {string|null} Previous player key.
     */
    getPrevKey() {
        return this.prevKey;
    }

    /**
     * Sets circular turn links.
     *
     * @param {string|null|undefined} nextNameOrKey - Next player name or key.
     * @param {string|null|undefined} prevNameOrKey - Previous player name or key.
     */
    setTurnLinks(nextNameOrKey, prevNameOrKey) {
        this.nextKey = nextNameOrKey ? Player.normalizeKey(nextNameOrKey) : null;
        this.prevKey = prevNameOrKey ? Player.normalizeKey(prevNameOrKey) : null;
        this.recordActivity();
    }

    /**
     * Resets round state.
     */
    reset() {
        this.hand.clear();
        this.drawAllowance = 1;
        this.isWinner = false;
        this.recordActivity();
    }
}



/**
 * AI-controlled player with strategic card selection.
 */
export class AIPlayer extends Player {
    // AI Scoring Constants
    static #SCORE_WIN = Infinity;
    static #SCORE_NEVER = -Infinity;
    static #PRIORITY_HIGH = 10000;
    static #PRIORITY_MEDIUM = 5000;
    static #PRIORITY_LOW = 100;
    static #PENALTY_AVOID = -5000;
    static #PENALTY_STRONG_AVOID = -8000;
    static #PENALTY_LAST_RESORT = -1000;
    static #PENALTY_ACE = -3000;

    /**
     * Creates an AI player.
     *
     * @param {string} name - AI player name.
     * @throws {Error}
     */
    constructor(name) {
        super(name, null);
    }

    /**
     * Executes an AI turn.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async takeTurn(room) {
        await this.#waitForTurnDelay();

        if (this.#isStillCurrent(room)) {
            await this.#performTurnAction(room);
        }
    }

    /**
     * Simulates human-like thinking delay.
     *
     * @returns {Promise<void>}
     */
    async #waitForTurnDelay() {
        const delay = 2000 + Math.floor(Math.random() * 2001);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Checks whether this AI is still the current player.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {boolean} True if this AI is current.
     */
    #isStillCurrent(room) {
        const current = room.getCurrentPlayer();
        return current instanceof AIPlayer && current.key === this.key;
    }

    /**
     * Executes the current turn action (pass, play, or draw).
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async #performTurnAction(room) {
        if (this.drawAllowance <= 0) {
            await room.passTurn(this.name);
            return;
        }

        const card = this.#selectBestCard(room);
        if (card !== null) {
            await room.discardCard(this.name, card.value, card.suit);
        } else {
            await room.drawCards(this.name);
        }
    }

    /**
     * Picks the best legal card using a scoring system.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {import("./Card.js").Card|null} Best card or null if none legal.
     */
    #selectBestCard(room) {
        const legalCards = this.#getPlayableCards(room);
        if (legalCards.length === 0) return null;

        if (this.#shouldAcceptDrawTwo(room, legalCards)) return null;

        const isUnderAttack = this.drawAllowance > 1;
        const scored = legalCards.map((card, index) => ({
            card,
            score: this.#calculateCardPriority(room, card, isUnderAttack, index, legalCards.length)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored[0].card;
    }

    /**
     * Gets all legal cards in hand.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {import("./Card.js").Card[]} Array of legal cards.
     */
    #getPlayableCards(room) {
        const top = room.getTopDiscard();
        const declared = room.declaredSuit;
        const allowance = this.drawAllowance;
        const legal = [];

        for (const card of this.hand.cards) {
            const isUnusedAceOfSpades = card.isAceOfSpades() && allowance === 1;

            if (!isUnusedAceOfSpades && card.isLegalOn(top, declared, allowance)) {
                legal.push(card);
            }
        }

        return legal;
    }

    /**
     * Determines whether accepting a draw-two penalty is safer than spending the ace of spades.
     *
     * The AI accepts the penalty only when the ace of spades is its sole response and the next
     * player has one card that cannot finish the game.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card[]} playableCards - Cards the AI may legally discard.
     * @returns {boolean} True when the AI should draw instead of defending.
     */
    #shouldAcceptDrawTwo(room, playableCards) {
        const isAceOfSpadesOnlyDefense = this.drawAllowance === 2 && playableCards.length === 1 && playableCards[0].isAceOfSpades();

        if (isAceOfSpadesOnlyDefense) {
            const nextPlayer = room.circle.getRelativePlayer(1);

            if (nextPlayer !== null && nextPlayer.hand.cards.length === 1) {
                const nextCard = nextPlayer.hand.cards[0];

                return !nextCard.isLegalOn(room.getTopDiscard(), room.declaredSuit, 1);
            }
        }

        return false;
    }

    /**
     * Scores a card based on AI strategy.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Card to score.
     * @param {boolean} isUnderAttack - Whether player is being attacked.
     * @param {number} index - Index in legal cards array.
     * @param {number} totalLegal - Total number of legal cards.
     * @returns {number} Card score.
     */
    #calculateCardPriority(room, card, isUnderAttack, index, totalLegal) {
        const hasOtherOptions = index < totalLegal - 1;
        let score = card.score;

        if (this.#blocksNextPlayersFinalCard(room, card, totalLegal)) {
            score += AIPlayer.#PRIORITY_HIGH;
        }

        // Draw cards (2s, Jokers)
        if (card.isDrawCard()) {
            if (isUnderAttack) {
                score += AIPlayer.#PRIORITY_HIGH;
            } else if (hasOtherOptions) {
                score += AIPlayer.#PENALTY_AVOID;
            }
        }

        // Ace of Spades - defensive shield
        if (card.isAceOfSpades()) {
            if (isUnderAttack) {
                score += this.#isDrawCardPresent() ? AIPlayer.#PRIORITY_MEDIUM : AIPlayer.#PRIORITY_HIGH;
            } else if (hasOtherOptions) {
                score += AIPlayer.#PENALTY_STRONG_AVOID;
            } else {
                score += AIPlayer.#PENALTY_LAST_RESORT;
            }
        }

        // Other Aces (suit changers)
        if (card.isAce() && !card.isAceOfSpades() && hasOtherOptions) {
            score += AIPlayer.#PENALTY_ACE;
        }

        // Skip/Reverse cards (8s, Jacks)
        const playerCount = room.circle.getPlayerCount();
        if (card.isSkip(playerCount) || card.isReverse(playerCount)) {
            score += AIPlayer.#PRIORITY_LOW;
        }

        // End game cards (7 of Hearts, last card)
        if (card.isEndGameCard()) {
            score = this.#calculateGameEndingPriority(room, card);
        }

        return score;
    }

    /**
     * Checks whether a candidate discard prevents the next player from playing their final card.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {number} playableCardCount - Number of legal choices available to the AI.
     * @returns {boolean} True when the candidate blocks the next player's sole card.
     */
    #blocksNextPlayersFinalCard(room, card, playableCardCount) {
        let isBlocked = false;

        if (playableCardCount > 1) {
            const nextPlayer = room.circle.getRelativePlayer(1);

            if (nextPlayer !== null && nextPlayer.hand.cards.length === 1) {
                const nextCard = nextPlayer.hand.cards[0];
                const nextDrawAllowance = card.isDrawFour() ? 4 : (card.isDrawTwo() ? 2 : 1);
                const declaredSuit = card.isSuitChange() ? this.#selectBestSuit() : null;

                isBlocked = !nextCard.isLegalOn(card, declaredSuit, nextDrawAllowance);
            }
        }

        return isBlocked;
    }

    /**
     * Checks if player has any draw cards in hand.
     * @returns {boolean} True if player has a draw card.
     */
    #isDrawCardPresent() {
        for (const card of this.hand.cards) {
            if (card.isDrawCard()) return true;
        }
        return false;
    }

    /**
     * Scores a game-ending card.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Card to score.
     * @returns {number} Card score.
     */
    #calculateGameEndingPriority(room, card) {
        if (this.hand.cards.length > 5) return AIPlayer.#SCORE_NEVER;

        const myScoreAfter = this.hand.score - card.score;
        const lowestOpponent = this.#getLowestOpponentScore(room);

        if (myScoreAfter < lowestOpponent) {
            return AIPlayer.#SCORE_WIN;
        }

        if (this.hand.cards.length === 1) {
            return AIPlayer.#SCORE_WIN;
        }

        return AIPlayer.#SCORE_NEVER;
    }

    /**
     * Gets the lowest hand score among all opponents.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {number} Lowest opponent score.
     */
    #getLowestOpponentScore(room) {
        let lowest = Infinity;
        for (const player of room.circle.players.values()) {
            if (player.key !== this.key) {
                lowest = Math.min(lowest, player.hand.score);
            }
        }
        return lowest;
    }

    /**
     * Chooses and submits a suit for wild cards.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async chooseSuit(room) {
        await this.#waitForTurnDelay();
        if (this.#isStillCurrent(room)) {
            await room.declareSuit(this.#selectBestSuit());
        }
    }

    /**
     * Chooses the best suit based on hand composition.
     *
     * @returns {string} Selected suit.
     */
    #selectBestSuit() {
        const counts = this.#countCardsBySuit();
        for (const card of this.hand.cards) {
            if (counts[card.suit] !== undefined) {
                counts[card.suit] += 1;
            }
        }
        return this.#getMostCommonSuit(counts);
    }

    /**
     * Creates a suit count object initialized to zero.
     *
     * @returns {Object<string, number>} Suit counts.
     */
    #countCardsBySuit() {
        return {
            [Constants.CARD.SUIT.HEARTS]: 0,
            [Constants.CARD.SUIT.DIAMONDS]: 0,
            [Constants.CARD.SUIT.CLUBS]: 0,
            [Constants.CARD.SUIT.SPADES]: 0
        };
    }

    /**
     * Gets the suit with the highest count.
     *
     * @param {Object<string, number>} counts - Suit counts.
     * @returns {string} Selected suit.
     */
    #getMostCommonSuit(counts) {
        let selected = Constants.CARD.SUIT.HEARTS;
        let highest = -1;

        for (const [suit, count] of Object.entries(counts)) {
            if (count > highest) {
                selected = suit;
                highest = count;
            }
        }

        return selected;
    }
}
