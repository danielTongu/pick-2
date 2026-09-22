"use strict";

import { UserNotification } from "./UserNotification.js";

/**
 * Shared validation, assertion, and value-normalization helpers.
 */
export class ValidationUtils {
    /** Names must contain words separated only by spaces, apostrophes, or hyphens. */
    static namePattern = /^[\p{L}\p{N}]+(?:[ '\u2019-][\p{L}\p{N}]+)*$/u;

    /**
     * @type {number} Maximum accepted actor display-name length.
     */
    static actorNameMaxLength = 24;

    /**
     * @type {number} Maximum accepted room display-name length.
     */
    static roomNameMaxLength = 48;

    /**
     * Validates and trims a user-facing actor or room display name.
     *
     * @param {*} value - Raw name.
     * @param {string} label - Error label.
     * @param {number} maxLength - Maximum character length.
     * @returns {string} Normalized name.
     * @throws {UserNotification} When the display name is missing, malformed, or outside its length limit.
     */
    static namedString(value, label, maxLength) {
        if (typeof value !== "string") {
            throw new UserNotification(`${label} must be a string.`);
        }

        const name = value.trim();

        if (!name) {
            throw new UserNotification(`${label} cannot be empty.`);
        }

        if (name.length < 2 || name.length > maxLength || !this.namePattern.test(name)) {
            throw new UserNotification(
                `${label} must be 2-${maxLength} characters using letters, numbers, spaces, apostrophes, or hyphens.`
            );
        }

        return name;
    }

    /**
     * Asserts that a value is an instance of a constructor.
     *
     * @param {*} value - Value to validate.
     * @param {Function} Type - Expected constructor.
     * @param {string} label - Value label.
     * @returns {*} The validated value.
     * @throws {Error} When the value has the wrong type.
     */
    static instanceOf(value, Type, label = "Value") {
        if (!(value instanceof Type)) {
            throw new Error(`${label} must be an instance of ${Type.name}.`);
        }

        return value;
    }

    /**
     * Normalizes a required non-empty string.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {string} Normalized string.
     * @throws {Error} When the value does not satisfy the requested primitive or collection contract.
     */
    static requiredString(value, label = "Value") {
        if (typeof value !== "string") {
            throw new Error(`${label} must be a string.`);
        }

        const text = value.trim();

        if (!text) {
            throw new Error(`${label} cannot be empty.`);
        }

        return text;
    }

    /**
     * Normalizes an optional string.
     *
     * @param {*} value - Raw value.
     * @param {string} fallback - Fallback value.
     * @returns {string} Normalized string.
     */
    static optionalString(value, fallback = "") {
        let text = fallback;

        if (typeof value === "string") {
            text = value.trim();
        }

        return text;
    }

    /**
     * Normalizes a finite number.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {number} Normalized number.
     * @throws {Error} When the value does not satisfy the requested primitive or collection contract.
     */
    static number(value, label = "Value") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`${label} must be a finite number.`);
        }

        return value;
    }

    /**
     * Normalizes an integer.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {number} Normalized integer.
     * @throws {Error} When the value is not an integer.
     */
    static integer(value, label = "Value") {
        if (!Number.isInteger(value)) {
            throw new Error(`${label} must be an integer.`);
        }

        return value;
    }

    /**
     * Normalizes a non-negative integer.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {number} Normalized non-negative integer.
     * @throws {Error} When the value is not a non-negative integer.
     */
    static nonNegativeInteger(value, label = "Value") {
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`${label} must be a non-negative integer.`);
        }

        return value;
    }

    /**
     * Normalizes a non-negative number.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {number} Normalized number.
     * @throws {Error} When the value does not satisfy the requested primitive or collection contract.
     */
    static nonNegativeNumber(value, label = "Value") {
        const number = ValidationUtils.number(value, label);

        if (number < 0) {
            throw new Error(`${label} must be a non-negative number.`);
        }

        return number;
    }

    /**
     * Normalizes a boolean.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {boolean} Normalized boolean.
     * @throws {Error} When the value does not satisfy the requested primitive or collection contract.
     */
    static boolean(value, label = "Value") {
        if (typeof value !== "boolean") {
            throw new Error(`${label} must be a boolean.`);
        }

        return value;
    }

    /**
     * Normalizes an object.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {Object} Normalized object.
     * @throws {Error} When the value does not satisfy the requested primitive or collection contract.
     */
    static object(value, label = "Value") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error(`${label} must be an object.`);
        }

        return value;
    }

    /**
     * Normalizes an array.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {Array} Normalized array.
     * @throws {Error} When the value does not satisfy the requested primitive or collection contract.
     */
    static array(value, label = "Value") {
        if (!Array.isArray(value)) {
            throw new Error(`${label} must be an array.`);
        }

        return value;
    }
}
