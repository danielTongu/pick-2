
"use strict";

import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { UserNotification } from "../core/UserNotification.js";

/**
 * Lightweight in-memory request throttle.
 */
export class ThrottleGuard {
    /** @type {Map<string, number>} */
    #lastRequestAtByKey = new Map();

    /**
     * Enforces throttle for a websocket.
     *
     * @param {*} ws - WebSocket.
     * @param {string} eventType - Event type.
     * @param {number} [windowMs=75] - Minimum interval.
     */
    enforceSocketThrottle(ws, eventType, windowMs = 75) {
        const tabId = typeof ws?.tabId === "string" && ws.tabId.trim()
            ? ws.tabId.trim()
            : "anonymous";

        this.#enforceRateLimit(`socket:${tabId}:${eventType}`, windowMs);
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
            `player:${NormalizeUtils.requiredString(tabId, "tabId")}:${eventType}`,
            windowMs
        );
    }

    /**
     * Enforces throttle for a session.
     *
     * @param {string} sessionKey - Session key.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceSessionThrottle(sessionKey, eventType, windowMs) {
        this.#enforceRateLimit(
            `session:${NormalizeUtils.requiredString(sessionKey, "sessionKey")}:${eventType}`,
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
        const normalizedKey = NormalizeUtils.requiredString(key, "Throttle key");
        const normalizedWindow = NormalizeUtils.nonNegativeInteger(windowMs, "Throttle window");

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
        const text = NormalizeUtils.requiredString(prefix, "Throttle reset prefix");

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
        const age = NormalizeUtils.nonNegativeInteger(maxAgeMs, "Maximum age");

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
