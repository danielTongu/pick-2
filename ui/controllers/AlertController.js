"use strict";

import { DomUtils } from "../utilities/DomUtils.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { ViewController } from "./ViewController.js";

/** Controls the singleton alert overlay. */
export class AlertController extends ViewController {

    /** @type {string} Current notification status. */
    #status;

    /** @type {HTMLElement} Required UI element owned by this controller. */
    #title;

    /** @type {HTMLElement} Required UI element owned by this controller. */
    #message;

    /**
     * Creates an alert overlay controller.
     *
     * @param {string} selector - Alert overlay selector.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(selector) {
        super(selector);
        this.#status = ValidationUtils.requiredString(this.root.dataset.status, "Alert data-status");
        this.#title = DomUtils.requireChild(this.root, "#alert-title", HTMLElement);
        this.#message = DomUtils.requireChild(this.root, "#alert-message", HTMLElement);
        this.bindDismissButton("#alert-ok-button");
    }

    /**
     * Shows the alert overlay with message data.
     *
     * @param {{status:string,title:string,message:string}} message - Canonical alert message.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    show(message) {
        this.#status = message.status;
        this.root.dataset.status = this.#status;
        this.#title.textContent = message.title;
        this.#message.textContent = message.message;

        super.show();
    }
}
