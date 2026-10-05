"use strict";

import { ValidationUtils } from "../../core/ValidationUtils.js";

/**
 * DOM utility helpers.
 */
export class DomUtils {
    /**
     * Requires a DOM element from a selector or existing element.
     *
     * @param {string|Element} target - CSS selector or element.
     * @param {Function} Type - Expected constructor.
     * @returns {Element} Matching element.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    static require(target, Type) {
        let element = null;

        if (typeof target === "string") {
            element = document.querySelector(target);
        } else if (target instanceof Element) {
            element = target;
        } else {
            throw new Error("DOM target must be a selector or Element.");
        }

        DomUtils.assertType(element, Type, String(target));

        return element;
    }

    /**
     * Requires a child element inside a parent scope.
     *
     * @param {*} scope - Parent search scope.
     * @param {string} selector - CSS selector.
     * @param {Function} Type - Expected constructor.
     * @returns {Element} Matching child.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    static requireChild(scope, selector, Type) {
        DomUtils.assertSearchScope(scope);

        const element = scope.querySelector(selector);

        DomUtils.assertType(element, Type, selector);

        return element;
    }

    /**
     * Validates a querySelector-capable scope.
     *
     * @param {*} scope - Scope to validate.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    static assertSearchScope(scope) {
        if (typeof scope !== "object" || scope === null || typeof scope.querySelector !== "function") {
            throw new Error("DOM scope must support querySelector().");
        }
    }

    /**
     * Validates an element type.
     *
     * @param {*} element - Element to validate.
     * @param {Function} Type - Expected constructor.
     * @param {string} label - Error label.
     * @returns {Element} Valid element.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    static assertType(element, Type, label) {
        if (!(element instanceof Type)) {
            throw new Error(`Missing or invalid DOM element: ${label}.`);
        }

        return element;
    }

    /**
     * Validates an HTMLElement.
     *
     * @param {*} element - Element to validate.
     * @returns {HTMLElement} Valid element.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    static assertElement(element) {
        if (!(element instanceof HTMLElement)) {
            throw new Error("DOM element must be an HTMLElement.");
        }

        return element;
    }

    /**
     * Shows an element.
     *
     * @param {HTMLElement} element - Element to show.
     */
    static show(element) {
        DomUtils.assertElement(element);
        element.hidden = false;
    }

    /**
     * Hides an element.
     *
     * @param {HTMLElement} element - Element to hide.
     */
    static hide(element) {
        DomUtils.assertElement(element);
        element.hidden = true;
    }

    /**
     * Assigns a boolean dataset state as its string representation.
     *
     * @param {HTMLElement} element - Target element.
     * @param {string} name - Dataset name.
     * @param {boolean} isEnabled - Whether state is enabled.
     */
    static setBooleanState(element, name, isEnabled) {
        DomUtils.assertElement(element);
        element.dataset[name] = String(ValidationUtils.boolean(isEnabled, "Dataset state value"));
    }
}
