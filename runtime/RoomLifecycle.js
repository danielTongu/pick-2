"use strict";

/** Owns deferred room-lifecycle work and its timer resources. */
export class RoomLifecycle {

    /**
     * @type {Map<string, number|NodeJS.Timeout>} Pending timers keyed by normalized room identity.
     */
    #timers = new Map();

    /**
     * @param {string} roomKey - Normalized room key.
     * @returns {boolean} Whether lifecycle work is pending.
     */
    hasPending(roomKey) {
        return this.#timers.has(roomKey);
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @param {number} delayMs - Delay in milliseconds.
     * @param {function(string): void} callback - Deferred room callback.
     */
    schedule(roomKey, delayMs, callback) {
        this.cancel(roomKey);
        const timeoutId = globalThis.setTimeout(this.#run.bind(this, roomKey, callback), delayMs);
        timeoutId.unref?.();
        this.#timers.set(roomKey, timeoutId);
    }

    /**
     * @param {string} roomKey - Normalized room key.
     */
    cancel(roomKey) {
        const timeoutId = this.#timers.get(roomKey);
        if (timeoutId !== undefined) {
            globalThis.clearTimeout(timeoutId);
            this.#timers.delete(roomKey);
        }
    }

    /** Cancels all pending lifecycle callbacks. */
    clear() {
        for (const timeoutId of this.#timers.values()) globalThis.clearTimeout(timeoutId);
        this.#timers.clear();
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @param {function(string): void} callback - Deferred callback.
     */
    #run(roomKey, callback) {
        this.#timers.delete(roomKey);
        callback(roomKey);
    }
}
