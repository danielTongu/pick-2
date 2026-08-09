"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";

/**
 * Normalizes user-notification payloads for display.
 */
export class NotificationUtils {
    /**
     * Produces the canonical notification shape.
     *
     * Non-object payloads are displayed as informational message text.
     *
     * @param {*} payload - Raw notification payload.
     * @returns {{status:string,title:string,message:string}} Normalized notification.
     */
    static normalize(payload) {
        const isObjectPayload = typeof payload === "object" && payload !== null && !Array.isArray(payload);
        const source = isObjectPayload ? payload : {};
        const status = NotificationUtils.normalizeStatus(source.status);

        return {
            status,
            title: NormalizeUtils.optionalString(source.title, NotificationUtils.getDefaultTitle(status)),
            message: isObjectPayload ? NormalizeUtils.optionalString(source.message, "") : String(payload ?? "")
        };
    }

    /**
     * Restricts a notification status to supported display states.
     *
     * @param {*} status - Raw notification status.
     * @returns {string} Supported notification status.
     */
    static normalizeStatus(status) {
        let normalizedStatus = Constants.STATUS.INFO;

        if (status === Constants.STATUS.WARNING || status === Constants.STATUS.ERROR) {
            normalizedStatus = status;
        }

        return normalizedStatus;
    }

    /**
     * Gets the default title associated with a notification status.
     *
     * @param {*} status - Raw or normalized notification status.
     * @returns {string} Default notification title.
     */
    static getDefaultTitle(status) {
        let title = "Notice";

        if (status === Constants.STATUS.WARNING) {
            title = "Warning";
        } else if (status === Constants.STATUS.ERROR) {
            title = "Error";
        }

        return title;
    }
}
