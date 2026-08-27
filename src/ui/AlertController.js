
"use strict";

import { DomUtils } from "./DomUtils.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton alert overlay.
 */
export class AlertController extends ViewController {
    /** @type {HTMLElement} */
    #icon;

    /** @type {HTMLElement} */
    #title;

    /** @type {HTMLOutputElement} */
    #message;

    /**
     * Creates an alert overlay controller.
     *
     * @param {string} selector - Alert overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        super(selector);
        this.#icon = DomUtils.requireChild(this.root, "#alert-icon", HTMLElement);
        this.#title = DomUtils.requireChild(this.root, "#alert-title", HTMLElement);
        this.#message = DomUtils.requireChild(this.root, "#alert-message", HTMLOutputElement);
        this.bindDismissButton("#alert-ok-button");
    }

    /**
     * Shows the alert overlay with message data.
     *
     * @param {{status:string,title:string,message:string}} message - Canonical alert message.
     * @throws {Error}
     */
    show(message) {
        this.root.dataset.status = message.status;
        this.#icon.dataset.icon = message.status;
        this.#title.textContent = message.title;
        this.#message.textContent = message.message;

        super.show();
    }

}
