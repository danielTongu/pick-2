"use strict";

import { Serializable } from "./Serializable.js";
import { UserNotification } from "./UserNotification.js";
import { Actor } from "./Actor.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { Constants } from "./Constants.js";

/** Owns ordered membership and the cursor for a turn-based game. */
export class TurnOrder extends Serializable {
    /** Creates an empty, forward-moving turn order with no owner. */
    constructor() {
        super();
        this.actors = new Map();
        this.order = [];
        this.ownerKey = null;
        this.direction = 1;
    }

    /** @returns {number} Seated actor count. */
    get size() {
        return this.actors.size;
    }

    /** @returns {Actor|null} Current turn owner. */
    get owner() {
        return this.ownerKey === null ? null : (this.actors.get(this.ownerKey) ?? null);
    }

    /** Returns whether the order contains no actors. */
    isEmpty() {
        return this.actors.size === 0;
    }

    /** Returns whether an actor identity belongs to the order. */
    has(nameOrKey) {
        return this.actors.has(Actor.normalizeKey(nameOrKey));
    }

    /** Resolves an actor identity or raises a user-facing absence error. */
    get(nameOrKey) {
        const actor = this.actors.get(Actor.normalizeKey(nameOrKey)) ?? null;
        if (actor === null) {
            throw new UserNotification(`Actor does not exist: ${nameOrKey}`);
        }
        return actor;
    }

    /** Appends a unique actor to the circle. */
    add(actor) {
        ValidationUtils.instanceOf(actor, Actor, "Actor");
        if (this.actors.has(actor.key)) {
            throw new UserNotification(`Actor already exists: ${actor.name}`);
        }
        this.actors.set(actor.key, actor);
        this.order.push(actor.key);
        return actor;
    }

    /** Removes an actor while preserving a valid owner cursor. */
    remove(nameOrKey) {
        const actor = this.get(nameOrKey);
        const index = this.order.indexOf(actor.key);
        this.order.splice(index, 1);
        this.actors.delete(actor.key);

        if (this.order.length === 0) {
            this.ownerKey = null;
        } else if (this.ownerKey === actor.key) {
            const nextIndex =
                this.direction > 0 ? index % this.order.length : (index - 1 + this.order.length) % this.order.length;
            this.ownerKey = this.order[nextIndex];
        }
        this.#synchronizeActorStates();
        return actor;
    }

    /** Assigns or clears the turn owner and synchronizes actor states. */
    setOwner(nameOrKey) {
        if (nameOrKey === null) {
            this.ownerKey = null;
        } else {
            this.ownerKey = this.get(nameOrKey).key;
        }
        this.#synchronizeActorStates();
        return this.owner;
    }

    /** Returns the owner or throws when no owner is assigned. */
    requireOwner() {
        if (this.owner === null) {
            throw new Error("Turn owner is not assigned.");
        }
        return this.owner;
    }

    /** Moves the owner cursor by signed logical steps. */
    move(steps = 1) {
        const actor = this.relative(steps);
        if (actor !== null) {
            this.setOwner(actor.key);
        }
        return actor;
    }

    /** Reads an actor relative to the owner without moving the cursor. */
    relative(steps = 1) {
        ValidationUtils.integer(steps, "Steps");
        if (this.ownerKey === null || this.order.length === 0) {
            return null;
        }
        const index = this.order.indexOf(this.ownerKey);
        const offset = steps * this.direction;
        const target = (((index + offset) % this.order.length) + this.order.length) % this.order.length;
        return this.actors.get(this.order[target]) ?? null;
    }

    /** Reverses traversal direction. */
    reverse() {
        this.direction *= -1;
        return this.direction;
    }

    /** Clears round ownership, restores direction, and resets every actor. */
    reset() {
        this.ownerKey = null;
        this.direction = 1;
        for (const actor of this.actors.values()) {
            actor.reset();
        }
    }

    /** Aligns non-final actor states with current turn ownership. */
    #synchronizeActorStates() {
        for (const actor of this.actors.values()) {
            if (actor.state !== Constants.ACTOR_STATE.WON && actor.state !== Constants.ACTOR_STATE.LOST) {
                actor.state = actor.key === this.ownerKey ? Constants.ACTOR_STATE.ACTIVE : Constants.ACTOR_STATE.READY;
            }
        }
    }

    [Symbol.iterator]() {
        return this.actors.values();
    }

    /** Serializes ordered actors and public cursor state. */
    toJSON() {
        return {
            actors: Array.from(this.actors.values(), function serialize(actor) {
                return actor.toJSON();
            }),
            actorCount: this.actors.size,
            ownerKey: this.ownerKey,
            direction: this.direction
        };
    }
}
