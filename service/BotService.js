"use strict";

import { BotStrategy } from "./BotStrategy.js";

/** Schedules one cancellable bot decision; RoomService owns mutation and match validity. */
export class BotService {
    /** @type {number} Minimum presentation delay before an automated action. */
    DELAY_MIN_MS = 1000;

    /** @type {number} Maximum presentation delay before an automated action. */
    DELAY_MAX_MS = 3000;

    /**
     * Selects a turn or suit decision after its delay and submits it to the room queue.
     * @param {import("../model/BotPlayer.js").BotPlayer} player - Acting bot identity.
     * @param {import("./RoomService.js").RoomService} service - Owning workflow.
     */
    async takeTurn(player, service) {
        const signal = service.automationSignal;
        const revision = service.revision;
        await this._waitForTurnDelay(signal);
        if (!signal.aborted && revision === service.revision && service.room.match.turnOrder.owner === player) {
            const strategy = new BotStrategy(player, service.room.match);
            let command;
            let data = {};
            if (service.room.match.pending?.command === "declare") {
                command = "declare";
                data = { suit: strategy.selectSuit() };
            } else {
                const card = strategy.selectCard();
                if (card !== null) {
                    command = "discard";
                    data = { card: { value: card.value, suit: card.suit } };
                } else {
                    command = player.drawAllowance <= 0 ? "pass" : "draw";
                }
            }
            await service.performBotCommand(player, signal, command, data, revision);
        }
    }

    /**
     * Waits for presentation or cancellation and releases the timer and listener on either path.
     * @param {AbortSignal} signal - Owning match generation.
     * @returns {Promise<void>} Delay or cancellation completion.
     */
    async _waitForTurnDelay(signal) {
        const delay = this.DELAY_MIN_MS + Math.floor(Math.random() * (this.DELAY_MAX_MS - this.DELAY_MIN_MS + 1));
        await new Promise(function wait(resolve) {
            /** Releases every resource before completing the scheduled decision. */
            function finish() {
                globalThis.clearTimeout(timer);
                signal.removeEventListener("abort", finish);
                resolve();
            }
            const timer = globalThis.setTimeout(finish, delay);
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted) finish();
        });
    }
}
