"use strict";

/** Orders player snapshots for local display without mutating the payload. */
export class PlayerDisplayUtils {
    /**
     * Rotates players so the local player is first while preserving circle order.
     *
     * @param {*} players - Player snapshots.
     * @param {*} localPlayerName - Local player name, when present.
     * @returns {Object[]} Ordered player snapshots.
     */
    static localFirst(players, localPlayerName) {
        const ordered = Array.isArray(players) ? [...players] : [];
        const localIndex = ordered.findIndex((player) => player?.name === localPlayerName);

        if (localIndex > 0) {
            return [...ordered.slice(localIndex), ...ordered.slice(0, localIndex)];
        }

        return ordered;
    }
}
