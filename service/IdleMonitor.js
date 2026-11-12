"use strict";

import { Constants } from "../shared/Constants.js";

/** Owns the cancellable idle timers for one room's eligible human players. */
export class IdleMonitor {
    /** @type {Map<import("../model/Player.js").Player, ReturnType<typeof setTimeout>>} Active player timers. */
    #timers = new Map();

    /**
     * Replaces monitoring with fresh windows for the current eligible players.
     * @param {import("../model/Player.js").Player[]} players - Eligible humans.
     * @param {Function|null} onIdle - Callback receiving an expired player's name.
     */
    refresh(players, onIdle) {
        this.clear();
        if (typeof onIdle === "function") {
            for (const player of players) {
                const timer = globalThis.setTimeout(this.#expire.bind(this, player, onIdle), Constants.ROOM_WAIT_MS);
                this.#timers.set(player, timer);
            }
        }
    }

    /**
     * Cancels a departing player's timer.
     * @param {import("../model/Player.js").Player} player - Player leaving eligibility.
     */
    stop(player) {
        if (this.#timers.has(player)) {
            globalThis.clearTimeout(this.#timers.get(player));
            this.#timers.delete(player);
        }
    }

    /** Cancels every timer when eligibility changes or the room closes. */
    clear() {
        for (const timer of this.#timers.values()) globalThis.clearTimeout(timer);
        this.#timers.clear();
    }

    /**
     * Reports one elapsed window after releasing its timer entry.
     * @param {import("../model/Player.js").Player} player - Expired player.
     * @param {Function} onIdle - Current room callback.
     */
    #expire(player, onIdle) {
        this.#timers.delete(player);
        onIdle(player.name);
    }
}
