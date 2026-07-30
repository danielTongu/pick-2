// server/PlayerCircle.js

"use strict";

import { Serializable } from "./Serializable.js";
import { UserNotification } from "./UserNotification.js";
import { Player } from "./Player.js";
import { AssertUtils } from "../public/scripts/utils/AssertUtils.js";
import { NormalizeUtils } from "../public/scripts/utils/NormalizeUtils.js";

/**
 * Maintains player turn order in a circular linked structure.
 */
export class PlayerCircle extends Serializable {
    /**
     * Creates a player circle.
     */
    constructor() {
        super();

        const now = Date.now();

        /** @type {Map<string, Player>} */
        this.players = new Map();

        /** @type {string|null} */
        this.firstKey = null;

        /** @type {string|null} */
        this.lastKey = null;

        /** @type {string|null} */
        this.turnOwnerKey = null;

        /** @type {number} */
        this.direction = 1;

        /** @type {number} */
        this.createdAt = now;

        /** @type {number} */
        this.lastActiveAt = now;
    }

    /**
     * Updates last active timestamp.
     *
     * @returns {number} Last active timestamp.
     */
    #recordActivity() {
        this.lastActiveAt = Date.now();

        return this.lastActiveAt;
    }

    /**
     * Returns whether there are no players.
     *
     * @returns {boolean} True when empty.
     */
    isEmpty() {
        return this.players.size === 0;
    }

    /**
     * Gets turn owner.
     *
     * @returns {Player|null} Turn owner.
     */
    getTurnOwner() {
        let player = null;

        if (this.turnOwnerKey !== null) {
            player = this.players.get(this.turnOwnerKey) ?? null;
        }

        return player;
    }

    /**
     * Requires the assigned turn owner.
     *
     * @returns {Player} Turn owner.
     * @throws {Error} When no turn owner is assigned.
     */
    requireTurnOwner() {
        const player = this.getTurnOwner();

        if (player === null) {
            throw new Error("Turn owner is not assigned.");
        }

        return player;
    }

    /**
     * Gets a player by name or key.
     *
     * @param {string} nameOrKey - Player name or key.
     * @returns {Player} Player.
     * @throws {Error}
     */
    getPlayer(nameOrKey) {
        const key = Player.normalizeKey(nameOrKey);
        const player = this.players.get(key) ?? null;

        if (player === null) {
            throw new UserNotification(`Player does not exist: ${nameOrKey}`);
        }

        return player;
    }

    /**
     * Adds a player to the circle tail.
     *
     * @param {Player} player - Player to add.
     * @returns {Player} Added player.
     * @throws {Error}
     */
    addPlayer(player) {
        AssertUtils.instanceOf(player, Player, "Player");

        if (this.players.has(player.key)) {
            throw new UserNotification(`Player already exists: ${player.name}`);
        }

        if (this.players.size === 0) {
            this.#addFirstPlayer(player);
        } else {
            this.#appendPlayer(player);
        }

        this.#recordActivity();

        return player;
    }

    /**
     * Removes a player.
     *
     * @param {string} nameOrKey - Player name or key.
     * @returns {Player} Removed player.
     * @throws {Error}
     */
    removePlayer(nameOrKey) {
        const key = Player.normalizeKey(nameOrKey);
        const player = this.getPlayer(key);

        if (this.players.size === 1) {
            this.#removeOnlyPlayer(key);
        } else {
            this.#unlinkPlayerFromCircle(player);
            this.players.delete(key);
        }

        this.#recordActivity();

        return player;
    }

    /**
     * Sets or clears the turn owner.
     *
     * @param {string|null} nameOrKey - Player name or key, or null to clear.
     * @throws {Error}
     */
    setTurnOwner(nameOrKey) {
        if (nameOrKey === null) {
            this.turnOwnerKey = null;
        } else {
            const key = Player.normalizeKey(nameOrKey);

            if (!this.players.has(key)) {
                throw new Error(`Player does not exist: ${nameOrKey}`);
            }

            this.turnOwnerKey = key;
        }

        this.#recordActivity();
    }

    /**
     * Moves turn owner by steps.
     *
     * @param {number} steps - Number of steps to move.
     * @returns {boolean} True when moved.
     * @throws {Error}
     */
    moveTurnOwner(steps = 1) {
        NormalizeUtils.integer(steps, "Steps");

        let isMoved = false;

        if (this.turnOwnerKey !== null && this.players.size > 0) {
            const player = this.#findRelativePlayer(this.turnOwnerKey, steps);

            if (player !== null) {
                this.turnOwnerKey = player.key;
                isMoved = true;
                this.#recordActivity();
            }
        }

        return isMoved;
    }

    /**
     * Peeks player relative to turn owner.
     *
     * @param {number} steps - Number of steps to peek.
     * @returns {Player|null} Peeked player.
     * @throws {Error}
     */
    getRelativePlayer(steps = 1) {
        NormalizeUtils.integer(steps, "Steps");

        let player = null;

        if (this.turnOwnerKey !== null) {
            player = this.#findRelativePlayer(this.turnOwnerKey, steps);
        }

        return player;
    }

    /**
     * Reverses turn direction.
     *
     * @returns {number} New direction.
     */
    reverseTurnDirection() {
        this.direction *= -1;
        this.#recordActivity();

        return this.direction;
    }

    /**
     * Resets turn cursor and player round state.
     */
    reset() {
        this.turnOwnerKey = null;
        this.direction = 1;

        for (const player of this.players.values()) {
            player.reset();
        }

        this.#recordActivity();
    }

    /**
     * Seeks from a key by steps using current direction.
     *
     * @param {string} fromKey - Starting player key.
     * @param {number} steps - Steps to seek.
     * @returns {Player|null} Found player.
     * @throws {Error}
     */
    #findRelativePlayer(fromKey, steps) {
        NormalizeUtils.integer(steps, "Steps");

        let currentKey = Player.normalizeKey(fromKey);
        let remaining = Math.abs(steps);
        const direction = steps < 0 ? -this.direction : this.direction;

        while (remaining > 0) {
            const current = this.players.get(currentKey) ?? null;

            if (current === null) {
                currentKey = "";
                remaining = 0;
            } else if (direction > 0) {
                currentKey = current.nextKey;
                remaining -= 1;
            } else {
                currentKey = current.prevKey;
                remaining -= 1;
            }
        }

        return currentKey ? this.players.get(currentKey) ?? null : null;
    }

    /**
     * Requires stored player by key.
     *
     * @param {string|null} key - Player key.
     * @returns {Player} Stored player.
     * @throws {Error}
     */
    #requirePlayerByKey(key) {
        const player = key === null ? null : this.players.get(key) ?? null;

        if (player === null) {
            throw new Error("PlayerCircle is corrupted.");
        }

        return player;
    }

    /**
     * Iterates live players in insertion order.
     *
     * @returns {IterableIterator<Player>} Player iterator.
     */
    [Symbol.iterator]() {
        return this.players.values();
    }

    /**
     * Serializes circle state.
     *
     * @returns {{
     *     players:Object[],
     *     playerCount:number,
     *     turnOwnerKey:string|null,
     *     direction:number,
     *     createdAt:number,
     *     lastActiveAt:number
     * }} JSON-safe circle state.
     */
    toJSON() {
        const players = [];

        for (const player of this.players.values()) {
            players.push(player.toJSON());
        }

        return {
            players,
            playerCount: this.players.size,
            turnOwnerKey: this.turnOwnerKey,
            direction: this.direction,
            createdAt: this.createdAt,
            lastActiveAt: this.lastActiveAt
        };
    }

    /**
     * Adds the first player.
     *
     * @param {Player} player - Player to add.
     */
    #addFirstPlayer(player) {
        player.setTurnLinks(player.key, player.key);

        this.players.set(player.key, player);
        this.firstKey = player.key;
        this.lastKey = player.key;
        this.turnOwnerKey = null;
    }

    /**
     * Appends a player after the current last player.
     *
     * @param {Player} player - Player to append.
     */
    #appendPlayer(player) {
        const first = this.#requirePlayerByKey(this.firstKey);
        const last = this.#requirePlayerByKey(this.lastKey);

        player.setTurnLinks(first.key, last.key);
        last.setTurnLinks(player.key, last.prevKey);
        first.setTurnLinks(first.nextKey, player.key);

        this.players.set(player.key, player);
        this.lastKey = player.key;
    }

    /**
     * Removes the only player.
     *
     * @param {string} key - Player key.
     */
    #removeOnlyPlayer(key) {
        this.players.delete(key);
        this.firstKey = null;
        this.lastKey = null;
        this.turnOwnerKey = null;
    }

    /**
     * Unlinks a player from the circle.
     *
     * @param {Player} player - Player to unlink.
     */
    #unlinkPlayerFromCircle(player) {
        const prev = this.#requirePlayerByKey(player.prevKey);
        const next = this.#requirePlayerByKey(player.nextKey);

        prev.setTurnLinks(next.key, prev.prevKey);
        next.setTurnLinks(next.nextKey, prev.key);

        if (player.key === this.firstKey) {
            this.firstKey = next.key;
        }

        if (player.key === this.lastKey) {
            this.lastKey = prev.key;
        }

        if (player.key === this.turnOwnerKey) {
            this.turnOwnerKey = this.direction > 0 ? next.key : prev.key;
        }

        player.setTurnLinks(null, null);
    }

}
