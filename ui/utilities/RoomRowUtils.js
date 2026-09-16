"use strict";

import { ValidationUtils } from "../../core/ValidationUtils.js";
import { DomUtils } from "./DomUtils.js";
import { TemplateUtils } from "./TemplateUtils.js";

/** Creates a shared room metadata row. */
export class RoomRowUtils extends TemplateUtils {
    /** @type {HTMLTemplateElement|null} Lazily loaded and validated component template. */
    static template = null;

    /** @type {string} Template path resolved relative to the owning module. */
    static templateFile = "room-row.html";

    /** @type {string} Required template element identifier. */
    static templateId = "room-row-template";

    /** @type {string} Module URL used as the template-resolution base. */
    static componentUrl = import.meta.url;

    /** @type {boolean} Whether cloned roots must satisfy the declared contract. */
    static isTemplateRootValidationEnabled = false;

    /**
     * @param {HTMLTableRowElement} element - Room row.
     * @param {Object} room - Room snapshot.
     */
    static updateElement(element, room) {
        ValidationUtils.instanceOf(element, HTMLTableRowElement, `${this.name} element`);
        const data = RoomRowUtils.#normalizeRoom(room);

        RoomRowUtils.#setCell(element, "[data-name]", "name", data.name);
        RoomRowUtils.#setCell(element, "[data-state]", "state", data.state);
        RoomRowUtils.#setCell(
            element,
            "[data-turn-order-actor-count]",
            "turnOrderActorCount",
            data.turnOrder.actorCount
        );
        RoomRowUtils.#setCell(element, "[data-viewers]", "viewers", data.viewers);
        RoomRowUtils.#setCell(element, "[data-actor-limit]", "actorLimit", data.actorLimit);
        RoomRowUtils.#setCell(element, "[data-last-active-at]", "lastActiveAt", data.lastActiveAt);
        RoomRowUtils.#setCell(element, "[data-created-at]", "createdAt", data.createdAt);
    }

    /** Sets a table-cell dataset value. */
    static #setCell(row, selector, name, value) {
        DomUtils.requireChild(row, selector, HTMLTableCellElement).dataset[name] = value;
    }

    /** Normalizes room row data. */
    static #normalizeRoom(room) {
        const source = ValidationUtils.object(room, "Room");

        return {
            name: RoomRowUtils.#displayText(source.name),
            state: RoomRowUtils.#displayText(source.state),
            turnOrder: {
                actorCount: RoomRowUtils.#displayCount(source.turnOrder?.actorCount, "Room.turnOrder.actorCount")
            },
            viewers: RoomRowUtils.#displayCount(source.viewers, "Room.viewers"),
            actorLimit: RoomRowUtils.#displayCount(source.actorLimit, "Room.actorLimit"),
            lastActiveAt: RoomRowUtils.#displayText(source.lastActiveAt),
            createdAt: RoomRowUtils.#displayText(source.createdAt)
        };
    }

    /** Returns readable text for an optional room value. */
    static #displayText(value) {
        const text = ValidationUtils.optionalString(value === null || value === undefined ? "" : String(value), "");
        return text || "--";
    }

    /** Returns a count or a placeholder when the value is absent. */
    static #displayCount(value, label) {
        return value === null || value === undefined ? "--" : String(ValidationUtils.nonNegativeNumber(value, label));
    }
}
