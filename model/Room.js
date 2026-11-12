"use strict";

import { Serializable } from "./Serializable.js";
import { Constants } from "../shared/Constants.js";
import { ValidationUtils } from "../shared/ValidationUtils.js";
import { UserNotification } from "../shared/UserNotification.js";
import { Match } from "./Match.js";
import { Knockout } from "./Knockout.js";

/** In-memory room identity, membership state, current match, and activity. */
export class Room extends Serializable {
    /**
     * Creates a room with a given name and player limit.
     *
     * @param {string} roomName - Match room name.
     * @param {number} playerLimit - Maximum number of seated players.
     * @throws {Error} When a value violates an internal room invariant.
     */
    constructor(roomName, playerLimit = Constants.ROOM_PLAYER_LIMIT) {
        super();
        this.name = ValidationUtils.namedString(roomName, "Room name", ValidationUtils.ROOM_NAME_MAX_LENGTH);
        this.playerLimit = Room.#normalizePlayerLimit(playerLimit);
        this.match = new Match();
        this.createdAt = Date.now();
        this.lastActiveAt = this.createdAt;
        this.viewers = new Set();
    }

    /** Returns whether the room has no seated players. */
    isEmpty() {
        return this.match.turnOrder.players.size === 0;
    }

    /** Returns whether player capacity has been reached. */
    isFull() {
        return this.match.turnOrder.players.size >= this.playerLimit;
    }

    /**

     * Returns whether a normalized player identity is seated.
     * @param {string} playerNameOrKey - Player name or normalized key.
     * @returns {boolean} Whether the Player is seated.
     */
    hasPlayer(playerNameOrKey) {
        try {
            return this.match.turnOrder.has(playerNameOrKey);
        } catch (_error) {
            return false;
        }
    }

    /**
     * Returns whether turn-based play rules are currently active.
     *
     * @returns {boolean} Whether the match is active.
     */
    isMatchActive() {
        return this.match.state === Constants.ROOM_STATE.ACTIVE;
    }

    /** Serializes room identity and its nested match without duplicating match fields. */
    toJSON() {
        return {
            ...super.toJSON(null, ["match"]),
            match: {
                ...this.match.toJSON(),
                isKnockout: this.match instanceof Knockout,
                isKnockoutComplete: this.match instanceof Knockout && this.match.isKnockoutComplete
            }
        };
    }

    /**
     * Normalizes the Room player limit.
     *
     * @param {*} value - Value.
     * @returns {number} Player limit.
     * @throws {Error} When a value violates an internal room invariant.
     */
    static #normalizePlayerLimit(value) {
        const isValid = Number.isInteger(value) && value >= 2 && value <= Constants.ROOM_PLAYER_LIMIT;

        if (!isValid) {
            throw new UserNotification(`Limit must be between 2 and ${Constants.ROOM_PLAYER_LIMIT}.`);
        }

        return value;
    }
}
