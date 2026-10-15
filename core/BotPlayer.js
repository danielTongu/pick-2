"use strict";

import { BotStrategy } from "./BotStrategy.js";
import { Player } from "./Player.js";

/** Automated player that chooses legal moves from private hand data and public room state. */
export class BotPlayer extends Player {

    /** @type {number} Minimum delay before an automated action. */
    DELAY_MIN_MS = 1000;

    /** @type {number} Maximum delay before an automated action. */
    DELAY_MAX_MS = 3000;

    /**
     * Creates a bot player.
     *
     * @param {string} name - Bot player name.
     * @throws {Error} When the bot name is not a valid player identity.
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

    /**
     * Chooses and submits a suit using the same public-information strategy.
     * @param {import("./Room.js").Room} room - Current room.
     * @returns {Promise<void>} Completion of the declaration.
     */
    async chooseSuit(room) {
        await this._waitForTurnDelay();
        if (room.match.turnOrder.ownerKey === this.key) {
            await room.declareSuit(new BotStrategy(this, room.match).selectSuit(), this.name);
        }
    }

    /** Waits for a randomized human-like delay. */
    async _waitForTurnDelay() {
        const range = this.DELAY_MAX_MS - this.DELAY_MIN_MS + 1;
        const delay = this.DELAY_MIN_MS + Math.floor(Math.random() * range);
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
}
