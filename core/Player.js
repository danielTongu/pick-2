"use strict";

import { Constants } from "./Constants.js";
import { Serializable } from "./Serializable.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { CardCollection } from "./CardCollection.js";

/** Owns one seated player’s identity, hand, match state, and idle timer. */
export class Player extends Serializable {
    /**
     * @type {Function|null} Callback invoked with this player after its idle window expires.
     */
    onIdle = null;

    /**
     * @type {*|null} Active idle timeout identifier.
     */
    #idleTimeoutId = null;

    /**
     * @type {Object|null} Match-owned fields restored for each match.
     */
    #initialState = null;

    /**
     * Creates a player with private card storage and resettable match state.
     * @param {string} name - Display name.
     * @param {Object|null} initialState - Match-owned reset values.
     */
    constructor(name, initialState = null) {
        super();

        this.name = ValidationUtils.namedString(name, "Player name", ValidationUtils.playerNameMaxLength);
        this.key = Player.normalizeKey(this.name);
        this.state = Constants.PLAYER_STATE.READY;
        this.collection = new CardCollection();

        if (initialState !== null) {
            if (typeof initialState !== "object" || Array.isArray(initialState)) {
                throw new Error("Player initial state must be an object.");
            }
            this.#initialState = { ...initialState };
            Object.assign(this, this.#initialState);
        }
    }

    /**
     * Normalizes stable player key.
     *
     * @param {*} value - Raw player name or key.
     * @returns {string} Normalized key.
     * @throws {Error} When the supplied player identity cannot be normalized.
     */
    static normalizeKey(value) {
        return ValidationUtils.requiredString(value, "Player name")
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^\p{L}\p{N}_-]/gu, "");
    }

    /**
     * Restarts idle monitoring when enabled.
     */
    recordActivity() {
        this.#clearIdleTimeout();

        if (this.onIdle !== null) {
            this.#idleTimeoutId = globalThis.setTimeout(this.#handleIdleTimeout.bind(this), Constants.ROOM_WAIT_MS);
        }
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
     * Clears the elapsed timer and reports this player through the current idle callback.
     */
    #handleIdleTimeout() {
        this.#idleTimeoutId = null;

        if (this.onIdle !== null) {
            this.onIdle(this);
        }
    }

    /**
     * Cancels the current idle timer and removes its callback.
     */
    stopIdleMonitoring() {
        this.#clearIdleTimeout();
        this.onIdle = null;
    }

    /** Restores collection and match-provided state. */
    reset() {
        if (this.collection instanceof CardCollection) {
            this.collection.clear();
        }
        if (this.#initialState !== null) {
            Object.assign(this, this.#initialState);
        }
        this.state = Constants.PLAYER_STATE.READY;
        this.recordActivity();
    }
}
