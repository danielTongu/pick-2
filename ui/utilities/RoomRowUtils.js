"use strict";

import { ValidationUtils } from "../../core/ValidationUtils.js";
import { DomUtils } from "./DomUtils.js";
import { TemplateUtils } from "./TemplateUtils.js";

/** Creates a shared room metadata row. */
export class RoomRowUtils extends TemplateUtils {
    static template = null;
    static templateFile = "room-row.html";
    static templateId = "room-row-template";
    static componentUrl = import.meta.url;
    static isTemplateRootValidationEnabled = false;

    /**
     * @param {HTMLTableRowElement} element - Room row.
     * @param {Object} room - Room snapshot.
     */
    static updateElement(element, room) {
        ValidationUtils.instanceOf(element, HTMLTableRowElement, `${this.name} element`);
        const data = RoomRowUtils.#normalizeRoom(room);

        RoomRowUtils.#setCell(element, "[data-room-name]", "roomName", data.roomName);
        RoomRowUtils.#setCell(element, "[data-status]", "status", data.status);
        RoomRowUtils.#setCell(element, "[data-player-count]", "playerCount", data.playerCount);
        RoomRowUtils.#setCell(element, "[data-viewer-count]", "viewerCount", data.viewerCount);
        RoomRowUtils.#setCell(element, "[data-player-limit]", "playerLimit", data.playerLimit);
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
            roomName: RoomRowUtils.#displayText(source.roomName),
            status: RoomRowUtils.#displayText(source.status),
            playerCount: RoomRowUtils.#displayCount(source.playerCount, "Room.playerCount"),
            viewerCount: RoomRowUtils.#displayCount(source.viewerCount, "Room.viewerCount"),
            playerLimit: RoomRowUtils.#displayCount(source.playerLimit, "Room.playerLimit"),
            lastActiveAt: RoomRowUtils.#displayText(source.lastActiveAt),
            createdAt: RoomRowUtils.#displayText(source.createdAt)
        };
    }

    /** Returns readable text for an optional room value. */
    static #displayText(value) {
        const text = ValidationUtils.optionalString(
            value === null || value === undefined ? "" : String(value),
            ""
        );
        return text || "--";
    }

    /** Returns a count or a placeholder when the value is absent. */
    static #displayCount(value, label) {
        return value === null || value === undefined
            ? "--"
            : String(ValidationUtils.nonNegativeNumber(value, label));
    }
}
