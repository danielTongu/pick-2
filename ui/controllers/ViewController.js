"use strict";

import { DomUtils } from "../utilities/DomUtils.js";

/**
 * Base class for controllers that own one visible page element.
 */
export class ViewController {
    /** @type {HTMLElement} Required UI element owned by this controller. */
    root;

    /** @type {import("../../runtime/Client.js").Client|null} Client assigned by the owning page lifecycle. */
    client;

    /**
     * Creates a controller for one view root.
     *
     * @param {string|HTMLElement} target - View selector or element.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(target) {
        this.root = DomUtils.require(target, HTMLElement);
        this.client = null;
    }

    /**
     * Shows the view.
     */
    show() {
        DomUtils.show(this.root);
    }

    /**
     * Hides the view.
     */
    hide() {
        DomUtils.hide(this.root);
    }

    /**
     * Binds a button that hides the view.
     *
     * @param {string} selector - Button selector within the view.
     */
    bindDismissButton(selector) {
        const button = DomUtils.requireChild(this.root, selector, HTMLButtonElement);

        button.addEventListener(
            "click",
            function (event) {
                event.preventDefault();
                this.hide();
            }.bind(this)
        );
    }
}
