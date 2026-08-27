
"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { DomUtils } from "./DomUtils.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton countdown overlay.
 */
export class CountdownController extends ViewController {
    /** @type {number|null} */
    #countdownIntervalId = null;

    /** @type {HTMLOutputElement} */
    #remainingSecondsOutput;

    /**
     * Creates a countdown overlay controller.
     *
     * @param {string} selector - Countdown overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        super(selector);
        this.#remainingSecondsOutput = DomUtils.requireChild(this.root, "#countdown-value", HTMLOutputElement);
        this.bindDismissButton("#countdown-ok-button");
    }

    /**
     * Shows the countdown overlay.
     *
     * @param {number} seconds - Countdown duration.
     */
    show(seconds = Constants.COUNTDOWN_SECONDS) {
        let remaining = CountdownController.#normalizeSeconds(seconds);

        this.#stopCountdown();
        this.#renderRemainingSeconds(remaining);

        super.show();

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
        super.hide();
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
            value = Constants.COUNTDOWN_SECONDS;
        }

        return NormalizeUtils.nonNegativeNumber(value, "Countdown seconds");
    }
}
