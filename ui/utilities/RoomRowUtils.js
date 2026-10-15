"use strict";

import { ValidationUtils } from "../../core/ValidationUtils.js";
import { DomUtils } from "./DomUtils.js";
import { TemplateUtils } from "./TemplateUtils.js";

/** Creates a shared room metadata row. */
export class RoomRowUtils extends TemplateUtils {

    /** Room-table Knockout column values. */
    static KNOCKOUT_VALUE = Object.freeze({ YES: "yes", NO: "no" });

    /**
     * @type {HTMLTemplateElement|null} Lazily loaded and validated component template.
     */
    static template = null;

    /**
     * @type {string} Template path resolved relative to the owning module.
     */
    static templateFile = "room-row.html";

    /**
     * @type {string} Required template element identifier.
     */
    static templateId = "room-row-template";

    /**
     * @type {string} Module URL used as the template-resolution base.
     */
    static componentUrl = import.meta.url;

    /**
     * @param {HTMLTableRowElement} element - Room row.
     * @param {Object} room - Room snapshot.
     */
    static updateElement(element, room) {
        ValidationUtils.instanceOf(element, HTMLTableRowElement, `${this.name} element`);
        const data = RoomRowUtils.#normalizeRoom(room);

        RoomRowUtils.#setCell(element, "[data-name]", "name", data.name);
        RoomRowUtils.#setCell(element, "[data-state]", "state", data.state);
        const knockoutCell = DomUtils.requireChild(element, "[data-knockout]", HTMLTableCellElement);
        knockoutCell.dataset.knockout = data.knockout;
        knockoutCell.textContent = data.knockout === RoomRowUtils.KNOCKOUT_VALUE.YES ? "Yes" : "No";
        RoomRowUtils.#setCell(
            element,
            "[data-turn-order-player-count]",
            "turnOrderPlayerCount",
            data.turnOrder.playerCount
        );
        RoomRowUtils.#setCell(element, "[data-viewers]", "viewers", data.viewers);
        RoomRowUtils.#setCell(element, "[data-player-limit]", "playerLimit", data.playerLimit);
        RoomRowUtils.#setCell(element, "[data-last-active-at]", "lastActiveAt", data.lastActiveAt);
        RoomRowUtils.#setCell(element, "[data-created-at]", "createdAt", data.createdAt);
    }

    /**
     * Sets a table-cell dataset value.
     * @param {HTMLTableRowElement} row - Room row.
     * @param {string} selector - Cell selector.
     * @param {string} name - Dataset key.
     * @param {string} value - Cell value.
     */
    static #setCell(row, selector, name, value) {
        DomUtils.requireChild(row, selector, HTMLTableCellElement).dataset[name] = value;
    }

    /**
     * Normalizes room row data.
     * @param {Object} room - Room snapshot.
     * @returns {Object} Display-ready row data.
     */
    static #normalizeRoom(room) {
        const source = ValidationUtils.object(room, "Room");

        return {
            name: RoomRowUtils.#displayText(source.name),
            state: RoomRowUtils.#displayText(source.match.state),
            knockout: source.match.isKnockout === true ? RoomRowUtils.KNOCKOUT_VALUE.YES : RoomRowUtils.KNOCKOUT_VALUE.NO,
            turnOrder: {
                playerCount: RoomRowUtils.#displayCount(source.match.turnOrder?.playerCount, "Room.turnOrder.playerCount")
            },
            viewers: RoomRowUtils.#displayCount(source.viewers, "Room.viewers"),
            playerLimit: RoomRowUtils.#displayCount(source.playerLimit, "Room.playerLimit"),
            lastActiveAt: RoomRowUtils.#displayText(source.lastActiveAt),
            createdAt: RoomRowUtils.#displayText(source.createdAt)
        };
    }

    /**
     * Returns readable text for an optional room value.
     * @param {*} value - Optional room value.
     * @returns {string} Display text.
     */
    static #displayText(value) {
        const text = ValidationUtils.optionalString(value === null || value === undefined ? "" : String(value), "");
        return text || "--";
    }

    /**
     * Returns a count or a placeholder when the value is absent.
     * @param {number|null|undefined} value - Optional count.
     * @param {string} label - Validation label.
     * @returns {string} Display count.
     */
    static #displayCount(value, label) {
        return value === null || value === undefined ? "--" : String(ValidationUtils.nonNegativeNumber(value, label));
    }
}
