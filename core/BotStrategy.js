"use strict";

import {Constants} from "./Constants.js";
import {CardCollection} from "./CardCollection.js";
import {CardOdds} from "./CardOdds.js";

/**
 * @typedef {Object} StrategyPlayer
 * @property {string} key - Stable player identity.
 * @property {number} cardCount - Visible hand size.
 * @property {CardCollection|null} hand - Copied reachable hand, or null for count-only knowledge.
 */

/** Shared tactical scales and conservation costs; card rank measures penalty shed directly. */
const SCORE = Object.freeze({
    WIN: Infinity,
    REJECT: -Infinity,
    URGENT: 10000,
    STRONG: 5000,
    MODERATE: 1000,
    CONTINUATION: 100,
    KEEP_DRAW_CARD: -5000,
    ATTACK_OPPORTUNITY: 6000,
    KEEP_SHIELD: -8000,
    SHIELD_FALLBACK: -1000,
    KEEP_ACE: -3000,
    MINIMUM_WIN_CHANCE: 0.7
});

/** Chooses cards that shed the bot's penalty while denying opponents an easy response. */
export class BotStrategy {

    /** @type {string} Acting bot identity. */
    key;

    /** @type {CardCollection} Copied bot hand for this decision. */
    hand;

    /** @type {number} Bot hand penalty before playing. */
    penalty;

    /** @type {number} Current draw allowance or pending attack. */
    drawAllowance;

    /** @type {import("./Card.js").Card[]} Copied public discard collection. */
    play;

    /** @type {import("./Card.js").Card|null} Current top discard. */
    top;

    /** @type {string|null} Active declared suit. */
    declaredSuit;

    /** @type {StrategyPlayer[]} Player snapshots with reachable hands and other hand counts. */
    players;

    /** @type {StrategyPlayer[]} Player snapshots ordered relative to the bot. */
    turnPlayers;

    /** @type {number} Number of seated players. */
    playerCount;

    /** @type {StrategyPlayer|null} Next player in the current direction. */
    nextPlayer;

    /** @type {StrategyPlayer|null} Player responsible for the last discard. */
    lastDiscardPlayer;

    // ---- Public decisions ----

    /**
     * Copies the bot hand, reachable next-player hands, public discards, and turn positions.
     * Other players retain count-only summaries; the draw collection is never inspected.
     * @param {import("./BotPlayer.js").BotPlayer} bot - Acting bot.
     * @param {import("./Room.js").Match} match - Current match.
     */
    constructor(bot, match) {
        this.key = bot.key;
        this.hand = new CardCollection(bot.collection.items);
        this.penalty = bot.collection.penalty;
        this.drawAllowance = bot.drawAllowance;
        this.play = [...(match.collections?.play?.items ?? [])];
        this.top = match.getTopItem?.() ?? null;
        this.declaredSuit = match.declaredSuit;
        this.playerCount = match.turnOrder.players.size;
        this.#capturePlayers(match);
    }

