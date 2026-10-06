"use strict";

/** Estimates hidden-hand outcomes using unseen public-deck cards and visible hand counts. */
export class CardOdds {

    /**
     * Estimates whether a projected opponent has at least one legal response.
     *
     * This is a hypergeometric estimate over unseen cards.
     * It uses the opponent's public card count, but never accesses the contents of that hand.
     *
     * @param {import("./Card.js").Card} card - Candidate discard.
     * @param {string|null} declaredSuit - Suit selected for the candidate ace.
     * @param {number} cardCount - Visible opponent card count.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @param {number|null} drawAllowance - Override for a simulated turn after collection.
     * @returns {number} Probability from zero through one.
     */
    static responseChance(card, declaredSuit, cardCount, unseenCards, drawAllowance = null) {
        let probability = 0;

        if (cardCount > 0 && unseenCards.length > 0) {
            const allowance = drawAllowance ?? (card.isDrawFour() ? 4 : card.isDrawTwo() ? 2 : 1);
            let legalCardCount = 0;

            for (const unseenCard of unseenCards) {
                if (unseenCard.isLegalOn(card, declaredSuit, allowance)) {
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
     * Calculates the chance that a random hand from unseen cards reaches a penalty.
     *
     * @param {number} targetPenalty - Penalty the sampled hand must meet or exceed.
     * @param {number} cardCount - Visible number of cards in the sampled hand.
     * @param {import("./Card.js").Card[]} unseenCards - Cards not publicly accounted for.
     * @returns {number} Probability from zero through one.
     */
    static penaltyChance(targetPenalty, cardCount, unseenCards) {
        let probability = 0;

        if (targetPenalty <= 0) {
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

                    for (const [rank, count] of previousCounts) {
                        const nextRank = rank + unseenCard.rank;
                        const previousCount = currentCounts.get(nextRank) ?? 0;

                        currentCounts.set(nextRank, previousCount + count);
                    }
                }

                processedCardCount += 1;
            }

            let totalCombinationCount = 0;
            let favorableCombinationCount = 0;

            for (const [rank, count] of combinationCounts[sampleCount]) {
                totalCombinationCount += count;

                if (rank >= targetPenalty) {
                    favorableCombinationCount += count;
                }
            }

            if (totalCombinationCount > 0) {
                probability = favorableCombinationCount / totalCombinationCount;
            }
        }

        return probability;
    }

}
