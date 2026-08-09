
"use strict";

/**
 * Assertion helpers.
 */
export class AssertUtils {
    /**
     * Asserts an object is an instance of a constructor.
     *
     * @param {*} value - Value to validate.
     * @param {Function} Type - Expected constructor.
     * @param {string} label - Value label.
     * @returns {*} Valid instance.
     * @throws {Error}
     */
    static instanceOf(value, Type, label = "Value") {
        if (!(value instanceof Type)) {
            throw new Error(`${label} must be an instance of ${Type.name}.`);
        }

        return value;
    }

}
