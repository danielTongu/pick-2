"use strict";

import { Constants } from "../shared/Constants.js";
import { Serializable } from "./Serializable.js";
import { ValidationUtils } from "../shared/ValidationUtils.js";
import { CardCollection } from "./CardCollection.js";

/** Owns one seated player’s identity, hand, and match state. */
export class Player extends Serializable {
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

        this.name = ValidationUtils.namedString(name, "Player name", ValidationUtils.PLAYER_NAME_MAX_LENGTH);
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

    /** Restores collection and match-provided state. */
    reset() {
        if (this.collection instanceof CardCollection) {
            this.collection.clear();
        }
        if (this.#initialState !== null) {
            Object.assign(this, this.#initialState);
        }
        this.state = Constants.PLAYER_STATE.READY;
    }
}