    /**
     * Collects legal cards, maps their targets, then applies strategies, and selects an action.
     *
     * @returns {import("./Card.js").Card|null} Best card or null if none legal.
     */
    selectCard() {
        const legalCards = this.hand.getLegalCards(this.top, this.declaredSuit, this.drawAllowance);
        const actions = [];
        for (const card of legalCards) {
            if (!card.isAceOfSpades() || this.#canReleaseShield()) {
                actions.push(this.#mapCardTargets(card));
            }
        }
        if (actions.length === 0) return null;

        const unseenCards = this.#unseenCards();
        let best = null;
        for (const action of actions) {
            const decision = this.#evaluateAction(action, actions.length, unseenCards);
            if (decision !== null && this.#isBetterDecision(decision, best)) best = decision;
        }
        return best?.card ?? null;
    }

    /**
     * Prefers the most common safe-held suit after evaluating both projected players.
     *
     * @param {import("./Card.js").Card|null} excludedCard - Candidate card to exclude.
     * @param {import("./Card.js").Card[]|null} unseenCards - Optional previously reconstructed unseen cards.
     * @returns {string} Selected suit.
     */
    selectSuit(excludedCard = null, unseenCards = null) {
        const card = excludedCard ?? this.top;
        const remaining = this.hand.size - (excludedCard === null ? 0 : 1);
        const action = card === null ? null : this.#mapCardTargets(card, remaining);
        return this.#chooseSuit(action, excludedCard, unseenCards ?? this.#unseenCards());
    }

    // ---- Snapshot construction ----

    /**
     * Copies player counts and reachable hands, then indexes them in relative turn order.
     * @param {import("./Room.js").Match} match - Current match; never retained by the strategy.
     */
    #capturePlayers(match) {
        const turnPlayers = Array.from({length: this.playerCount}, function relativePlayer(_, index) {
            return match.turnOrder.relative(index);
        });
        const legalCards = this.hand.getLegalCards(this.top, this.declaredSuit, this.drawAllowance);
        if (this.top?.isSuitChange() && match.pending?.playerKey === this.key) legalCards.push(this.top);
        const targets = this.#reachablePlayerKeys(turnPlayers, legalCards);

        this.players = [];
        const byKey = new Map();
        for (const player of match.turnOrder.players.values()) {
            const snapshot = {
                key: player.key,
                cardCount: player.collection.items.length,
                hand: player.key !== this.key && targets.has(player.key) ? new CardCollection(player.collection.items) : null
            };
            this.players.push(snapshot);
            byKey.set(snapshot.key, snapshot);
        }
        this.turnPlayers = turnPlayers.map(function playerSnapshot(player) {
            return byKey.get(player.key);
        });
        this.nextPlayer = this.turnPlayers[1] ?? null;
        this.lastDiscardPlayer = byKey.get(match.getLastDiscardPlayer?.()?.key) ?? null;
    }

    /**
     * Identifies the first two responding players reachable through legal plays or a pending declaration.
     * @param {Object[]} turnPlayers - Live players in relative turn order, used only during construction.
     * @param {import("./Card.js").Card[]} cards - Legal candidates and any pending declaration card.
     * @returns {Set<string>} Player identities whose hands may be copied.
     */
    #reachablePlayerKeys(turnPlayers, cards) {
        const targets = new Set();
        for (const card of cards) {
            const index = (this.#turnSteps(card) + this.playerCount) % this.playerCount;
            const target = turnPlayers[index];
            if (target === undefined || target.key === this.key) continue;
            targets.add(target.key);
            const direction = card.isReverse(this.playerCount) ? -1 : 1;
            const following = turnPlayers[(index + direction + this.playerCount) % this.playerCount];
            if (following.key !== this.key) targets.add(following.key);
        }
        return targets;
    }

    /**
     * Reconstructs unknown cards after removing the bot hand, public discards, and inspected hands.
     *
     * Cards recycled from an old discard pile correctly become unseen again, which is why
     * persistent per-player discard memory would produce inaccurate card counts.
     *
     * @returns {import("./Card.js").Card[]} Unseen cards.
     */
    #unseenCards() {
        const knownCardIds = new Set();
        const visiblePlayedItems = this.play;

        for (const card of this.hand.items) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        for (const card of visiblePlayedItems) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        for (const player of this.players) {
            if (player.hand !== null) {
                for (const card of player.hand.items) knownCardIds.add(card.id);
            }
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

    // ---- Action evaluation and comparison ----

    /**
     * Evaluates one candidate, including suit declaration, finish risk, and ace conservation.
     * @param {Object} action - Mapped legal action.
     * @param {number} choiceCount - Number of available actions.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {Object|null} Ranked decision, or null for a rejected play.
     */
    #evaluateAction(action, choiceCount, unseenCards) {
        if (action.card.isSuitChange()) {
            action.declaredSuit = this.#chooseSuit(action, action.card, unseenCards);
        }
        const score = this.#scoreCard(action, choiceCount, unseenCards);
        if (score === SCORE.REJECT) return null;

        const priority = this.drawAllowance > 1
            ? this.#defensivePriority(action, score)
            : this.#offensivePriority(action, score, unseenCards);
        return {...priority, card: action.card, wastesAce: this.#wastesAce(action)};
    }

    /**
     * Compares safety first, then conserves redundant aces and maximizes tactical value.
     * When a finish is unavoidable, penalty shedding takes precedence over conservation.
     * @param {Object} candidate - Evaluated candidate.
     * @param {Object|null} best - Current best decision.
     * @returns {boolean} Whether the candidate should replace the best decision.
     */
    #isBetterDecision(candidate, best) {
        if (best === null) return true;
        if (candidate.risk !== best.risk) return candidate.risk < best.risk;
        if (candidate.risk !== 1 && candidate.wastesAce !== best.wastesAce) return !candidate.wastesAce;
        return candidate.score > best.score;
    }

    /**
     * Maps a legal discard to its targets and effects before any strategy is applied.
     * @param {import("./Card.js").Card} card - Legal discard or pending declaration card.
     * @param {number} remaining - Bot card count after this action.
     * @returns {Object} Candidate action shared by scoring and lookahead.
     */
    #mapCardTargets(card, remaining = this.hand.size - 1) {
        const target = this.#nextPlayerAfter(card);
        return {
            card,
            target,
            returnsToBot: target === null && this.playerCount > 0,
            following: target === null ? null : this.#followingPlayer(card, target),
            drawAllowance: card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1,
            declaredSuit: null,
            remainingPenalty: this.penalty - (remaining < this.hand.size ? card.rank : 0),
            endsMatch: card.isMatchEndingMove(remaining)
        };
    }

