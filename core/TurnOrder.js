"use strict";

import { Serializable } from "./Serializable.js";
import { UserNotification } from "./UserNotification.js";
import { Player } from "./Player.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { Constants } from "./Constants.js";

/** Owns ordered membership and the cursor for a match. */
export class TurnOrder extends Serializable {
    // ---- Public API ----

    /** Creates an empty, forward-moving turn order with no owner. */
    constructor() {
        super();
        this.players = new Map();
        this.order = [];
        this.ownerKey = null;
        this.direction = 1;
    }

    /**
     * @returns {Player|null} Current turn owner.
     */
    get owner() {
        return this.ownerKey === null ? null : (this.players.get(this.ownerKey) ?? null);
    }

    /**

     * Returns whether a player identity belongs to the order.
     * @param {string} nameOrKey - Player name or normalized key.
     * @returns {boolean} Whether the Player is seated.
     */
    has(nameOrKey) {
        return this.players.has(Player.normalizeKey(nameOrKey));
    }

    /**

     * Resolves a player identity or raises a user-facing absence error.
     * @param {string} nameOrKey - Player name or normalized key.
     * @returns {Player} Matching Player.
     * @throws {UserNotification} When the Player is absent.
     */
    get(nameOrKey) {
        const player = this.players.get(Player.normalizeKey(nameOrKey)) ?? null;
        if (player === null) {
            throw new UserNotification(`Player does not exist: ${nameOrKey}`);
        }
        return player;
    }

    /**

     * Appends a unique player to the circle.
     * @param {Player} player - Player to seat.
     * @returns {Player} Added Player.
     */
    add(player) {
        ValidationUtils.instanceOf(player, Player, "Player");
        if (this.players.has(player.key)) {
            throw new UserNotification(`Player already exists: ${player.name}`);
        }
        this.players.set(player.key, player);
        this.order.push(player.key);
        return player;
    }

    /**

     * Removes a player while preserving a valid owner cursor.
     * @param {string} nameOrKey - Player name or normalized key.
     * @returns {Player} Removed Player.
     */
    remove(nameOrKey) {
        const player = this.get(nameOrKey);
        const index = this.order.indexOf(player.key);
        this.order.splice(index, 1);
        this.players.delete(player.key);

        if (this.order.length === 0) {
            this.ownerKey = null;
        } else if (this.ownerKey === player.key) {
            const nextIndex =
                this.direction > 0 ? index % this.order.length : (index - 1 + this.order.length) % this.order.length;
            this.ownerKey = this.order[nextIndex];
        }
        this.#synchronizePlayerStates();
        return player;
    }

    /**

     * Assigns or clears the turn owner and synchronizes player states.
     * @param {string|null} nameOrKey - Player identity, or null to clear ownership.
     * @returns {Player|null} Current owner.
     */
    setOwner(nameOrKey) {
        if (nameOrKey === null) {
            this.ownerKey = null;
        } else {
            this.ownerKey = this.get(nameOrKey).key;
        }
        this.#synchronizePlayerStates();
        return this.owner;
    }

    /** Returns the owner or throws when no owner is assigned. */
    requireOwner() {
        if (this.owner === null) {
            throw new Error("Turn owner is not assigned.");
        }
        return this.owner;
    }

    /**

     * Moves the owner cursor by signed logical steps.
     * @param {number} [steps] - Signed logical positions to advance.
     * @returns {Player|null} New owner.
     */
    move(steps = 1) {
        const player = this.relative(steps);
        if (player !== null) {
            this.setOwner(player.key);
        }
        return player;
    }

    /**

     * Reads a player relative to the owner without moving the cursor.
     * @param {number} [steps] - Signed logical offset.
     * @returns {Player|null} Relative Player.
     */
    relative(steps = 1) {
        ValidationUtils.integer(steps, "Steps");
        if (this.ownerKey === null || this.order.length === 0) {
            return null;
        }
        const index = this.order.indexOf(this.ownerKey);
        const offset = steps * this.direction;
        const target = (((index + offset) % this.order.length) + this.order.length) % this.order.length;
        return this.players.get(this.order[target]) ?? null;
    }

    /** Reverses traversal direction. */
    reverse() {
        this.direction *= -1;
        return this.direction;
    }

    /** Clears match ownership, restores direction, and resets every player. */
    reset() {
        this.ownerKey = null;
        this.direction = 1;
        for (const player of this.players.values()) {
            player.reset();
        }
    }

    /** Iterates seated players in their stored circular order. */
    [Symbol.iterator]() {
        return this.players.values();
    }

    /** Serializes ordered players and public cursor state. */
    toJSON() {
        return {
            players: Array.from(this.players.values(), function serialize(player) {
                return player.toJSON();
            }),
            playerCount: this.players.size,
            ownerKey: this.ownerKey,
            direction: this.direction
        };
    }

    // ---- Implementation ----

    /** Aligns non-final player states with current turn ownership. */
    #synchronizePlayerStates() {
        for (const player of this.players.values()) {
            if (player.state !== Constants.PLAYER_STATE.WON && player.state !== Constants.PLAYER_STATE.LOST &&
                player.state !== Constants.PLAYER_STATE.QUALIFIED && player.state !== Constants.PLAYER_STATE.ELIMINATED) {
                player.state = player.key === this.ownerKey ? Constants.PLAYER_STATE.ACTIVE : Constants.PLAYER_STATE.READY;
            }
        }
    }
}
