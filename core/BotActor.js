"use strict";

import { Constants } from "./Constants.js";
import { BotStrategy } from "./BotStrategy.js";
import { Actor } from "./Actor.js";

/** Automated actor that chooses legal moves from private hand data and public room state. */
export class BotActor extends Actor {

    /**
     * Creates a bot actor.
     *
     * @param {string} name - Bot actor name.
     * @throws {Error} When the bot name is not a valid actor identity.
     */
    constructor(name) {
        super(name, { drawAllowance: 1 });
    }

    /**
     * Waits, revalidates ownership, and performs one bot turn.
     * @param {import("./Room.js").Room} room - Room whose turn may belong to this Bot.
     */
    async takeTurn(room) {
        await this._waitForTurnDelay();
        if (room.match.turnOrder.ownerKey === this.key) await this.#performTurnCommand(room);
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
     * Executes the current turn command (pass, play, or draw).
     *
     * @param {import("./Room.js").Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async #performTurnCommand(room) {
        const card = new BotStrategy(this, room.match).selectCard();

        if (card !== null) {
            await room.playItem(this.name, card.value, card.suit);
        } else if (this.drawAllowance <= 0) {
            await room.passTurn(this.name);
        } else {
            await room.drawItems(this.name);
        }
    }

    /**
     * Chooses and submits a suit using the same public-information strategy.
     * @param {import("./Room.js").Room} room - Current room.
     * @returns {Promise<void>} Completion of the declaration.
     */
    async chooseSuit(room) {
        await this._waitForTurnDelay();
        if (room.match.turnOrder.ownerKey === this.key) {
            await room.declareSuit(new BotStrategy(this, room.match).selectSuit());
        }
    }
}