    /**
     * Attacks only when the first two responding players cannot exploit it to finish.
     * Unavoidable finishes prioritize shedding penalty over conserving tactical cards.
     * @param {Object} action - Legal candidate.
     * @param {number} tacticalScore - Offensive pressure and hand setup.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {{risk:number, score:number}} Attack priority.
     */
    #offensivePriority(action, tacticalScore, unseenCards) {
        const risk = this.#opponentFinishRisk(action, unseenCards);
        return {risk, score: risk === 1 ? action.card.rank : tacticalScore};
    }

    /**
     * Prioritizes legal counterattacks and shields during an active draw attack.
     * Forced defense is not rejected because a later player could finish.
     * @param {Object} action - Legal defensive candidate.
     * @param {number} tacticalScore - Defense, shedding, and continuation value.
     * @returns {{risk:number, score:number}} Defense priority.
     */
    #defensivePriority(action, tacticalScore) {
        return {risk: 0, score: action.endsMatch ? SCORE.WIN : tacticalScore};
    }

    // ---- Ace and draw-attack policies ----

    /**
     * Releases the ace of spades for defense, or after drawing unless the next player has one card.
     * @returns {boolean} Whether the shield may enter normal card selection.
     */
    #canReleaseShield() {
        if (this.drawAllowance > 1) return true;
        if (this.drawAllowance > 0) return false;
        const next = this.nextPlayer;
        return next !== null && next.key !== this.key && next.cardCount !== 1;
    }

    /**
     * Identifies a suit-changing ace that would redeclare the already active suit.
     * @param {Object} action - Candidate with its planned declaration.
     * @returns {boolean} Whether the play spends an ace without changing the active suit.
     */
    #wastesAce(action) {
        const activeSuit = this.declaredSuit ?? this.top?.suit;
        return action.card.isSuitChange() && action.declaredSuit === activeSuit;
    }

    /**
     * Sheds penalty while retaining versatile aces and shields when other choices exist.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {number} choiceCount - Available legal choices.
     * @returns {number} Penalty shedding and conservation value.
     */
    #scorePenaltyShedding(card, choiceCount) {
        let score = card.rank;
        if (card.isAceOfSpades() && this.drawAllowance <= 1) {
            score += choiceCount > 1 ? SCORE.KEEP_SHIELD : SCORE.SHIELD_FALLBACK;
        } else if (card.isSuitChange() && choiceCount > 1) {
            score += SCORE.KEEP_ACE;
        }
        return score;
    }

    /**
     * Counters an active draw attack, preferring another attack before spending a shield.
     * @param {import("./Card.js").Card} card - Legal candidate.
     * @returns {number} Defensive priority, or zero outside an active attack.
     */
    #scoreDrawDefense(card) {
        if (this.drawAllowance <= 1) return 0;
        if (card.isDrawCard()) return SCORE.URGENT;
        if (card.isAceOfSpades()) return this.#hasDrawCard() ? SCORE.STRONG : SCORE.URGENT;
        return 0;
    }

    /**
     * Returns whether this bot can extend an active draw attack.
     * @returns {boolean} True if player has a draw card.
     */
    #hasDrawCard() {
        for (const card of this.hand.items) {
            if (card.isDrawCard()) {
                return true;
            }
        }

        return false;
    }

    // ---- Turn projection ----

    /**
     * Resolves a discard's relative turn movement using the current player count.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {number} Relative turn step count, including skip and reverse rules.
     */
    #turnSteps(card) {
        if (card.isSkip(this.playerCount)) return 2;
        return card.isReverse(this.playerCount) ? -1 : 1;
    }

    /**
     * Predicts the next player after applying a candidate’s skip or reverse effect.
     *
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {{key:string, cardCount:number}|null} Projected opponent, or null when the turn returns to the bot.
     */
    #nextPlayerAfter(card) {
        const players = this.turnPlayers;
        if (players.length === 0) return null;
        const steps = this.#turnSteps(card);
        const player = players[(steps + players.length) % players.length];
        return player.key === this.key ? null : player;
    }

    /**
     * Projects the player after a target's response or penalty draw, including changed direction.
     * @param {import("./Card.js").Card} card - Bot's candidate.
     * @param {Object} target - First responding player.
     * @param {import("./Card.js").Card|null} response - Target discard, or null when drawing/passing.
     * @returns {Object} Following player snapshot.
     */
    #followingPlayer(card, target, response = null) {
        const players = this.turnPlayers;
        let direction = card.isReverse(players.length) ? -1 : 1;

        if (response?.isReverse(players.length)) {
            direction *= -1;
        }
        const steps = response?.isSkip(players.length) ? 2 : 1;
        const index = players.indexOf(target);
        const following = players[(index + steps * direction + players.length) % players.length];

        return following.key === this.key ? null : following;
    }

    // ---- Opponent threats and response estimates ----

    /**
     * Projects finishing threats through two player turns and every known legal first reply.
     * A bot finish has no following opponent turn.
     * Forced draws retain the discard and clear the penalty.
     *
     * @param {Object} action - Candidate discard.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {number} Probability that the projected player can immediately empty its hand.
     */
    #opponentFinishRisk(action, unseenCards) {
        const card = action.card;
        if (action.endsMatch) {
            return 0;
        }
        const target = action.target;
        if (target === null || target.key === this.key) {
            return 0;
        }
        const suit = action.declaredSuit;
        const immediateRisk = this.#finishRiskOn(card, suit, target, unseenCards, action.drawAllowance, action.remainingPenalty);
        if (immediateRisk === 1) {
            return immediateRisk;
        }
        if (target.hand === null) {
            return immediateRisk;
        }

        const allowance = action.drawAllowance;
        let continuationRisk = Infinity;
        for (const response of target.hand.getLegalCards(card, suit, allowance)) {
            const risk = this.#riskAfterReply(action, response, unseenCards);
            continuationRisk = Math.min(continuationRisk, risk);
        }
        if (continuationRisk === Infinity) {
            const following = action.following;
            continuationRisk = this.#finishRiskOn(card, suit, following, unseenCards, 1, action.remainingPenalty);
        }
        return Math.max(immediateRisk, continuationRisk);
    }

    /**
     * Projects the following player's threat after one known reply, including an opponent ace declaration.
     * @param {Object} action - Bot candidate and its first responding player.
     * @param {import("./Card.js").Card} response - Known legal opponent reply.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {number} Finish risk after the reply and its best protective declaration.
     */
    #riskAfterReply(action, response, unseenCards) {
        if (response.isMatchEndingCard()) {
            return action.target.hand.penalty - response.rank < action.remainingPenalty ? 1 : 0;
        }
        const following = this.#followingPlayer(action.card, action.target, response);
        if (!response.isSuitChange()) {
            return this.#finishRiskOn(response, null, following, unseenCards, null, action.remainingPenalty);
        }
        let risk = Infinity;
        for (const suit of Constants.CARD.STANDARD_SUITS) {
            risk = Math.min(risk, this.#finishRiskOn(response, suit, following, unseenCards, null, action.remainingPenalty));
            if (risk === 0) break;
        }
        return risk;
    }

    /**
     * Checks final-card finishes and losing seven-of-hearts outcomes on the simulated discard.
     * @param {import("./Card.js").Card} card - Simulated top card.
     * @param {string|null} suit - Simulated declared suit.
     * @param {StrategyPlayer} player - Projected player.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @param {number|null} allowance - Override after an attack is collected.
     * @param {number} remainingPenalty - Bot penalty after its candidate discard.
     * @returns {number} Exact or estimated finishing risk.
     */
    #finishRiskOn(card, suit, player, unseenCards, allowance = null, remainingPenalty = this.penalty) {
        if (player === null || player.key === this.key) return 0;
        if (player.hand === null) {
            return player.cardCount === 1 ? this.#responseChance(card, suit, player, unseenCards, allowance) : 0;
        }
        const drawAllowance = allowance ?? (card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1);
        const legal = player.hand.getLegalCards(card, suit, drawAllowance);
        if (player.cardCount === 1 && legal.length > 0) return 1;
        if (this.#canFinishWithSkips(player.hand.items, card, suit, drawAllowance)) return 1;
        for (const response of legal) {
            if (response.isMatchEndingCard() && player.hand.penalty - response.rank < remainingPenalty) return 1;
        }
        return 0;
    }

    /**
     * Uses exact neighboring cards when available, otherwise estimates from unseen cards.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {string|null} declaredSuit - Candidate declared suit.
     * @param {StrategyPlayer} player - Projected opponent snapshot.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @param {number|null} drawAllowance - Override for a simulated turn after collection.
     * @returns {number} Exact response availability or estimated probability.
     */
    #responseChance(card, declaredSuit, player, unseenCards, drawAllowance = null) {
        const allowance = drawAllowance ?? (card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1);

        if (player.hand === null) {
            return CardOdds.responseChance(card, declaredSuit, player.cardCount, unseenCards, allowance);
        }
        return player.hand.getLegalCards(card, declaredSuit, allowance).length > 0 ? 1 : 0;
    }

    /**
     * Assigns urgency from an opponent's visible hand count.
     *
     * @param {{key:string, cardCount:number}|null} player - Projected opponent.
     * @returns {number} Danger priority.
     */
    #opponentUrgency(player) {
        if (player === null || player.key === this.key) return 0;
        if (player.cardCount === 1) return SCORE.URGENT;
        if (player.cardCount === 2) return SCORE.STRONG;
        if (player.cardCount === 3) return SCORE.MODERATE;
        return player.cardCount > 3 ? SCORE.CONTINUATION : 0;
    }

    // ---- Tactical scoring and hand setup ----

    /**
     * Prioritizes a card based on bot strategy.
     *
     * @param {Object} action - Candidate card.
     * @param {number} choiceCount - Available legal choices.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Card priority.
     */
    #scoreCard(action, choiceCount, unseenCards) {
        const card = action.card;
        if (card.isMatchEndingCard()) {
            return this.#scoreSevenOfHearts(card, unseenCards);
        }

        const shedding = this.#scorePenaltyShedding(card, choiceCount);
        const opponentPressure = this.#scoreOpponentPressure(action, choiceCount, unseenCards);
        const handSetup = this.#scoreRemainingHand(action);
        const weakSuit = this.#continuesWeakSuit(action) ? SCORE.STRONG : 0;
        const turnControl = card.isSkip(this.playerCount) || card.isReverse(this.playerCount) ? SCORE.CONTINUATION : 0;

        return shedding + opponentPressure + handSetup + weakSuit + turnControl + this.#scoreDrawDefense(card);
    }

    /**
     * Estimates how safely a candidate controls the projected opponent.
     *
     * The projected player accounts for skips and reverses.
     * Neighboring hands provide exact legal-response checks; other targets use their counts and the unknown-card pool.
     *
     * @param {Object} action - Candidate discard.
     * @param {number} choiceCount - Number of legal choices available to the bot.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Strategy priority adjustment.
     */
    #scoreOpponentPressure(action, choiceCount, unseenCards) {
        const card = action.card;
        if (choiceCount <= 1) {
            return 0;
        }

        const immediate = this.nextPlayer;
        const projected = action.target;
        const urgency = this.#opponentUrgency(projected);
        const rerouting = immediate?.key !== projected?.key ? this.#opponentUrgency(immediate) - urgency : 0;
        if (urgency === 0) {
            return rerouting;
        }

        const declaredSuit = action.declaredSuit;
        const responseChance = this.#responseChance(card, declaredSuit, projected, unseenCards);
        const pressure = card.isDrawCard() ? 1 - 2 * responseChance : card.isSuitChange() ? 0.5 - responseChance : -responseChance;
        let score = rerouting + Math.round(urgency * pressure);
        if (card.isDrawCard() && this.drawAllowance <= 1) {
            const drawCount = card.isDrawFour() ? 4 : 2;
            score += SCORE.KEEP_DRAW_CARD + Math.round(SCORE.ATTACK_OPPORTUNITY * (drawCount / 2) * (1 - responseChance));
        }
        return score;
    }

    /**
     * Rewards plays that keep the bot's high-penalty remaining cards playable.
     *
     * A two-player skip that returns an immediately playable final card to the bot receives the strongest setup bonus.
     *
     * @param {Object} action - Candidate discard.
     * @returns {number} Setup priority.
     */
    #scoreRemainingHand(action) {
        const card = action.card;
        const remainingCards = [];

        for (const heldCard of this.hand.items) {
            if (heldCard !== card) {
                remainingCards.push(heldCard);
            }
        }
        if (action.returnsToBot && this.#canFinishWithSkips(remainingCards, card, action.declaredSuit, 1, true)) {
            return SCORE.WIN;
        }
        let priority = 0;

        if (remainingCards.length > 0) {
            const declaredSuit = action.declaredSuit;
            let continuationCount = 0;
            let continuationPenalty = 0;
            let remainingPenalty = 0;

            for (const remainingCard of remainingCards) {
                remainingPenalty += remainingCard.rank;
                const isUnusedAceOfSpades = remainingCard.isAceOfSpades();

                if (!isUnusedAceOfSpades && remainingCard.isLegalOn(card, declaredSuit, 1)) {
                    continuationCount += 1;
                    continuationPenalty += remainingCard.rank;
                }
            }

            priority += Math.round((SCORE.CONTINUATION * continuationPenalty) / remainingPenalty);

            const createsImmediateFinish = this.playerCount === 1 && action.returnsToBot && remainingCards.length === 1 && continuationCount === 1;

            if (createsImmediateFinish) {
                priority += SCORE.URGENT;
            }
        }

        return priority;
    }

    /**
     * Detects whether a candidate pressures an opponent’s inferred weak suit.
     *
     * Playing the lowest ordinary rank suggests the previous player may have exhausted that
     * suit, so the bot presses the same suit when it has a legal choice.
     *
     * @param {Object} action - Candidate discard.
     * @returns {boolean} True when the inferred empty suit is continued.
     */
    #continuesWeakSuit(action) {
        const card = action.card;
        const top = this.top;
        const lastPlayer = this.lastDiscardPlayer;
        const projectedPlayer = action.target;

        return (
            top !== null &&
            lastPlayer !== null &&
            projectedPlayer !== null &&
            lastPlayer.key !== this.key &&
            projectedPlayer.key === lastPlayer.key &&
            !top.isSpecial() &&
            Constants.getCardValue(top.value).rank === Constants.CARD.VALUE.THREE.rank &&
            card.suit === top.suit
        );
    }

    // ---- Two-player skip chains ----

    /**
     * Finds a two-player finish using only skips before the final card, without assuming any draw.
     * @param {import("./Card.js").Card[]} cards - Remaining hand.
     * @param {import("./Card.js").Card} top - Simulated top discard.
     * @param {string|null} suit - Active suit declaration.
     * @param {number} allowance - Current draw allowance.
     * @param {boolean} conserveShield - Preserve the bot's existing ace-of-spades release policy.
     * @returns {boolean} Whether the hand can empty before the opponent receives a turn.
     */
    #canFinishWithSkips(cards, top, suit = null, allowance = 1, conserveShield = false) {
        if (this.playerCount !== 2 || cards.length === 0) return false;
        let ordinaryCount = 0;
        for (const card of cards) {
            if (!card.isSkip(this.playerCount)) ordinaryCount += 1;
        }
        if (ordinaryCount > 1) return false;
        for (const card of cards) {
            if (conserveShield && card.isAceOfSpades()) continue;
            if (!card.isLegalOn(top, suit, allowance)) continue;
            if (cards.length === 1) return true;
            if (!card.isSkip(this.playerCount)) continue;
            const remaining = [];
            for (const held of cards) {
                if (held.id !== card.id) remaining.push(held);
            }
            if (this.#canFinishWithSkips(remaining, card, null, 1, conserveShield)) return true;
        }
        return false;
    }

    // ---- Seven-of-hearts outcomes ----

    /**
     * Prioritizes a room-ending card from public information.
     *
     * @param {import("./Card.js").Card} card - Candidate room-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Card priority.
     */
    #scoreSevenOfHearts(card, unseenCards) {
        let priority = SCORE.REJECT;

        if (this.hand.size === 1) {
            priority = SCORE.WIN;
        } else {
            const winProbability = this.#sevenOfHeartsWinChance(card, unseenCards);

            if (winProbability >= SCORE.MINIMUM_WIN_CHANCE) {
                priority = SCORE.WIN;
            }
        }

        return priority;
    }

    /**
     * Estimates the chance that the bot's remaining penalty ties or beats every opponent.
     *
     * Neighboring penalties are computed from inspected cards.
     * Other opponents use random samples from unknown cards; their estimates are multiplied as an approximation.
     *
     * @param {import("./Card.js").Card} card - Candidate room-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Estimated probability from zero through one.
     */
    #sevenOfHeartsWinChance(card, unseenCards) {
        const remainingPenalty = this.penalty - card.rank;
        let winProbability = 1;

        for (const player of this.players) {
            if (player.key !== this.key) {
                let opponentProbability;
                if (player.hand !== null) {
                    let penalty = 0;
                    for (const held of player.hand.items) penalty += held.rank;
                    opponentProbability = penalty >= remainingPenalty ? 1 : 0;
                } else {
                    opponentProbability = CardOdds.penaltyChance(remainingPenalty, player.cardCount, unseenCards);
                }
                winProbability *= opponentProbability;
            }
        }

        return winProbability;
    }

    // ---- Suit declarations ----

    /**
     * Chooses the most common safe suit after checking both projected opponents.
     * Equal counts favor held penalty, then scarcity among unknown cards.
     * @param {Object|null} action - Candidate or pending suit declaration.
     * @param {import("./Card.js").Card|null} excludedCard - Candidate discard omitted from the hand.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {string} Safest suit with the strongest held count.
     */
    #chooseSuit(action, excludedCard, unseenCards) {
        const counts = this.hand.getSuitCounts(excludedCard);
        const unseenCounts = new CardCollection(unseenCards).getSuitCounts();

        let selected = Constants.CARD.SUIT.HEARTS;
        let lowestRisk = Infinity;
        let highestCount = -1;
        let highestPenalty = -1;
        let lowestUnseen = Infinity;

        for (const [suit, count] of Object.entries(counts)) {
            const risk = action === null ? 0 : this.#opponentFinishRisk({...action, declaredSuit: suit}, unseenCards);
            let penalty = 0;

            for (const card of this.hand.items) {
                if (card.id !== excludedCard?.id && card.suit === suit) penalty += card.rank;
            }

            const isSafer = risk < lowestRisk;
            const hasMoreCards = risk === lowestRisk && count > highestCount;
            const shedsMorePenalty = risk === lowestRisk && count === highestCount && penalty > highestPenalty;
            const isScarcer = risk === lowestRisk && count === highestCount && penalty === highestPenalty && unseenCounts[suit] < lowestUnseen;

            if (isSafer || hasMoreCards || shedsMorePenalty || isScarcer) {
                selected = suit;
                lowestRisk = risk;
                highestCount = count;
                highestPenalty = penalty;
                lowestUnseen = unseenCounts[suit];
            }
        }
        return selected;
    }
}
