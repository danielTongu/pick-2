// public/scripts/CountdownOverlayController.js

"use strict";

import { DomUtils } from "../utils/DomUtils.js";
import { NormalizeUtils } from "../utils/NormalizeUtils.js";

/**
 * Controls the singleton countdown overlay.
 */
export class CountdownOverlayController {
    /** @type {number|null} */
    #countdownIntervalId = null;

    /** @type {HTMLElement} */
    #dialog;

    /** @type {HTMLOutputElement} */
    #remainingSecondsOutput;

    /** @type {HTMLButtonElement} */
    #confirmButton;

    /**
     * Creates a countdown overlay controller.
     *
     * @param {string} selector - Countdown overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        this.#dialog = DomUtils.require(selector, HTMLElement);
        this.#remainingSecondsOutput = DomUtils.requireChild(this.#dialog, "#countdown-value", HTMLOutputElement);
        this.#confirmButton = DomUtils.requireChild(this.#dialog, "#countdown-confirm-button", HTMLButtonElement);

        this.#bindEvents();
    }

    /**
     * Shows the countdown overlay.
     *
     * @param {number} seconds - Countdown duration.
     */
    show(seconds = 5) {
        let remaining = CountdownOverlayController.#normalizeSeconds(seconds);

        this.#stopCountdown();
        this.#renderRemainingSeconds(remaining);

        DomUtils.show(this.#dialog);

        this.#countdownIntervalId = window.setInterval(function () {
            remaining -= 1;
            this.#renderRemainingSeconds(remaining);

            if (remaining <= 0) {
                this.hide();
            }
        }.bind(this), 1000);
    }

    /**
     * Hides the countdown overlay.
     */
    hide() {
        this.#stopCountdown();
        DomUtils.hide(this.#dialog);
    }

    /**
     * Binds overlay events.
     */
    #bindEvents() {
        this.#confirmButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.hide();
        }.bind(this));
    }

    /**
     * Stops the active countdown timer.
     */
    #stopCountdown() {
        if (this.#countdownIntervalId !== null) {
            window.clearInterval(this.#countdownIntervalId);
            this.#countdownIntervalId = null;
        }
    }

    /**
     * Renders the remaining countdown seconds.
     *
     * @param {number} seconds - Remaining seconds.
     */
    #renderRemainingSeconds(seconds) {
        this.#remainingSecondsOutput.textContent = String(Math.max(0, Math.floor(seconds)));
    }

    /**
     * Normalizes countdown seconds.
     *
     * @param {*} seconds - Raw seconds.
     * @returns {number} Normalized seconds.
     */
    static #normalizeSeconds(seconds) {
        let value = Number(seconds);

        if (!Number.isFinite(value) || value < 1) {
            value = 5;
        }

        return NormalizeUtils.nonNegativeNumber(value, "Countdown seconds");
    }
}
