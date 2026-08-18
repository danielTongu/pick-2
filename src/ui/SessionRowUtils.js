"use strict";

import { AssertUtils } from "../core/AssertUtils.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { DomUtils } from "./DomUtils.js";
import { TemplateUtils } from "./TemplateUtils.js";

/** Creates the shared game and session metadata row. */
export class SessionRowUtils extends TemplateUtils {
    static template = null;
    static templateFile = "session-row.html";
    static templateId = "session-row-template";
    static componentUrl = import.meta.url;
    static isTemplateRootValidationEnabled = false;

    /**
     * @param {HTMLTableRowElement} element - Session row.
     * @param {Object} session - Session snapshot.
     */
    static updateElement(element, session = {}) {
        AssertUtils.instanceOf(element, HTMLTableRowElement, `${this.name} element`);
        const data = SessionRowUtils.#normalizeSession(session);

        SessionRowUtils.#setCell(element, "[data-name]", "name", data.name);
        SessionRowUtils.#setCell(element, "[data-status]", "status", data.status);
        SessionRowUtils.#setCell(element, "[data-player-count]", "playerCount", data.playerCount);
        SessionRowUtils.#setCell(element, "[data-viewer-count]", "viewerCount", data.viewerCount);
        SessionRowUtils.#setCell(element, "[data-capacity]", "capacity", data.capacity);
        SessionRowUtils.#setCell(element, "[data-last-active-at]", "lastActiveAt", data.lastActiveAt);
        SessionRowUtils.#setCell(element, "[data-created-at]", "createdAt", data.createdAt);
    }

    /** Sets a table-cell dataset value. */
    static #setCell(row, selector, name, value) {
        DomUtils.requireChild(row, selector, HTMLTableCellElement).dataset[name] = value;
    }

    /** Normalizes session row data. */
    static #normalizeSession(session) {
        const source = NormalizeUtils.object(session, "Session");

        return {
            name: SessionRowUtils.#displayText(source.name),
            status: SessionRowUtils.#displayText(source.status),
            playerCount: SessionRowUtils.#displayCount(source.playerCount, "Session.playerCount"),
            viewerCount: SessionRowUtils.#displayCount(source.viewerCount, "Session.viewerCount"),
            capacity: SessionRowUtils.#displayCount(source.capacity, "Session.capacity"),
            lastActiveAt: SessionRowUtils.#displayText(source.lastActiveAt),
            createdAt: SessionRowUtils.#displayText(source.createdAt)
        };
    }

    /** Returns readable text for an optional session value. */
    static #displayText(value) {
        const text = NormalizeUtils.optionalString(
            value === null || value === undefined ? "" : String(value),
            ""
        );
        return text || "--";
    }

    /** Returns a count or a placeholder when the value is absent. */
    static #displayCount(value, label) {
        return value === null || value === undefined
            ? "--"
            : String(NormalizeUtils.nonNegativeNumber(value, label));
    }
}
