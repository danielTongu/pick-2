
"use strict";

/**
 * Value normalization helpers.
 */
export class NormalizeUtils {
    /**
     * Normalizes a required non-empty string.
     *
     * @param {*} value - Raw value.
     * @param {string} label - Error label.
     * @returns {string} Normalized string.
     * @throws {Error}
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
     * @throws {Error}
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
     * @throws {Error}
     */
    static nonNegativeNumber(value, label = "Value") {
        const number = NormalizeUtils.number(value, label);

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
     * @throws {Error}
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
     * @throws {Error}
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
     * @throws {Error}
     */
    static array(value, label = "Value") {
        if (!Array.isArray(value)) {
            throw new Error(`${label} must be an array.`);
        }

        return value;
    }
}
