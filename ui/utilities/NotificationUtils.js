"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";

/**
 * Normalizes user-notification data for display.
 */
export class NotificationUtils {
    /**
     * Produces the canonical notification shape.
     *
     * Non-object data is displayed as informational message text.
     *
     * @param {*} data - Raw notification data.
     * @returns {{status:string,title:string,message:string}} Normalized notification.
     */
    static normalize(data) {
        const isObjectData = typeof data === "object" && data !== null && !Array.isArray(data);
        const source = isObjectData ? data : {};
        const status = NotificationUtils.normalizeStatus(source.status);

        return {
            status,
            title: ValidationUtils.optionalString(source.title, NotificationUtils.getDefaultTitle(status)),
            message: isObjectData ? ValidationUtils.optionalString(source.message, "") : String(data ?? "")
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
