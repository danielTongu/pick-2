"use strict";

/** Orders player snapshots for local display without mutating Room data. */
export class PlayerDisplayUtils {
    /**
     * Rotates players so the local player is first while preserving circle order.
     *
     * @param {*} players - Player snapshots.
     * @param {*} localPlayerName - Local player name, when present.
     * @returns {Object[]} Ordered player snapshots.
     */
    static localFirst(players, localPlayerName) {
        // defensive check
        if (!Array.isArray(players)) return [];

        // First pass: find the local player
        let localPlayerIndex = -1;
        for (let i = 0; i < players.length; i++) {
            if (players[i]?.name === localPlayerName) {
                localPlayerIndex = i;
                break;
            }
        }

        // If not found or already first, return original
        if (localPlayerIndex <= 0) return players;

        // Second pass: build rotated result
        const result = [];
        for (let offset = 0; offset < players.length; offset++) {
            const rotatedIndex = (localPlayerIndex + offset) % players.length;
            result.push(players[rotatedIndex]);
        }

        return result;
    }
}
