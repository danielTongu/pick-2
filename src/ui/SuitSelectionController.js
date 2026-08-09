
"use strict";

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

        this.bindDismissButton("#suit-selection-dismiss-button");
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
     * Binds overlay events.
     */
    #bindEvents() {
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
        const selected = this.root.querySelector(
            "input[name='suit']:checked"
        );

        return selected instanceof HTMLInputElement ? selected.value : null;
    }
}
