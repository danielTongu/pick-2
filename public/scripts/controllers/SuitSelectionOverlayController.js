// public/scripts/SuitSelectionOverlayController.js

"use strict";

import { DomUtils } from "../utils/DomUtils.js";

/**
 * Controls the singleton suit-selection overlay.
 */
export class SuitSelectionOverlayController {
    /** @type {Function|null} */
    #submitHandler = null;

    /** @type {HTMLElement} */
    #dialog;

    /** @type {HTMLButtonElement} */
    #cancelButton;

    /** @type {HTMLButtonElement} */
    #submitButton;

    /**
     * Creates a suit-selection overlay controller.
     *
     * @param {string} selector - Overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        this.#dialog = DomUtils.require(selector, HTMLElement);
        this.#cancelButton = DomUtils.requireChild(
            this.#dialog,
            "#suit-selection-cancel-button",
            HTMLButtonElement
        );
        this.#submitButton = DomUtils.requireChild(
            this.#dialog,
            "#suit-selection-submit-button",
            HTMLButtonElement
        );

        this.#bindEvents();
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
     * Shows the overlay.
     */
    show() {
        DomUtils.show(this.#dialog);
    }

    /**
     * Hides the overlay.
     */
    hide() {
        DomUtils.hide(this.#dialog);
    }

    /**
     * Binds overlay events.
     */
    #bindEvents() {
        this.#cancelButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.hide();
        }.bind(this));

        this.#submitButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.#submitSelectedSuit();
        }.bind(this));
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
        const selected = this.#dialog.querySelector(
            "input[name='suit']:checked"
        );

        return selected instanceof HTMLInputElement ? selected.value : null;
    }
}