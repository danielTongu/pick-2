"use strict";

import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton suit-selection overlay.
 */
export class SuitSelectionController extends ViewController {
    /** @type {Function|null} Optional application callback registered by the owning page. */
    #submitHandler = null;

    /** @type {HTMLButtonElement} Required command control owned by this controller. */
    #submitButton;

    /** @type {number|null} Active timeout or interval identifier. */
    #timeoutId = null;

    /**
     * Creates a suit-selection overlay controller.
     *
     * @param {string} selector - Overlay selector.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(selector) {
        super(selector);
        this.#submitButton = DomUtils.requireChild(this.root, "#suit-selection-submit-button", HTMLButtonElement);

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
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
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
        const timeoutButton = DomUtils.requireChild(this.root, "#suit-selection-timeout-button", HTMLButtonElement);

        timeoutButton.addEventListener(
            "click",
            function (event) {
                event.preventDefault();
                this.#temporarilyDismiss();
            }.bind(this)
        );

        this.#submitButton.addEventListener(
            "click",
            function (event) {
                event.preventDefault();
                this.#submitSelectedSuit();
            }.bind(this)
        );
    }

    /**
     * Hides the overlay for the shared countdown duration.
     */
    #temporarilyDismiss() {
        this.#clearTimeout();
        super.hide();

        this.#timeoutId = window.setTimeout(this.#restoreAfterTimeout.bind(this), Constants.COUNTDOWN_SECONDS * 1000);
    }

    /** Restores the overlay after a temporary dismissal. */
    #restoreAfterTimeout() {
        this.#timeoutId = null;
        super.show();
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
     * Returns the checked standard suit or null when no option is selected.
     *
     * @returns {string|null} Selected suit.
     */
    #getSelectedSuit() {
        const selected = this.root.querySelector("input[name='suit']:checked");

        return selected instanceof HTMLInputElement ? selected.value : null;
    }
}
