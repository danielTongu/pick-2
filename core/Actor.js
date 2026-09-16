"use strict";

import { Constants } from "./Constants.js";
import { Serializable } from "./Serializable.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { CardCollection } from "./CardCollection.js";

/** Owns one seated actor’s identity, hand, round state, activity, and idle timer. */
export class Actor extends Serializable {
    /** @type {Function|null} Callback invoked with this actor after its idle window expires. */
    #idleHandler = null;

    /** @type {*|null} Active idle timeout identifier. */
    #idleTimeoutId = null;

    /** @type {Object|null} Game-owned fields restored for each round. */
    #initialState = null;

    /**
     * Creates an actor with private card storage and resettable game state.
     * @param {string} name - Display name.
     * @param {Object|null} initialState - Game-owned reset values.
     */
    constructor(name, initialState = null) {
        super();

        this.name = Actor.normalizeName(name);
        this.key = Actor.normalizeKey(this.name);
        this.createdAt = Date.now();
        this.lastActiveAt = this.createdAt;
        this.state = Constants.ACTOR_STATE.READY;

        this.collection = new CardCollection();

        if (initialState !== null) {
            if (typeof initialState !== "object" || Array.isArray(initialState)) {
                throw new Error("Actor initial state must be an object.");
            }
            this.#initialState = { ...initialState };
            Object.assign(this, this.#initialState);
        }
    }

    /**
     * Normalizes actor name.
     *
     * @param {*} value - Raw actor name.
     * @returns {string} Normalized name.
     * @throws {Error} When the supplied actor identity cannot be normalized.
     */
    static normalizeName(value) {
        return ValidationUtils.namedString(value, "Actor name", ValidationUtils.actorNameMaxLength);
    }

    /**
     * Normalizes stable actor key.
     *
     * @param {*} value - Raw actor name or key.
     * @returns {string} Normalized key.
     * @throws {Error} When the supplied actor identity cannot be normalized.
     */
    static normalizeKey(value) {
        return ValidationUtils.requiredString(value, "Actor name")
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^\p{L}\p{N}_-]/gu, "");
    }

    /**
     * Sets idle callback.
     *
     * @param {Function|null} callback - Idle callback.
     */
    set onIdle(callback) {
        this.#idleHandler = typeof callback === "function" ? callback : null;
    }

    /**
     * Updates activity timestamp and restarts idle timer when enabled.
     *
     * @returns {number} Last active timestamp.
     */
    recordActivity() {
        this.lastActiveAt = Date.now();
        this.#clearIdleTimeout();

        if (this.#idleHandler !== null) {
            this.#idleTimeoutId = globalThis.setTimeout(this.#handleIdleTimeout.bind(this), Constants.MAX_IDLE_MS);
        }

        return this.lastActiveAt;
    }

    /**
     * Clears the idle timer.
     */
    #clearIdleTimeout() {
        if (this.#idleTimeoutId !== null) {
            globalThis.clearTimeout(this.#idleTimeoutId);
            this.#idleTimeoutId = null;
        }
    }

    /**
     * Clears the elapsed timer and reports this actor through the current idle callback.
     */
    #handleIdleTimeout() {
        this.#idleTimeoutId = null;

        if (this.#idleHandler !== null) {
            this.#idleHandler(this);
        }
    }

    /**
     * Cancels the current idle timer and removes its callback.
     */
    stopIdleMonitoring() {
        this.#clearIdleTimeout();
        this.#idleHandler = null;
    }

    /** Restores collection and game-provided round state. */
    reset() {
        if (this.collection instanceof CardCollection) {
            this.collection.clear();
        }
        if (this.#initialState !== null) {
            Object.assign(this, this.#initialState);
        }
        this.state = Constants.ACTOR_STATE.READY;
        this.recordActivity();
    }
}
