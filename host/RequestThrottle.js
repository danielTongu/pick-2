"use strict";

import { UserNotification } from "../core/UserNotification.js";
import { ValidationUtils } from "../core/ValidationUtils.js";

/** Lightweight in-memory request throttle shared by direct and hosted Host. */
export class RequestThrottle {
    /**
     * @type {Map<string, number>} Most recent accepted request timestamp for each scoped key.
     */
    #lastRequestAtByKey = new Map();

    /**
     * Enforces throttle for a connected connection.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Host connection.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceConnection(connection, eventType, windowMs) {
        const tabId =
            typeof connection?.tabId === "string" && connection.tabId.trim() ? connection.tabId.trim() : (connection?.id ?? "anonymous");

        this.#enforce(`connection:${tabId}:${eventType}`, windowMs);
    }

    /**
     * Enforces throttle for a player.
     *
     * @param {string} tabId - Browser tab id.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforcePlayerThrottle(tabId, eventType, windowMs) {
        this.#enforce(`player:${ValidationUtils.requiredString(tabId, "tabId")}:${eventType}`, windowMs);
    }

    /**
     * Enforces throttle for a room.
     *
     * @param {string} roomKey - Normalized room key.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceRoomThrottle(roomKey, eventType, windowMs) {
        this.#enforce(`room:${ValidationUtils.requiredString(roomKey, "roomKey")}:${eventType}`, windowMs);
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

    /**
     * Enforces throttle for a key.
     *
     * @param {string} key - Throttle key.
     * @param {number} windowMs - Minimum interval.
     * @throws {UserNotification} When another request for the scoped key was accepted too recently.
     */
    #enforce(key, windowMs) {
        const normalizedKey = ValidationUtils.requiredString(key, "Throttle key");
        const normalizedWindow = ValidationUtils.nonNegativeInteger(windowMs, "Throttle window");

        const now = Date.now();
        const previous = this.#lastRequestAtByKey.get(normalizedKey) ?? 0;

        if (now - previous < normalizedWindow) {
            throw new UserNotification("Too many requests. Please slow down.");
        }

        this.#lastRequestAtByKey.set(normalizedKey, now);
    }
}
