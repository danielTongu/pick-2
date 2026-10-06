"use strict";

import { Constants } from "./Constants.js";
import { CardCollection } from "./CardCollection.js";
import { CardOdds } from "./CardOdds.js";


/** Shared tactical scales and conservation costs; card rank measures penalty shed directly. */
const SCORE = Object.freeze({
    win: Infinity,
    reject: -Infinity,
    urgent: 10000,
    strong: 5000,
    moderate: 1000,
    continuation: 100,
    keepDrawCard: -5000,
    attackOpportunity: 6000,
    keepShield: -8000,
    shieldFallback: -1000,
    keepAce: -3000,
    minimumWinChance: 0.7
});



/** Chooses cards that shed the bot's penalty while denying opponents an easy response. */
export class BotStrategy {

    /** @type {Object} One decision snapshot containing the bot hand, reachable opponent hands, and public match information. */
    #state;

    /**
     * Copies the bot hand, reachable next-actor hands, public discards, and turn positions.
     * Other actors retain count-only summaries; the draw collection is never inspected.
     * @param {import("./BotActor.js").BotActor} bot - Acting bot.
     * @param {import("./Room.js").Match} match - Current match.
     */
    constructor(bot, match) {
        const turnActors = Array.from({ length: match.turnOrder.actors.size }, function relativeActor(_, index) {
            return match.turnOrder.relative(index);
        });

        const hand = new CardCollection(bot.collection.items);
        const top = match.getTopItem?.() ?? null;
        const legalCards = hand.getLegalCards(top, match.declaredSuit, bot.drawAllowance);

        if (top?.isSuitChange() && match.pending?.actorKey === bot.key) {
            legalCards.push(top);
        }

        const targets = new Set();
        for (const card of legalCards) {
            const steps = card.isSkip(turnActors.length) ? 2 : card.isReverse(turnActors.length) ? -1 : 1;
            const index = (steps + turnActors.length) % turnActors.length;
            const target = turnActors[index];

            if (target === undefined || target.key === bot.key) continue;

            targets.add(target.key);
            const direction = card.isReverse(turnActors.length) ? -1 : 1;
            const following = turnActors[(index + direction + turnActors.length) % turnActors.length];

            if (following.key !== bot.key) targets.add(following.key);
        }

        const actors = [];
        for (const actor of match.turnOrder.actors.values()) {
            actors.push({
                key: actor.key,
                cardCount: actor.collection.items.length,
                hand: actor.key !== bot.key && targets.has(actor.key) ? new CardCollection(actor.collection.items) : null
            });
        }

        const byKey = new Map();
        for (const actor of actors) {
            byKey.set(actor.key, actor);
        }

        this.#state = {
            key: bot.key,
            hand,
            penalty: bot.collection.penalty,
            drawAllowance: bot.drawAllowance,
            play: [...(match.collections?.play?.items ?? [])],
            top,
            declaredSuit: match.declaredSuit,
            actors,
            turnActors: turnActors.map(function actorSnapshot(actor){ return byKey.get(actor.key);}),
            actorCount: actors.length,
            nextActor: turnActors.length > 1 ? byKey.get(turnActors[1].key) : null,
            lastDiscardActor: byKey.get(match.getLastDiscardActor?.()?.key) ?? null
        };
    }

    /**
     * Collects legal cards, maps their targets, then applies strategies and selects an action.
     *
     * @returns {import("./Card.js").Card|null} Best card or null if none legal.
     */
    selectCard() {
        const legalCards = this.#state.hand.getLegalCards(
            this.#state.top, this.#state.declaredSuit, this.#state.drawAllowance
        );
        if (legalCards.length === 0) {
            return null;
        }

        const actions = [];
        for (const card of legalCards) {
            actions.push(this.#mapCardTargets(card));
        }

        const choices = this.#preferredActions(actions);
        if (choices.length === 0) {
            return null;
        }

        const unseenCards = this.#unseenCards();
        let selected = null;
        let lowestFinishRisk = Infinity;
        let highestScore = SCORE.reject;

        for (const action of choices) {
            if (action.card.isSuitChange()) {
                action.declaredSuit = this.#chooseSuit(action, action.card, unseenCards);
            }

            const tacticalScore = this.#scoreCard(action, choices.length, unseenCards);
            if (tacticalScore === SCORE.reject) {
                continue;
            }

            const decision = this.#state.drawAllowance > 1
                ? this.#defensivePriority(action, tacticalScore)
                : this.#offensivePriority(action, tacticalScore, unseenCards);
            const { risk, score } = decision;
            if (risk < lowestFinishRisk || (risk === lowestFinishRisk && score > highestScore)) {
                selected = action.card;
                lowestFinishRisk = risk;
                highestScore = score;
            }
        }
        return selected;
    }

    /**
     * Maps a legal discard to its targets and effects before any strategy is applied.
     * @param {import("./Card.js").Card} card - Legal discard or pending declaration card.
     * @param {number} remaining - Bot card count after this action.
     * @returns {Object} Candidate action shared by scoring and lookahead.
     */
    #mapCardTargets(card, remaining = this.#state.hand.size - 1) {
        const target = this.#nextActorAfter(card);
        return {
            card,
            target,
            returnsToBot: target === null && this.#state.actorCount > 0,
            following: target === null ? null : this.#followingActor(card, target),
            drawAllowance: card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1,
            declaredSuit: null,
            remainingPenalty: this.#state.penalty - (remaining < this.#state.hand.size ? card.rank : 0),
            endsMatch: card.isMatchEndingMove(remaining)
        };
    }

    /**
     * Applies the shield-release policy to already mapped legal actions.
     * @param {Object[]} actions - Legal actions with targets.
     * @returns {Object[]} Strategically available actions.
     */
    #preferredActions(actions) {
        const next = this.#state.nextActor;
        const releaseShield = this.#state.drawAllowance > 1 ||
            (this.#state.drawAllowance <= 0 && next !== null && next.key !== this.#state.key && next.cardCount !== 1);
        return actions.filter(function conserveShield(action) {
            return !action.card.isAceOfSpades() || releaseShield;
        });
    }

    /**
     * Attacks only when the first two responding actors cannot exploit it to finish.
     * Unavoidable finishes prioritize shedding penalty over conserving tactical cards.
     * @param {Object} action - Legal candidate.
     * @param {number} tacticalScore - Offensive pressure and hand setup.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {{risk:number, score:number}} Attack priority.
     */
    #offensivePriority(action, tacticalScore, unseenCards) {
        const risk = this.#opponentFinishRisk(action, unseenCards);
        return { risk, score: risk === 1 ? action.card.rank : tacticalScore };
    }

    /**
     * Prioritizes legal counterattacks and shields during an active draw attack.
     * Forced defense is not rejected because a later actor could finish.
     * @param {Object} action - Legal defensive candidate.
     * @param {number} tacticalScore - Defense, shedding, and continuation value.
     * @returns {{risk:number, score:number}} Defense priority.
     */
    #defensivePriority(action, tacticalScore) {
        return { risk: 0, score: action.endsMatch ? SCORE.win : tacticalScore };
    }

    /**
     * Reconstructs unknown cards after removing the bot hand, public discards, and inspected hands.
     *
     * Cards recycled from an old discard pile correctly become unseen again, which is why
     * persistent per-actor discard memory would produce inaccurate card counts.
     *
     * @returns {import("./Card.js").Card[]} Unseen cards.
     */
    #unseenCards() {
        const knownCardIds = new Set();
        const visiblePlayedItems = this.#state.play;

        for (const card of this.#state.hand.items) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        for (const card of visiblePlayedItems) {
            knownCardIds.add(`${card.value}-${card.suit}`);
        }

        for (const actor of this.#state.actors) {
            if (actor.hand !== null) {
                for (const card of actor.hand.items) knownCardIds.add(card.id);
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
            return this.#scoreMatchEnd(card, unseenCards);
        }

        const shedding = this.#scorePenaltyShedding(card, choiceCount);
        const opponentPressure = this.#scoreOpponentPressure(action, choiceCount, unseenCards);
        const handSetup = this.#scoreRemainingHand(action);
        const weakSuit = this.#continuesWeakSuit(action) ? SCORE.strong : 0;
        const turnControl = card.isSkip(this.#state.actorCount) || card.isReverse(this.#state.actorCount) ? SCORE.continuation : 0;

        return shedding + opponentPressure + handSetup + weakSuit + turnControl + this.#scoreDrawDefense(card);
    }

    /**
     * Sheds penalty while retaining versatile aces and shields when other choices exist.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {number} choiceCount - Available legal choices.
     * @returns {number} Penalty shedding and conservation value.
     */
    #scorePenaltyShedding(card, choiceCount) {
        let score = card.rank;
        if (card.isAceOfSpades() && this.#state.drawAllowance <= 1) {
            score += choiceCount > 1 ? SCORE.keepShield : SCORE.shieldFallback;
        } else if (card.isSuitChange() && choiceCount > 1) {
            score += SCORE.keepAce;
        }
        return score;
    }

    /**
     * Counters an active draw attack, preferring another attack before spending a shield.
     * @param {import("./Card.js").Card} card - Legal candidate.
     * @returns {number} Defensive priority, or zero outside an active attack.
     */
    #scoreDrawDefense(card) {
        if (this.#state.drawAllowance <= 1) return 0;
        if (card.isDrawCard()) return SCORE.urgent;
        if (card.isAceOfSpades()) return this.#hasDrawCard() ? SCORE.strong : SCORE.urgent;
        return 0;
    }

    /**
     * Estimates how safely a candidate controls the projected opponent.
     *
     * The projected actor accounts for skips and reverses. Neighboring hands provide exact
     * legal-response checks; other targets use their counts and the unknown-card pool.
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

        const immediate = this.#state.nextActor;
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
        if (card.isDrawCard() && this.#state.drawAllowance <= 1) {
            const drawCount = card.isDrawFour() ? 4 : 2;
            score += SCORE.keepDrawCard + Math.round(SCORE.attackOpportunity * (drawCount / 2) * (1 - responseChance));
        }
        return score;
    }

    /**
     * Projects finishing threats through two actor turns and every known legal first reply.
     * A bot finish has no following opponent turn. Forced draws retain the discard and clear the penalty.
     * @param {Object} action - Candidate discard.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {number} Probability that the projected actor can immediately empty its hand.
     */
    #opponentFinishRisk(action, unseenCards) {
        const card = action.card;
        if (action.endsMatch) {
            return 0;
        }
        const target = action.target;
        if (target === null || target.key === this.#state.key) {
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
            if (response.isMatchEndingCard()) {
                const risk = target.hand.penalty - response.rank < action.remainingPenalty ? 1 : 0;
                continuationRisk = Math.min(continuationRisk, risk);
                continue;
            }
            const following = this.#followingActor(card, target, response);
            let risk = this.#finishRiskOn(response, null, following, unseenCards, null, action.remainingPenalty);
            if (response.isSuitChange()) {
                risk = Infinity;
                const preferredSuit = target.hand.getDominantSuit(response);
                const suits = [preferredSuit, ...Constants.CARD.STANDARD_SUITS];
                for (const declaredSuit of suits) {
                    if (Constants.isStandardSuit(declaredSuit)) {
                        risk = Math.min(risk, this.#finishRiskOn(response, declaredSuit, following, unseenCards, null, action.remainingPenalty));
                        if (risk === 0) break;
                    }
                }
            }
            continuationRisk = Math.min(continuationRisk, risk);
        }
        if (continuationRisk === Infinity) {
            const following = action.following;
            continuationRisk = this.#finishRiskOn(card, suit, following, unseenCards, 1, action.remainingPenalty);
        }
        return Math.max(immediateRisk, continuationRisk);
    }

    /**
     * Projects the actor after a target's response or penalty draw, including changed direction.
     * @param {import("./Card.js").Card} card - Bot's candidate.
     * @param {Object} target - First responding actor.
     * @param {import("./Card.js").Card|null} response - Target discard, or null when drawing/passing.
     * @returns {Object} Following actor snapshot.
     */
    #followingActor(card, target, response = null) {
        const actors = this.#state.turnActors;
        let direction = card.isReverse(actors.length) ? -1 : 1;

        if (response?.isReverse(actors.length)) {
            direction *= -1;
        }
        const steps = response?.isSkip(actors.length) ? 2 : 1;
        const index = actors.indexOf(target);
        const following = actors[(index + steps * direction + actors.length) % actors.length];

        return following.key === this.#state.key ? null : following;
    }

    /**
     * Checks final-card finishes and losing seven-of-hearts outcomes on the simulated discard.
     * @param {import("./Card.js").Card} card - Simulated top card.
     * @param {string|null} suit - Simulated declared suit.
     * @param {Object} actor - Projected actor.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @param {number|null} allowance - Override after an attack is collected.
     * @param {number} remainingPenalty - Bot penalty after its candidate discard.
     * @returns {number} Exact or estimated finishing risk.
     */
    #finishRiskOn(card, suit, actor, unseenCards, allowance = null, remainingPenalty = this.#state.penalty) {
        if (actor === null || actor.key === this.#state.key) return 0;
        if (actor.hand === null) {
            return actor.cardCount === 1 ? this.#responseChance(card, suit, actor, unseenCards, allowance) : 0;
        }
        const drawAllowance = allowance ?? (card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1);
        const legal = actor.hand.getLegalCards(card, suit, drawAllowance);
        if (actor.cardCount === 1 && legal.length > 0) return 1;
        for (const response of legal) {
            if (response.isMatchEndingCard() && actor.hand.penalty - response.rank < remainingPenalty) return 1;
        }
        return 0;
    }

    /**
     * Uses exact neighboring cards when available, otherwise estimates from unseen cards.
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {string|null} declaredSuit - Candidate declared suit.
     * @param {Object} actor - Projected opponent snapshot.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @param {number|null} drawAllowance - Override for a simulated turn after collection.
     * @returns {number} Exact response availability or estimated probability.
     */
    #responseChance(card, declaredSuit, actor, unseenCards, drawAllowance = null) {
        const allowance = drawAllowance ?? (card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1);

        if (actor.hand === null) {
            return CardOdds.responseChance(card, declaredSuit, actor.cardCount, unseenCards, allowance);
        }
        return actor.hand.getLegalCards(card, declaredSuit, allowance).length > 0 ? 1 : 0;
    }

    /**
     * Assigns urgency from an opponent's visible hand count.
     *
     * @param {{key:string, cardCount:number}|null} actor - Projected opponent.
     * @returns {number} Danger priority.
     */
    #opponentUrgency(actor) {
        if (actor === null || actor.key === this.#state.key) return 0;
        if (actor.cardCount === 1) return SCORE.urgent;
        if (actor.cardCount === 2) return SCORE.strong;
        if (actor.cardCount === 3) return SCORE.moderate;
        return actor.cardCount > 3 ? SCORE.continuation : 0;
    }

    /**
     * Rewards plays that keep the bot's high-penalty remaining cards playable.
     *
     * A two-actor skip that returns an immediately playable final card to the bot receives
     * the strongest setup bonus.
     *
     * @param {Object} action - Candidate discard.
     * @returns {number} Setup priority.
     */
    #scoreRemainingHand(action) {
        const card = action.card;
        const remainingCards = [];

        for (const heldCard of this.#state.hand.items) {
            if (heldCard !== card) {
                remainingCards.push(heldCard);
            }
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

            priority += Math.round((SCORE.continuation * continuationPenalty) / remainingPenalty);

            const createsImmediateFinish = action.returnsToBot && remainingCards.length === 1 && continuationCount === 1;

            if (createsImmediateFinish) {
                priority += SCORE.urgent;
            }
        }

        return priority;
    }

    /**
     * Predicts the next actor after applying a candidate’s skip or reverse effect.
     *
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @returns {{key:string, cardCount:number}|null} Projected opponent, or null when the turn returns to the bot.
     */
    #nextActorAfter(card) {
        const actors = this.#state.turnActors;
        if (actors.length === 0) return null;
        const steps = card.isSkip(actors.length) ? 2 : card.isReverse(actors.length) ? -1 : 1;
        const actor = actors[(steps + actors.length) % actors.length];
        return actor.key === this.#state.key ? null : actor;
    }

    /**
     * Detects whether a candidate pressures an opponent’s inferred weak suit.
     *
     * Playing the lowest ordinary rank suggests the previous actor may have exhausted that
     * suit, so the bot presses the same suit when it has a legal choice.
     *
     * @param {Object} action - Candidate discard.
     * @returns {boolean} True when the inferred empty suit is continued.
     */
    #continuesWeakSuit(action) {
        const card = action.card;
        const top = this.#state.top;
        const lastActor = this.#state.lastDiscardActor;
        const projectedActor = action.target;

        return (
            top !== null &&
            lastActor !== null &&
            projectedActor !== null &&
            lastActor.key !== this.#state.key &&
            projectedActor.key === lastActor.key &&
            !top.isSpecial() &&
            Constants.getCardValue(top.value).rank === Constants.CARD.VALUE.THREE.rank &&
            card.suit === top.suit
        );
    }

    /**
     * Returns whether this bot can extend an active draw attack.
     * @returns {boolean} True if actor has a draw card.
     */
    #hasDrawCard() {
        for (const card of this.#state.hand.items) {
            if (card.isDrawCard()) {
                return true;
            }
        }

        return false;
    }

    /**
     * Prioritizes a room-ending card from public information.
     *
     * @param {import("./Card.js").Card} card - Candidate room-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Card priority.
     */
    #scoreMatchEnd(card, unseenCards) {
        let priority = SCORE.reject;

        if (this.#state.hand.size === 1) {
            priority = SCORE.win;
        } else {
            const winProbability = this.#matchWinChance(card, unseenCards);

            if (winProbability >= SCORE.minimumWinChance) {
                priority = SCORE.win;
            }
        }

        return priority;
    }

    /**
     * Estimates the chance that the bot's remaining penalty ties or beats every opponent.
     *
     * Neighboring penalties are computed from inspected cards. Other opponents use random
     * samples from unknown cards; their estimates are multiplied as an approximation.
     *
     * @param {import("./Card.js").Card} card - Candidate room-ending card.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Estimated probability from zero through one.
     */
    #matchWinChance(card, unseenCards) {
        const remainingPenalty = this.#state.penalty - card.rank;
        let winProbability = 1;

        for (const actor of this.#state.actors) {
            if (actor.key !== this.#state.key) {
                let opponentProbability;
                if (actor.hand !== null) {
                    let penalty = 0;
                    for (const held of actor.hand.items) penalty += held.rank;
                    opponentProbability = penalty >= remainingPenalty ? 1 : 0;
                } else {
                    opponentProbability = CardOdds.penaltyChance(remainingPenalty, actor.cardCount, unseenCards);
                }
                winProbability *= opponentProbability;
            }
        }

        return winProbability;
    }

    /**
     * Prefers the most common safe held suit after evaluating both projected actors.
     *
     * @param {import("./Card.js").Card|null} excludedCard - Candidate card to exclude.
     * @param {import("./Card.js").Card[]|null} unseenCards - Optional previously reconstructed unseen cards.
     * @returns {string} Selected suit.
     */
    selectSuit(excludedCard = null, unseenCards = null) {
        const card = excludedCard ?? this.#state.top;
        const remaining = this.#state.hand.size - (excludedCard === null ? 0 : 1);
        const action = card === null ? null : this.#mapCardTargets(card, remaining);
        return this.#chooseSuit(action, excludedCard, unseenCards ?? this.#unseenCards());
    }

    /**
     * Chooses the most common safe suit after checking both projected opponents.
     * Equal counts favor held penalty, then scarcity among unknown cards.
     * @param {Object|null} action - Candidate or pending suit declaration.
     * @param {import("./Card.js").Card|null} excludedCard - Candidate discard omitted from the hand.
     * @param {import("./Card.js").Card[]} unseenCards - Unknown cards.
     * @returns {string} Safest suit with the strongest held count.
     */
    #chooseSuit(action, excludedCard, unseenCards) {
        const counts = this.#state.hand.getSuitCounts(excludedCard);
        const unseenCounts = new CardCollection(unseenCards).getSuitCounts();

        let selected = Constants.CARD.SUIT.HEARTS;
        let lowestRisk = Infinity;
        let highestCount = -1;
        let highestPenalty = -1;
        let lowestUnseen = Infinity;

        for (const [suit, count] of Object.entries(counts)) {
            const risk = action === null ? 0 : this.#opponentFinishRisk({ ...action, declaredSuit: suit }, unseenCards);
            let penalty = 0;

            for (const card of this.#state.hand.items) {
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
