
"use strict";

import { DomUtils } from "./DomUtils.js";

/**
 * Base class for controllers that own one visible page element.
 */
export class ViewController {
    /** @type {HTMLElement} */
    root;

    /** @type {Object|null} */
    connectionService;

    /**
     * Creates a controller for one view root.
     *
     * @param {string|HTMLElement} target - View selector or element.
     * @param {Object|null} client - Optional game service.
     * @throws {Error}
     */
    constructor(target, client = null) {
        this.root = DomUtils.require(target, HTMLElement);
        this.connectionService = client;
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

        button.addEventListener("click", function (event) {
            event.preventDefault();
            this.hide();
        }.bind(this));
    }
}
