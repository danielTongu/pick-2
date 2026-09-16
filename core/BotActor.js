"use strict";

import { Constants } from "./Constants.js";
import { CardCollection } from "./CardCollection.js";
import { Actor } from "./Actor.js";
import { TurnUtils } from "./TurnUtils.js";

/** Automated actor that chooses legal moves from private hand data and public room state. */
export class BotActor extends Actor {
    // bot Scoring Constants
    /** @type {number} Sentinel score for a move that guarantees the round win. */
    static #SCORE_WIN = Infinity;

    /** @type {number} Sentinel score for a candidate that must not be selected. */
    static #SCORE_NEVER = -Infinity;

    /** @type {number} Strong tactical priority bonus. */
    static #PRIORITY_HIGH = 10000;

    /** @type {number} Medium tactical priority bonus. */
    static #PRIORITY_MEDIUM = 5000;

    /** @type {number} Elevated tactical priority bonus. */
    static #PRIORITY_ELEVATED = 1000;

    /** @type {number} Small tactical priority bonus. */
    static #PRIORITY_LOW = 100;

    /** @type {number} Penalty for a strategically undesirable candidate. */
    static #PENALTY_AVOID = -5000;

    /** @type {number} Penalty for a strongly undesirable candidate. */
    static #PENALTY_STRONG_AVOID = -8000;

    /** @type {number} Penalty reserved for last-resort candidates. */
    static #PENALTY_LAST_RESORT = -1000;

    /** @type {number} Conservation penalty applied to valuable aces. */
    static #PENALTY_ACE = -3000;

    /** @type {number} Lowest natural rank considered an ordinary discard. */
    static #LOWEST_ORDINARY_RANK = Constants.CARD.VALUE.THREE.rank;

    /** @type {number} Minimum estimated win probability for releasing a round-ending card. */
    static #MIN_END_GAME_WIN_PROBABILITY = 0.7;

    /**
     * Creates a bot actor.
     *
     * @param {string} name - Bot actor name.
     * @throws {Error} When the bot name is not a valid actor identity.
     */
    constructor(name) {
        super(name, { drawAllowance: 1 });
    }

    /** Waits, revalidates ownership, and performs one bot turn. */
    async takeTurn(room) {
        await this._waitForTurnDelay();
        if (this._isTurnOwner(room)) await this._takeTurn(room);
    }

    /** Returns whether this bot still owns the supplied room's turn. */
    _isTurnOwner(room) {
        return TurnUtils.isTurnOwner(room.turnOrder.ownerKey, this.key);
    }

    /** Waits for a randomized human-like delay. */
    async _waitForTurnDelay() {
        const range = Constants.AUTOMATED_ACTOR_DELAY_MAX_MS - Constants.AUTOMATED_ACTOR_DELAY_MIN_MS + 1;
        const delay = Constants.AUTOMATED_ACTOR_DELAY_MIN_MS + Math.floor(Math.random() * range);
        await new Promise(function wait(resolve) {
            setTimeout(resolve, delay);
        });
    }

    /**
     * Executes a bot turn.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async _takeTurn(room) {
        await this.#performTurnAction(room);
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
                await room.playItem(this.name, card.value, card.suit);
            } else {
                await room.drawItems(this.name);
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
            let selectableCards = legalCards;

            if (!this.#hasRelevantCriticalThreat(room, legalCards)) {
                const nonAceCards = [];

                for (const card of legalCards) {
                    if (!card.isAce()) {
                        nonAceCards.push(card);
                    }
                }

                if (nonAceCards.length > 0) {
                    selectableCards = nonAceCards;
                }
            }
            const isUnderAttack = this.drawAllowance > 1;
            const scored = [];

            for (const card of selectableCards) {
                scored.push({
                    card,
                    score: this.#calculateCardPriority(room, card, isUnderAttack, selectableCards.length, unseenCards)
                });
            }

            scored.sort(function compareScores(left, right) {
                return right.score - left.score;
            });

            if (scored[0].score > BotActor.#SCORE_NEVER) {
                selectedCard = scored[0].card;
            }
        }

        return selectedCard;
    }

    /**
     * Returns every hand card legal against the current room state.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {import("./Card.js").Card[]} Array of legal cards.
     */
    #getPlayableCards(room) {
        const top = room.getTopItem();
        const declared = room.declaredSuit;
        const allowance = this.drawAllowance;
        const legal = [];

