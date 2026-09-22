"use strict";

/** Turn-ownership predicates shared by domain and browser code. */
export class TurnUtils {
    /**
     * Returns whether a turn-owner key is assigned.
     * @param {string|null} ownerKey - Current turn-owner key.
     * @returns {boolean} Whether ownership is assigned.
     */
    static hasTurnOwner(ownerKey) {
        return typeof ownerKey === "string" && ownerKey.length > 0;
    }

    /**

     * Returns whether an actor owns the current turn.
     * @param {string|null} ownerKey - Current turn-owner key.
     * @param {string} actorKey - Actor key to compare.
     * @returns {boolean} Whether the Actor owns the turn.
     */
    static isTurnOwner(ownerKey, actorKey) {
        return TurnUtils.hasTurnOwner(ownerKey) && ownerKey === actorKey;
    }
}
