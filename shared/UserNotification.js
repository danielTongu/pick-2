"use strict";

/**
 * Represents an expected warning or notification that is safe and useful to show directly to the user.
 */
export class UserNotification extends Error {
    /**
     * Creates a user-facing notification.
     *
     * @param {string} message - Actionable user-facing message.
     */
    constructor(message) {
        super(message);
        this.name = "UserNotification";
    }
}
