"use strict";

/**
 * Shared turn-ownership predicates for server and browser code.
 */
export class TurnUtils {
    /**
     * Checks whether a turn owner key is assigned.
     *
     * @param {string|null|undefined} turnOwnerKey - Turn owner key.
     * @returns {boolean} True when an owner key is assigned.
     */
    static hasTurnOwner(turnOwnerKey) {
        return typeof turnOwnerKey === "string" && turnOwnerKey.length > 0;
    }

    /**
     * Checks whether a player key owns the turn.
     *
     * @param {string|null|undefined} turnOwnerKey - Turn owner key.
     * @param {string|null|undefined} playerKey - Player key.
     * @returns {boolean} True when the keys identify the same player.
     */
    static isTurnOwner(turnOwnerKey, playerKey) {
        return TurnUtils.hasTurnOwner(turnOwnerKey) && turnOwnerKey === playerKey;
    }
}
