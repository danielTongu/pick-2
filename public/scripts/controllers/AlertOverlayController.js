// public/scripts/AlertOverlayController.js

"use strict";

import { DomUtils } from "../utils/DomUtils.js";

/**
 * Controls the singleton alert overlay.
 */
export class AlertOverlayController {
    /** @type {HTMLElement} */
    #dialog;

    /** @type {HTMLElement} */
    #icon;

    /** @type {HTMLElement} */
    #title;

    /** @type {HTMLOutputElement} */
    #message;

    /** @type {HTMLButtonElement} */
    #confirmButton;

    /**
     * Creates an alert overlay controller.
     *
     * @param {string} selector - Alert overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        this.#dialog = DomUtils.require(selector, HTMLElement);
        this.#icon = DomUtils.requireChild(this.#dialog, "#alert-icon", HTMLElement);
        this.#title = DomUtils.requireChild(this.#dialog, "#alert-title", HTMLElement);
        this.#message = DomUtils.requireChild(this.#dialog, "#alert-message", HTMLOutputElement);
        this.#confirmButton = DomUtils.requireChild(this.#dialog, "#alert-confirm-button", HTMLButtonElement);

        this.#bindEvents();
    }

    /**
     * Shows the alert overlay with message data.
     *
     * @param {{status:string,title:string,message:string}} message - Canonical alert message.
     * @throws {Error}
     */
    show(message) {
        this.#dialog.dataset.status = message.status;
        this.#icon.dataset.icon = message.status;
        this.#title.textContent = message.title;
        this.#message.textContent = message.message;

        DomUtils.show(this.#dialog);
    }

    /**
     * Hides the alert overlay.
     */
    hide() {
        DomUtils.hide(this.#dialog);
    }

    /**
     * Binds alert overlay events.
     */
    #bindEvents() {
        this.#confirmButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.hide();
        }.bind(this));
    }

}
