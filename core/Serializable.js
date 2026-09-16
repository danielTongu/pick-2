"use strict";

/**
 * Base class for domain objects that produce JSON-safe snapshots.
 */
export class Serializable {
    /**
     * Creates a model instance.
     *
     * @param {Object} [data] - Optional initial model data.
     */
    constructor(data) {
        if (data !== undefined) {
            Object.assign(this, data);
        }
    }

    /**
     * Serializes this model into a JSON-safe object.
     *
     * @param {string[]|null} include - Optional field allow-list.
     * @param {string[]} exclude - Optional field deny-list.
     * @returns {Object} Serialized model data.
     */
    toJSON(include = null, exclude = []) {
        const result = {};

        for (const key of Object.keys(this)) {
            const value = this[key];

            if (Serializable.#isFieldSerializable(key, value, include, exclude)) {
                result[key] = Serializable.#serializeValue(value);
            }
        }

        return result;
    }

    /**
     * Applies private-field, allow-list, deny-list, function, and undefined-value exclusions.
     *
     * @param {string} key - Field name.
     * @param {*} value - Field value.
     * @param {string[]|null} include - Optional field allow-list.
     * @param {string[]} exclude - Optional field deny-list.
     * @returns {boolean} True when the field should be serialized.
     */
    static #isFieldSerializable(key, value, include, exclude) {
        return (
            !key.startsWith("_") &&
            !exclude.includes(key) &&
            (include === null || include.includes(key)) &&
            typeof value !== "function" &&
            value !== undefined
        );
    }

    /**
     * Recursively converts supported models and containers to JSON-safe values.
     *
     * @param {*} value - Value to serialize.
     * @returns {*} Serialized value.
     */
    static #serializeValue(value) {
        let serializedValue = value;

        if (value instanceof Serializable) {
            serializedValue = value.toJSON();
        } else if (value instanceof Date) {
            serializedValue = value.toISOString();
        } else if (Array.isArray(value)) {
            serializedValue = Serializable.#serializeArray(value);
        } else if (Serializable.#isPlainObject(value)) {
            serializedValue = Serializable.#serializeObject(value);
        } else if (value instanceof Map) {
            serializedValue = Serializable.#serializeMap(value);
        } else if (value instanceof Set) {
            serializedValue = Serializable.#serializeSet(value);
        }

        return serializedValue;
    }

    /**
     * Recursively serializes an array while preserving order.
     *
     * @param {Array} items - Array items.
     * @returns {Array} Serialized array.
     */
    static #serializeArray(items) {
        const serializedItems = [];

        for (const item of items) {
            serializedItems.push(Serializable.#serializeValue(item));
        }

        return serializedItems;
    }

    /**
     * Recursively serializes enumerable fields of a plain object.
     *
     * @param {Object} object - Plain object.
     * @returns {Object} Serialized object.
     */
    static #serializeObject(object) {
        const serializedObject = {};

        for (const [key, value] of Object.entries(object)) {
            if (typeof value !== "function" && value !== undefined) {
                serializedObject[key] = Serializable.#serializeValue(value);
            }
        }

        return serializedObject;
    }

    /**
     * Serializes a map as an object with stringified keys.
     *
     * @param {Map} map - Map to serialize.
     * @returns {Object} Serialized map.
     */
    static #serializeMap(map) {
        const serializedMap = {};

        for (const [key, value] of map.entries()) {
            serializedMap[String(key)] = Serializable.#serializeValue(value);
        }

        return serializedMap;
    }

    /**
     * Serializes a set as an array in insertion order.
     *
     * @param {Set} set - Set to serialize.
     * @returns {Array} Serialized set.
     */
    static #serializeSet(set) {
        const serializedSet = [];

        for (const value of set.values()) {
            serializedSet.push(Serializable.#serializeValue(value));
        }

        return serializedSet;
    }

    /**
     * Distinguishes plain records from models, arrays, dates, maps, and sets.
     *
     * @param {*} value - Value to check.
     * @returns {boolean} True when value is a plain object.
     */
    static #isPlainObject(value) {
        return value !== null && typeof value === "object" && value.constructor === Object;
    }
}
