
"use strict";

import { Constants } from "../core/Constants.js";
import { DomUtils } from "./DomUtils.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton suit-selection overlay.
 */
export class SuitSelectionController extends ViewController {
    /** @type {Function|null} */
    #submitHandler = null;

    /** @type {HTMLButtonElement} */
    #submitButton;

    /** @type {number|null} */
    #timeoutId = null;

    /**
     * Creates a suit-selection overlay controller.
     *
     * @param {string} selector - Overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        super(selector);
        this.#submitButton = DomUtils.requireChild(
            this.root,
            "#suit-selection-submit-button",
            HTMLButtonElement
        );

        this.#bindEvents();
    }

    /**
     * Shows the overlay unless it is temporarily dismissed.
     */
    show() {
        if (this.#timeoutId === null) {
            super.show();
        }
    }

    /**
     * Hides the overlay and cancels a temporary dismissal.
     */
    hide() {
        this.#clearTimeout();
        super.hide();
    }

    /**
     * Sets the callback invoked after suit selection.
     *
     * @param {Function} handler - Submit callback.
     * @throws {Error}
     */
    setSubmitHandler(handler) {
        if (typeof handler !== "function") {
            throw new Error("Suit selection submit handler must be a function.");
        }

        this.#submitHandler = handler;
    }

    /**
     * Binds overlay events.
     */
    #bindEvents() {
        const timeoutButton = DomUtils.requireChild(
            this.root,
            "#suit-selection-dismiss-button",
            HTMLButtonElement
        );

        timeoutButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.#temporarilyDismiss();
        }.bind(this));

        this.#submitButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.#submitSelectedSuit();
        }.bind(this));
    }

    /**
     * Hides the overlay for the shared countdown duration.
     */
    #temporarilyDismiss() {
        this.#clearTimeout();
        super.hide();

        this.#timeoutId = window.setTimeout(() => {
            this.#timeoutId = null;
            super.show();
        }, Constants.COUNTDOWN_SECONDS * 1000);
    }

    /**
     * Cancels the active temporary-dismiss timer.
     */
    #clearTimeout() {
        if (this.#timeoutId !== null) {
            window.clearTimeout(this.#timeoutId);
            this.#timeoutId = null;
        }
    }

    /**
     * Submits the selected suit.
     */
    #submitSelectedSuit() {
        const selected = this.#getSelectedSuit();

        if (selected !== null) {
            this.hide();

            if (this.#submitHandler !== null) {
                this.#submitHandler(selected);
            }
        }
    }

    /**
     * Gets the selected suit.
     *
     * @returns {string|null} Selected suit.
     */
    #getSelectedSuit() {
        const selected = this.root.querySelector(
            "input[name='suit']:checked"
        );

        return selected instanceof HTMLInputElement ? selected.value : null;
    }
}
