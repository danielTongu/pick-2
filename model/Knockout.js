"use strict";

import { Match } from "./Match.js";
import { TurnOrder } from "./TurnOrder.js";
import { BotPlayer } from "./BotPlayer.js";
import { Constants } from "../shared/Constants.js";

/** Applies knockout elimination between otherwise ordinary Match matches. */
export class Knockout extends Match {

    /** Adds only the continuation state needed by a knockout. */
    constructor(turnOrder = new TurnOrder()) {
        super(turnOrder);
        this.nextMatchAvailable = false;
        this.lostBotNames = [];
    }

    /** A finished knockout without two qualifiers is complete. */
    get isKnockoutComplete() {
        return this.state === Constants.ROOM_STATE.FINISHED && !this.nextMatchAvailable;
    }

    /**
     * Excludes nonqualifiers and retains lost bot names for the final return.
     * @returns {Player[]} Removed players whose memberships may need updating.
     */
    prepareNextMatch() {
        if (!this.nextMatchAvailable) return [];
        const eliminated = [];
        for (const player of [...this.turnOrder.players.values()]) {
            if (player.state !== Constants.PLAYER_STATE.QUALIFIED) {
                if (player instanceof BotPlayer) this.lostBotNames.push(player.name);
                this.turnOrder.remove(player.key);
                eliminated.push(player);
            }
        }
        this.nextMatchAvailable = false;
        return eliminated;
    }

    /** Uses elimination for three or more players and ordinary results for a duel. */
    resolveOutcome() {
        if (this.turnOrder.players.size <= 2) {
            this.nextMatchAvailable = false;
            super.resolveOutcome();
            return;
        }
        let highestPenalty = -Infinity;
        for (const player of this.turnOrder.players.values()) {
            highestPenalty = Math.max(highestPenalty, player.collection.penalty);
        }
        for (const player of this.turnOrder.players.values()) {
            player.drawAllowance = 1;
            player.state = player.collection.penalty === highestPenalty
                ? Constants.PLAYER_STATE.ELIMINATED : Constants.PLAYER_STATE.QUALIFIED;

        }
        this.#resolveQualifiedOutcome();
    }

    /** Rechecks whether a departure leaves another match or a sole survivor. */
    afterPlayerRemoved() {
        if (this.state === Constants.ROOM_STATE.FINISHED && this.nextMatchAvailable) {
            this.#resolveQualifiedOutcome();
        }
    }

    /** Marks the remaining player as winner of an abandoned one-on-one. */
    finishByForfeit(survivor, departed) {
        survivor.state = Constants.PLAYER_STATE.WON;
        departed.state = Constants.PLAYER_STATE.LOST;
        this.state = Constants.ROOM_STATE.FINISHED;
        this.nextMatchAvailable = false;
        this.pending = null;
        this.declaredSuit = null;
    }

    /** Resolves the surviving qualified player or marks another match available. */
    #resolveQualifiedOutcome() {
        let count = 0;
        let survivor = null;
        for (const player of this.turnOrder.players.values()) {
            if (player.state === Constants.PLAYER_STATE.QUALIFIED) {
                count += 1;
                survivor = player;
            }
        }
        this.nextMatchAvailable = count >= 2;
        if (count === 1) survivor.state = Constants.PLAYER_STATE.WON;
    }
}
