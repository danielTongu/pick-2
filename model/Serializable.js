"use strict";

/** Converts domain fields and supported containers into JSON-safe snapshots. */
export class Serializable {
    /**
     * Serializes model fields while hiding private, undefined, and function values.
     * @param {string[]|null} include - Optional field allowlist.
     * @param {string[]} exclude - Optional field denylist.
     * @returns {Object} Model snapshot.
     */
    toJSON(include = null, exclude = []) {
        return Serializable.#fields(this, include, exclude, true);
    }

    /**
     * Shares field traversal between models and plain records without changing their privacy policy.
     * @param {Object} source - Model or plain record.
     * @param {string[]|null} include - Optional model field allowlist.
     * @param {string[]} exclude - Excluded model fields.
     * @param {boolean} hidePrivate - Whether underscore fields belong to model internals.
     * @returns {Object} Recursively serialized own fields, including safe literal prototype keys.
     */
    static #fields(source, include, exclude, hidePrivate) {
        const entries = [];
        for (const [key, value] of Object.entries(source)) {
            if ((!hidePrivate || !key.startsWith("_")) && !exclude.includes(key) &&
                (include === null || include.includes(key)) && value !== undefined && typeof value !== "function") {
                entries.push([key, Serializable.#value(value)]);
            }
        }
        return Object.fromEntries(entries);
    }

    /**
     * Preserves model overrides, dates, container ordering, and ordinary record semantics.
     * @param {*} value - Field or container element.
     * @returns {*} JSON-safe value for supported domain types.
     */
    static #value(value) {
        let snapshot = value;
        if (value instanceof Serializable) {
            snapshot = value.toJSON();
        } else if (value instanceof Date) {
            snapshot = value.toISOString();
        } else if (Array.isArray(value) || value instanceof Set) {
            snapshot = Array.from(value, Serializable.#value);
        } else if (value instanceof Map) {
            snapshot = Object.fromEntries(Array.from(value, Serializable.#entry));
        } else if (value !== null && typeof value === "object" && value.constructor === Object) {
            snapshot = Serializable.#fields(value, null, [], false);
        }
        return snapshot;
    }

    /**
     * Preserves stringified map keys without assigning prototype setters.
     * @param {[*, *]} entry - Map key/value pair.
     * @returns {[string, *]} Serialized map entry.
     */
    static #entry([key, value]) {
        return [String(key), Serializable.#value(value)];
    }
}
