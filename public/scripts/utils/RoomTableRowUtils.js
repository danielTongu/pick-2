// public/utils/RoomTableRowUtils.js

import { Constants } from "../Constants.js";
import { DomUtils } from "./DomUtils.js";
import { NormalizeUtils } from "./NormalizeUtils.js";
import { TemplateComponentUtils } from "./TemplateComponentUtils.js";

/**
 * Room row fragment.
 */
export class RoomTableRowUtils extends TemplateComponentUtils {
    /** @type {HTMLTemplateElement|null} */
    static template = null;

    /** @type {string} */
    static templateFile = "room-table-row.html";

    /** @type {string} */
    static templateId = "room-row-template";

    /** @type {string} */
    static componentUrl = import.meta.url;

    /** @type {boolean} */
    static isTemplateRootValidationEnabled = false;

    /**
     * Updates a room row element with room model data.
     *
     * @param {HTMLTableRowElement} element - Room row element.
     * @param {Object} room - Room model snapshot.
     * @throws {Error}
     */
    static updateElement(element, room = {}) {
        this.assertTableRow(element);

        const data = RoomTableRowUtils.#normalizeRoom(room);

        RoomTableRowUtils.#setCellData(element, "[data-name]", "name", data.name);
        RoomTableRowUtils.#setCellData(element, "[data-status]", "status", data.status);
        RoomTableRowUtils.#setCellData(element, "[data-player-count]", "playerCount", String(data.playerCount));
        RoomTableRowUtils.#setCellData(element, "[data-visitor-count]", "visitorCount", String(data.visitorCount));
        RoomTableRowUtils.#setCellData(element, "[data-capacity]", "capacity", String(data.capacity));
        RoomTableRowUtils.#setCellData(element, "[data-last-active-at]", "lastActiveAt", data.lastActiveAt);
        RoomTableRowUtils.#setCellData(element, "[data-created-at]", "createdAt", data.createdAt);
    }

    /**
     * Sets a dataset value on a required table cell.
     *
     * @param {HTMLTableRowElement} row - Table row.
     * @param {string} selector - Cell selector.
     * @param {string} datasetName - Dataset property name.
     * @param {string} value - Dataset value.
     * @throws {Error}
     */
    static #setCellData(row, selector, datasetName, value) {
        const cell = DomUtils.requireChild(row, selector, HTMLTableCellElement);

        cell.dataset[datasetName] = value;
    }

    /**
     * Normalizes room model data.
     *
     * @param {*} room - Room model snapshot.
     * @returns {{
     *     name:string,
     *     status:string,
     *     playerCount:number,
     *     visitorCount:number,
     *     capacity:number,
     *     lastActiveAt:string,
     *     createdAt:string
     * }}
     * @throws {Error}
     */
    static #normalizeRoom(room) {
        const source = NormalizeUtils.object(room, "Room");

        return {
            name: NormalizeUtils.optionalString(source.name, ""),
            status: NormalizeUtils.optionalString(source.status, Constants.STATUS.WAITING),
            playerCount: NormalizeUtils.nonNegativeNumber(source.playerCount ?? 0, "Room.playerCount"),
            visitorCount: NormalizeUtils.nonNegativeNumber(source.visitorCount ?? 0, "Room.visitorCount"),
            capacity: NormalizeUtils.nonNegativeNumber(source.capacity ?? 0, "Room.capacity"),
            lastActiveAt: NormalizeUtils.optionalString(String(source.lastActiveAt ?? ""), ""),
            createdAt: NormalizeUtils.optionalString(String(source.createdAt ?? ""), "")
        };
    }
}
