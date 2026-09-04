
"use strict";

/** In-memory throttling service used by Host action boundaries. */

import { ValidationUtils } from "../core/ValidationUtils.js";
import { UserNotification } from "../core/UserNotification.js";

/**
 * Lightweight in-memory request throttle.
 */
export class RateLimit {
    /** @type {Map<string, number>} */
    #lastRequestAtByKey = new Map();

    /**
     * Enforces throttle for a connected peer.
     *
     * @param {*} peer - Connected peer.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceConnection(peer, eventType, windowMs) {
        const tabId = typeof peer?.tabId === "string" && peer.tabId.trim()
            ? peer.tabId.trim()
            : peer?.id ?? "anonymous";

        this.#enforceRateLimit(`connection:${tabId}:${eventType}`, windowMs);
    }

    /**
     * Enforces throttle for a player.
     *
     * @param {string} tabId - Browser tab id.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforcePlayerThrottle(tabId, eventType, windowMs) {
        this.#enforceRateLimit(
            `player:${ValidationUtils.requiredString(tabId, "tabId")}:${eventType}`,
            windowMs
        );
    }

    /**
     * Enforces throttle for a room.
     *
     * @param {string} roomKey - Normalized room key.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceRoomThrottle(roomKey, eventType, windowMs) {
        this.#enforceRateLimit(
            `room:${ValidationUtils.requiredString(roomKey, "roomKey")}:${eventType}`,
            windowMs
        );
    }

    /**
     * Enforces throttle for a key.
     *
     * @param {string} key - Throttle key.
     * @param {number} windowMs - Minimum interval.
     * @throws {Error}
     */
    #enforceRateLimit(key, windowMs) {
        const normalizedKey = ValidationUtils.requiredString(key, "Throttle key");
        const normalizedWindow = ValidationUtils.nonNegativeInteger(windowMs, "Throttle window");

        const now = Date.now();
        const previous = this.#lastRequestAtByKey.get(normalizedKey) ?? 0;

        if (now - previous < normalizedWindow) {
            throw new UserNotification("Too many requests. Please slow down.");
        }

        this.#lastRequestAtByKey.set(normalizedKey, now);
    }

    /**
     * Removes matching throttle keys.
     *
     * @param {string} prefix - Key prefix.
     */
    reset(prefix) {
        const text = ValidationUtils.requiredString(prefix, "Throttle reset prefix");

        for (const key of this.#lastRequestAtByKey.keys()) {
            if (key === text || key.startsWith(`${text}:`)) {
                this.#lastRequestAtByKey.delete(key);
            }
        }
    }

    /**
     * Removes throttle entries older than the specified age.
     *
     * @param {number} maxAgeMs - Maximum age in milliseconds.
     */
    prune(maxAgeMs) {
        const age = ValidationUtils.nonNegativeInteger(maxAgeMs, "Maximum age");

        const cutoff = Date.now() - age;

        for (const [key, timestamp] of this.#lastRequestAtByKey.entries()) {
            if (timestamp < cutoff) {
                this.#lastRequestAtByKey.delete(key);
            }
        }
    }

    /**
     * Removes every throttle record.
     */
    resetAll() {
        this.#lastRequestAtByKey.clear();
    }

}