        for (const card of this.collection.items) {
            const isUnusedAceOfSpades = card.isAceOfSpades() && allowance === 1;

            if (!isUnusedAceOfSpades && card.isLegalOn(top, declared, allowance)) {
                legal.push(card);
            }
        }

        return legal;
    }

    /**
     * Reconstructs unseen cards from the canonical deck and public information only.
     *
     * Cards recycled from an old discard pile correctly become unseen again, which is why
     * persistent per-actor discard memory would produce inaccurate card counts.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {import("./Card.js").Card[]} Unseen cards.
     */
    #getUnseenCards(room) {
        const knownCardIds = new Set();
        const playedItems = room.collections?.play?.items;
        const visiblePlayedItems = Array.isArray(playedItems) ? playedItems : [];

        for (const card of this.collection.items) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        for (const card of visiblePlayedItems) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        const fullDeck = CardCollection.createDeck(false);
        const unseenCards = [];

        for (const card of fullDeck.items) {
            if (!knownCardIds.has(card.id)) {
                unseenCards.push(card);
            }
        }

        return unseenCards;
    }

    /**
     * Scores a card based on bot strategy.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Card to score.
     * @param {boolean} isUnderAttack - Whether actor is being attacked.
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
            score += BotActor.#PRIORITY_MEDIUM;
        }

        // Draw cards (2s, Jokers)
        if (card.isDrawCard()) {
            if (isUnderAttack) {
                score += BotActor.#PRIORITY_HIGH;
            } else if (hasOtherOptions) {
                score += BotActor.#PENALTY_AVOID;
            }
        }

        // Ace of Spades - defensive shield
        if (card.isAceOfSpades()) {
            if (isUnderAttack) {
                score += this.#isDrawCardPresent() ? BotActor.#PRIORITY_MEDIUM : BotActor.#PRIORITY_HIGH;
            } else if (hasOtherOptions) {
                score += BotActor.#PENALTY_STRONG_AVOID;
            } else {
                score += BotActor.#PENALTY_LAST_RESORT;
            }
        }

        // Other Aces (suit changers)
        if (card.isAce() && !card.isAceOfSpades() && hasOtherOptions) {
            score += BotActor.#PENALTY_ACE;
        }

        // Skip/Reverse cards (8s, Jacks)
        const actorCount = room.turnOrder.actors.size;
        if (card.isSkip(actorCount) || card.isReverse(actorCount)) {
            score += BotActor.#PRIORITY_LOW;
        }

        // Round-ending cards (7 of Hearts, last card)
        if (card.isRoundEndingCard()) {
            score = this.#calculateRoundEndingPriority(room, card, unseenCards);
        }

        return score;
    }

    /**
     * Scores how safely a candidate controls the projected opponent.
     *
     * The projected actor accounts for skips and reverses. Only visible hand counts are used:
     * the bot never reads an opponent's card identities or hand score. Publicly known cards
     * refine the probability that the projected opponent can legally respond.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {number} playableCardCount - Number of legal choices available to the bot.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Strategy score adjustment.
     */
    #calculateOpponentPressurePriority(room, card, playableCardCount, unseenCards) {
        let priority = 0;

        if (playableCardCount > 1 && room.turnOrder !== undefined) {
            const immediateActor = room.turnOrder.relative(1);
            const projectedActor = this.#getActorAfterCandidate(room, card);
            const immediateDanger = this.#calculateOpponentDanger(immediateActor);
            const projectedDanger = this.#calculateOpponentDanger(projectedActor);
            const isRerouted = immediateActor?.key !== projectedActor?.key;

            if (isRerouted) {
                priority += immediateDanger - projectedDanger;
            }

            if (projectedDanger > 0 && projectedActor !== null) {
                const responseProbability = this.#calculateLegalResponseProbability(
                    room,
                    card,
                    projectedActor.collection.items.length,
                    unseenCards
                );

                if (card.isDrawCard()) {
                    priority += Math.round(projectedDanger * (1 - 2 * responseProbability));
                } else if (card.isSuitChange()) {
                    priority += Math.round(projectedDanger * (0.5 - responseProbability));
                } else {
                    priority -= Math.round(projectedDanger * responseProbability);
                }
            }
        }

        return priority;
    }

    /**
     * Assigns urgency from an opponent's visible hand count.
     *
     * @param {Actor|null} actor - Projected opponent.
     * @returns {number} Danger priority.
     */
    #calculateOpponentDanger(actor) {
        let danger = 0;

        if (actor !== null && actor.key !== this.key) {
            const cardCount = actor.collection.items.length;

            if (cardCount === 1) {
                danger = BotActor.#PRIORITY_HIGH;
            } else if (cardCount === 2) {
                danger = BotActor.#PRIORITY_MEDIUM;
            } else if (cardCount === 3) {
                danger = BotActor.#PRIORITY_ELEVATED;
            } else if (cardCount > 3) {
                danger = BotActor.#PRIORITY_LOW;
            }
        }

        return danger;
    }

    /**
     * Rewards plays that keep the bot's remaining hand connected.
     *
     * A two-actor skip that returns an immediately playable final card to the bot receives
     * the strongest setup bonus.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Setup priority.
     */
    #calculateHandSetupPriority(room, card, unseenCards) {
        const remainingCards = [];

        for (const heldCard of this.collection.items) {
            if (heldCard !== card) {
                remainingCards.push(heldCard);
            }
        }
        let priority = 0;

        if (remainingCards.length > 0) {
            const declaredSuit = card.isSuitChange() ? this.#selectBestSuit(room, card, unseenCards) : null;
            let continuationCount = 0;

            for (const remainingCard of remainingCards) {
                const isUnusedAceOfSpades = remainingCard.isAceOfSpades();

                if (!isUnusedAceOfSpades && remainingCard.isLegalOn(card, declaredSuit, 1)) {
                    continuationCount += 1;
                }
            }

            priority += Math.round((BotActor.#PRIORITY_LOW * continuationCount) / remainingCards.length);

            const projectedActor = this.#getActorAfterCandidate(room, card);
            const createsImmediateFinish =
                projectedActor?.key === this.key && remainingCards.length === 1 && continuationCount === 1;

            if (createsImmediateFinish) {
                priority += BotActor.#PRIORITY_HIGH;
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
            const drawAllowance = card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1;
            const declaredSuit = card.isSuitChange() ? this.#selectBestSuit(room, card, unseenCards) : null;
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
     * Predicts the next actor after applying a candidate’s skip or reverse effect.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {Actor|null} Projected next actor.
     */
    #getActorAfterCandidate(room, card) {
        const actorCount = room.turnOrder.actors.size;
        let actor;

        if (card.isSkip(actorCount)) {
            actor = room.turnOrder.relative(2);
        } else if (card.isReverse(actorCount)) {
            actor = room.turnOrder.relative(-1);
        } else {
            actor = room.turnOrder.relative(1);
        }

        return actor;
    }

    /**
     * Returns whether any immediate low-card opponent remains a relevant threat.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card[]} legalCards - Candidate legal cards.
     * @returns {boolean} True when a critical opponent exists.
     */
    #hasRelevantCriticalThreat(room, legalCards) {
        let hasThreat = false;

        if (room.turnOrder !== undefined) {
            hasThreat = this.#isCriticalOpponent(room.turnOrder.relative(1));

            for (const card of legalCards) {
                if (!hasThreat && this.#isCriticalOpponent(this.#getActorAfterCandidate(room, card))) {
                    hasThreat = true;
                }
            }
        }

        return hasThreat;
    }

    /**
     * Returns whether an actor is an opposing one- or two-card threat.
     *
     * @param {Actor|null} actor - Actor to inspect.
     * @returns {boolean} True when the opponent is in a critical hand state.
     */
    #isCriticalOpponent(actor) {
        return (
            actor !== null &&
            actor.key !== this.key &&
            actor.collection.items.length > 0 &&
            actor.collection.items.length <= 2
        );
    }

    /**
     * Detects whether a candidate pressures an opponent’s inferred weak suit.
     *
     * Playing the lowest ordinary rank suggests the previous actor may have exhausted that
     * suit, so the bot presses the same suit when it has a legal choice.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {boolean} True when the inferred empty suit is continued.
     */
    #pressesInferredEmptySuit(room, card) {
        const top = room.getTopItem();
        const lastActor = typeof room.getLastDiscardActor === "function" ? room.getLastDiscardActor() : null;
        const projectedActor = room.turnOrder === undefined ? null : this.#getActorAfterCandidate(room, card);

        return (
            top !== null &&
            lastActor !== null &&
            projectedActor !== null &&
            lastActor.key !== this.key &&
            projectedActor.key === lastActor.key &&
            !top.isSpecial() &&
            top.rank === BotActor.#LOWEST_ORDINARY_RANK &&
            card.suit === top.suit
        );
    }

    /**
     * Returns whether this bot can extend an active draw attack.
     * @returns {boolean} True if actor has a draw card.
     */
    #isDrawCardPresent() {
        for (const card of this.collection.items) {
            if (card.isDrawCard()) {
                return true;
            }
        }

        return false;
    }

    /**
     * Scores a room-ending card from public information.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate room-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Card score.
     */
    #calculateRoundEndingPriority(room, card, unseenCards) {
        let priority = BotActor.#SCORE_NEVER;

        if (this.collection.items.length === 1) {
            priority = BotActor.#SCORE_WIN;
        } else if (this.#hasRoundEndCardCountAdvantage(room)) {
            const winProbability = this.#calculateRoundEndWinProbability(room, card, unseenCards);

            if (winProbability >= BotActor.#MIN_END_GAME_WIN_PROBABILITY) {
                priority = BotActor.#SCORE_WIN;
            }
        }

        return priority;
    }

    /**
     * Returns whether one discard gives this bot the strict lowest visible card count.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {boolean} Whether the bot has a visible card-count advantage.
     */
    #hasRoundEndCardCountAdvantage(room) {
        const remainingCardCount = this.collection.items.length - 1;
        let hasOpponent = false;
        let hasAdvantage = true;

        for (const actor of room.turnOrder.actors.values()) {
            if (actor.key !== this.key) {
                hasOpponent = true;

                if (actor.collection.items.length <= remainingCardCount) {
                    hasAdvantage = false;
                }
            }
        }

        return hasOpponent && hasAdvantage;
    }

    /**
     * Estimates the chance that the bot's remaining score ties or beats every opponent.
     *
     * Opponent hands are treated as random samples from unseen cards. Individual opponent
     * estimates are combined conservatively without inspecting any hidden card or score.
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @param {import("./Card.js").Card} card - Candidate room-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Estimated probability from zero through one.
     */
    #calculateRoundEndWinProbability(room, card, unseenCards) {
        const remainingScore = this.collection.score - card.score;
        let winProbability = 1;

        for (const actor of room.turnOrder.actors.values()) {
            if (actor.key !== this.key) {
                const opponentProbability = this.#calculateScoreAtLeastProbability(
                    remainingScore,
                    actor.collection.items.length,
                    unseenCards
                );
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
            const combinationCounts = [];

            for (let index = 0; index <= sampleCount; index += 1) {
                combinationCounts.push(new Map());
            }

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
        await this._waitForTurnDelay();
        if (this._isTurnOwner(room)) {
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

        for (const card of this.collection.items) {
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
     * Chooses the strongest held suit and breaks ties using public unseen-card scarcity.
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
