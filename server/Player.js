// server/Player.js

"use strict";

import { Constants } from "../public/scripts/Constants.js";
import { Deck } from "./Deck.js";
import { Hand } from "./Hand.js";
import { UserNotification } from "./UserNotification.js";
import { Serializable } from "./Serializable.js";
import { TurnUtils } from "../public/scripts/utils/TurnUtils.js";

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
    static #PRIORITY_ELEVATED = 1000;
    static #PRIORITY_LOW = 100;
    static #PENALTY_AVOID = -5000;
    static #PENALTY_STRONG_AVOID = -8000;
    static #PENALTY_LAST_RESORT = -1000;
    static #PENALTY_ACE = -3000;
    static #LOWEST_ORDINARY_RANK = Constants.CARD.VALUE.THREE.rank;
    static #MIN_END_GAME_WIN_PROBABILITY = 0.7;

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
     * Checks whether this AI is still the turn owner.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {boolean} True if this AI is current.
     */
    #isStillCurrent(room) {
        return TurnUtils.isTurnOwner(room.circle.turnOwnerKey, this.key);
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
        } else {
            const card = this.#selectBestCard(room);

            if (card !== null) {
                await room.discardCard(this.name, card.value, card.suit);
            } else {
                await room.drawCards(this.name);
            }
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
        let selectedCard = null;

        if (legalCards.length > 0) {
            const unseenCards = this.#getUnseenCards(room);
            const selectableCards = !this.#hasRelevantCriticalThreat(room, legalCards) && legalCards.some(card => !card.isAce())
                ? legalCards.filter(card => !card.isAce())
                : legalCards;
            const isUnderAttack = this.drawAllowance > 1;
            const scored = selectableCards.map(card => ({
                card,
                score: this.#calculateCardPriority(room, card, isUnderAttack, selectableCards.length, unseenCards)
            }));

            scored.sort((a, b) => b.score - a.score);

            if (scored[0].score > AIPlayer.#SCORE_NEVER) {
                selectedCard = scored[0].card;
            }
        }

        return selectedCard;
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
     * Gets cards that could still be outside the AI's hand and current discard pile.
     *
     * Cards recycled from an old discard pile correctly become unseen again, which is why
     * persistent per-player discard memory would produce inaccurate card counts.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {import("./Card.js").Card[]} Unseen cards.
     */
    #getUnseenCards(room) {
        const knownCardIds = new Set();
        const discardPile = Array.isArray(room.discardPile) ? room.discardPile : [];

        for (const card of this.hand.cards) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        for (const card of discardPile) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        const fullDeck = new Deck(false);
        const unseenCards = [];

        for (const card of fullDeck.cards) {
            if (!knownCardIds.has(card.getId())) {
                unseenCards.push(card);
            }
        }

        return unseenCards;
    }

    /**
     * Scores a card based on AI strategy.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Card to score.
     * @param {boolean} isUnderAttack - Whether player is being attacked.
     * @param {number} totalLegal - Total number of legal cards.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Card score.
     */
    #calculateCardPriority(room, card, isUnderAttack, totalLegal, unseenCards) {
        const hasOtherOptions = totalLegal > 1;
        let score = card.score;

        score += this.#calculateOpponentPressurePriority(room, card, totalLegal, unseenCards);
        score += this.#calculateHandSetupPriority(room, card, unseenCards);

        if (this.#pressesInferredEmptySuit(room, card)) {
            score += AIPlayer.#PRIORITY_MEDIUM;
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
        const playerCount = room.circle.players.size;
        if (card.isSkip(playerCount) || card.isReverse(playerCount)) {
            score += AIPlayer.#PRIORITY_LOW;
        }

        // End game cards (7 of Hearts, last card)
        if (card.isEndGameCard()) {
            score = this.#calculateGameEndingPriority(room, card, unseenCards);
        }

        return score;
    }

    /**
     * Scores how safely a candidate controls the projected opponent.
     *
     * The projected actor accounts for skips and reverses. Only visible hand counts are used:
     * the AI never reads an opponent's card identities or hand score. Publicly known cards
     * refine the probability that the projected opponent can legally respond.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {number} playableCardCount - Number of legal choices available to the AI.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Strategy score adjustment.
     */
    #calculateOpponentPressurePriority(room, card, playableCardCount, unseenCards) {
        let priority = 0;

        if (playableCardCount > 1 && room.circle !== undefined) {
            const immediatePlayer = room.circle.getRelativePlayer(1);
            const projectedPlayer = this.#getPlayerAfterCandidate(room, card);
            const immediateDanger = this.#calculateOpponentDanger(immediatePlayer);
            const projectedDanger = this.#calculateOpponentDanger(projectedPlayer);
            const isRerouted = immediatePlayer?.key !== projectedPlayer?.key;

            if (isRerouted) {
                priority += immediateDanger - projectedDanger;
            }

            if (projectedDanger > 0 && projectedPlayer !== null) {
                const responseProbability = this.#calculateLegalResponseProbability(
                    room,
                    card,
                    projectedPlayer.hand.cards.length,
                    unseenCards
                );

                if (card.isDrawCard()) {
                    priority += Math.round(
                        projectedDanger * (1 - (2 * responseProbability))
                    );
                } else if (card.isSuitChange()) {
                    priority += Math.round(
                        projectedDanger * (0.5 - responseProbability)
                    );
                } else {
                    priority -= Math.round(
                        projectedDanger * responseProbability
                    );
                }
            }
        }

        return priority;
    }

    /**
     * Assigns urgency from an opponent's visible hand count.
     *
     * @param {Player|null} player - Projected opponent.
     * @returns {number} Danger priority.
     */
    #calculateOpponentDanger(player) {
        let danger = 0;

        if (player !== null && player.key !== this.key) {
            const cardCount = player.hand.cards.length;

            if (cardCount === 1) {
                danger = AIPlayer.#PRIORITY_HIGH;
            } else if (cardCount === 2) {
                danger = AIPlayer.#PRIORITY_MEDIUM;
            } else if (cardCount === 3) {
                danger = AIPlayer.#PRIORITY_ELEVATED;
            } else if (cardCount > 3) {
                danger = AIPlayer.#PRIORITY_LOW;
            }
        }

        return danger;
    }

    /**
     * Rewards plays that keep the AI's remaining hand connected.
     *
     * A two-player skip that returns an immediately playable final card to the AI receives
     * the strongest setup bonus.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Setup priority.
     */
    #calculateHandSetupPriority(room, card, unseenCards) {
        const remainingCards = this.hand.cards.filter(heldCard => heldCard !== card);
        let priority = 0;

        if (remainingCards.length > 0) {
            const declaredSuit = card.isSuitChange()
                ? this.#selectBestSuit(room, card, unseenCards)
                : null;
            let continuationCount = 0;

            for (const remainingCard of remainingCards) {
                const isUnusedAceOfSpades = remainingCard.isAceOfSpades();

                if (!isUnusedAceOfSpades && remainingCard.isLegalOn(card, declaredSuit, 1)) {
                    continuationCount += 1;
                }
            }

            priority += Math.round(
                AIPlayer.#PRIORITY_LOW * continuationCount / remainingCards.length
            );

            const projectedPlayer = this.#getPlayerAfterCandidate(room, card);
            const createsImmediateFinish = projectedPlayer?.key === this.key &&
                remainingCards.length === 1 &&
                continuationCount === 1;

            if (createsImmediateFinish) {
                priority += AIPlayer.#PRIORITY_HIGH;
            }
        }

        return priority;
    }

    /**
     * Estimates whether a projected opponent has at least one legal response.
     *
     * This is a hypergeometric estimate over unseen cards. It uses the opponent's public card
     * count, but never accesses the contents of that hand.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {number} cardCount - Visible opponent card count.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Probability from zero through one.
     */
    #calculateLegalResponseProbability(room, card, cardCount, unseenCards) {
        let probability = 0;

        if (cardCount > 0 && unseenCards.length > 0) {
            const drawAllowance = card.isDrawFour() ? 4 : (card.isDrawTwo() ? 2 : 1);
            const declaredSuit = card.isSuitChange()
                ? this.#selectBestSuit(room, card, unseenCards)
                : null;
            let legalCardCount = 0;

            for (const unseenCard of unseenCards) {
                if (unseenCard.isLegalOn(card, declaredSuit, drawAllowance)) {
                    legalCardCount += 1;
                }
            }

            if (legalCardCount > 0) {
                const sampleCount = Math.min(cardCount, unseenCards.length);
                const illegalCardCount = unseenCards.length - legalCardCount;
                let noLegalCardProbability = 1;

                for (let index = 0; index < sampleCount; index += 1) {
                    const remainingIllegalCards = illegalCardCount - index;
                    const remainingCards = unseenCards.length - index;

                    if (remainingIllegalCards > 0) {
                        noLegalCardProbability *= remainingIllegalCards / remainingCards;
                    } else {
                        noLegalCardProbability = 0;
                    }
                }

                probability = 1 - noLegalCardProbability;
            }
        }

        return probability;
    }

    /**
     * Gets the player who would act after a candidate card resolves.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {Player|null} Projected next actor.
     */
    #getPlayerAfterCandidate(room, card) {
        const playerCount = room.circle.players.size;
        let player;

        if (card.isSkip(playerCount)) {
            player = room.circle.getRelativePlayer(2);
        } else if (card.isReverse(playerCount)) {
            player = room.circle.getRelativePlayer(-1);
        } else {
            player = room.circle.getRelativePlayer(1);
        }

        return player;
    }

    /**
     * Checks whether a one- or two-card opponent can act after a legal candidate.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card[]} legalCards - Candidate legal cards.
     * @returns {boolean} True when a critical opponent exists.
     */
    #hasRelevantCriticalThreat(room, legalCards) {
        let hasThreat = false;

        if (room.circle !== undefined) {
            hasThreat = this.#isCriticalOpponent(room.circle.getRelativePlayer(1));

            for (const card of legalCards) {
                if (!hasThreat && this.#isCriticalOpponent(this.#getPlayerAfterCandidate(room, card))) {
                    hasThreat = true;
                }
            }
        }

        return hasThreat;
    }

    /**
     * Checks whether a player is an opponent with at most two cards.
     *
     * @param {Player|null} player - Player to inspect.
     * @returns {boolean} True when the opponent is in a critical hand state.
     */
    #isCriticalOpponent(player) {
        return player !== null &&
            player.key !== this.key &&
            player.hand.cards.length > 0 &&
            player.hand.cards.length <= 2;
    }

    /**
     * Checks whether a candidate continues the suit of a low ordinary discard.
     *
     * Playing the lowest ordinary rank suggests the previous player may have exhausted that
     * suit, so the AI presses the same suit when it has a legal choice.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {boolean} True when the inferred empty suit is continued.
     */
    #pressesInferredEmptySuit(room, card) {
        const top = room.getTopDiscard();
        const lastPlayer = typeof room.getLastDiscardPlayer === "function"
            ? room.getLastDiscardPlayer()
            : null;
        const projectedPlayer = room.circle === undefined
            ? null
            : this.#getPlayerAfterCandidate(room, card);

        return top !== null &&
            lastPlayer !== null &&
            projectedPlayer !== null &&
            lastPlayer.key !== this.key &&
            projectedPlayer.key === lastPlayer.key &&
            !top.isSpecial() &&
            top.getRank() === AIPlayer.#LOWEST_ORDINARY_RANK &&
            card.suit === top.suit;
    }

    /**
     * Checks if player has any draw cards in hand.
     * @returns {boolean} True if player has a draw card.
     */
    #isDrawCardPresent() {
        return this.hand.cards.some(card => card.isDrawCard());
    }

    /**
     * Scores a game-ending card from public information.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate game-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Card score.
     */
    #calculateGameEndingPriority(room, card, unseenCards) {
        let priority = AIPlayer.#SCORE_NEVER;

        if (this.hand.cards.length === 1) {
            priority = AIPlayer.#SCORE_WIN;
        } else if (this.#hasEndGameCardCountAdvantage(room)) {
            const winProbability = this.#calculateEndGameWinProbability(room, card, unseenCards);

            if (winProbability >= AIPlayer.#MIN_END_GAME_WIN_PROBABILITY) {
                priority = AIPlayer.#SCORE_WIN;
            }
        }

        return priority;
    }

    /**
     * Checks whether discarding one card leaves the AI with fewer cards than every opponent.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {boolean} Whether the AI has a visible card-count advantage.
     */
    #hasEndGameCardCountAdvantage(room) {
        const remainingCardCount = this.hand.cards.length - 1;
        let hasOpponent = false;
        let hasAdvantage = true;

        for (const player of room.circle.players.values()) {
            if (player.key !== this.key) {
                hasOpponent = true;

                if (player.hand.cards.length <= remainingCardCount) {
                    hasAdvantage = false;
                }
            }
        }

        return hasOpponent && hasAdvantage;
    }

    /**
     * Estimates the chance that the AI's remaining score ties or beats every opponent.
     *
     * Opponent hands are treated as random samples from unseen cards. Individual opponent
     * estimates are combined conservatively without inspecting any hidden card or score.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate game-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Estimated probability from zero through one.
     */
    #calculateEndGameWinProbability(room, card, unseenCards) {
        const remainingScore = this.hand.score - card.score;
        let winProbability = 1;

        for (const player of room.circle.players.values()) {
            if (player.key !== this.key) {
                const opponentProbability = this.#calculateScoreAtLeastProbability(remainingScore, player.hand.cards.length, unseenCards);
                winProbability *= opponentProbability;
            }
        }

        return winProbability;
    }

    /**
     * Calculates the chance that a random hand from unseen cards reaches a score.
     *
     * @param {number} targetScore - Score the sampled hand must meet or exceed.
     * @param {number} cardCount - Visible number of cards in the sampled hand.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Probability from zero through one.
     */
    #calculateScoreAtLeastProbability(targetScore, cardCount, unseenCards) {
        let probability = 0;

        if (targetScore <= 0) {
            probability = 1;
        } else if (cardCount > 0 && unseenCards.length > 0) {
            const sampleCount = Math.min(cardCount, unseenCards.length);
            const combinationCounts = Array.from(
                { length: sampleCount + 1 },
                () => new Map()
            );

            combinationCounts[0].set(0, 1);

            let processedCardCount = 0;

            for (const unseenCard of unseenCards) {
                const maximumSampleSize = Math.min(sampleCount, processedCardCount + 1);

                for (let sampleSize = maximumSampleSize; sampleSize > 0; sampleSize -= 1) {
                    const previousCounts = combinationCounts[sampleSize - 1];
                    const currentCounts = combinationCounts[sampleSize];

                    for (const [score, count] of previousCounts) {
                        const nextScore = score + unseenCard.score;
                        const previousCount = currentCounts.get(nextScore) ?? 0;

                        currentCounts.set(nextScore, previousCount + count);
                    }
                }

                processedCardCount += 1;
            }

            let totalCombinationCount = 0;
            let favorableCombinationCount = 0;

            for (const [score, count] of combinationCounts[sampleCount]) {
                totalCombinationCount += count;

                if (score >= targetScore) {
                    favorableCombinationCount += count;
                }
            }

            if (totalCombinationCount > 0) {
                probability = favorableCombinationCount / totalCombinationCount;
            }
        }

        return probability;
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
            const unseenCards = this.#getUnseenCards(room);

            await room.declareSuit(this.#selectBestSuit(room, null, unseenCards));
        }
    }

    /**
     * Chooses the best suit from hand strength and public card scarcity.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card|null} excludedCard - Candidate card to exclude.
     * @param {import("./Card.js").Card[]|null} unseenCards - Cards not publicly accounted for.
     * @returns {string} Selected suit.
     */
    #selectBestSuit(room, excludedCard = null, unseenCards = null) {
        const counts = this.#countCardsBySuit();
        const unseenCounts = this.#countCardsBySuit();
        const availableCards = unseenCards ?? this.#getUnseenCards(room);

        for (const card of this.hand.cards) {
            if (card === excludedCard) {
                continue;
            }

            if (counts[card.suit] !== undefined) {
                counts[card.suit] += 1;
            }
        }

        for (const card of availableCards) {
            if (unseenCounts[card.suit] !== undefined) {
                unseenCounts[card.suit] += 1;
            }
        }

        return this.#getMostStrategicSuit(counts, unseenCounts);
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
     * Gets the strongest own suit, breaking ties toward the scarcest unseen suit.
     *
     * @param {Object<string, number>} counts - Suit counts.
     * @param {Object<string, number>} unseenCounts - Unseen suit counts.
     * @returns {string} Selected suit.
     */
    #getMostStrategicSuit(counts, unseenCounts) {
        let selected = Constants.CARD.SUIT.HEARTS;
        let highest = -1;
        let lowestUnseen = Infinity;

        for (const [suit, count] of Object.entries(counts)) {
            const unseenCount = unseenCounts[suit];
            const isStrongerSuit = count > highest;
            const isSaferTie = count === highest && unseenCount < lowestUnseen;

            if (isStrongerSuit || isSaferTie) {
                selected = suit;
                highest = count;
                lowestUnseen = unseenCount;
            }
        }

        return selected;
    }
}
