"use strict";

import { ValidationUtils } from "../core/ValidationUtils.js";

/** Validated command request received by Host. */
export class HostRequest {
    /**
     * @param {string} command - Canonical command name.
     * @param {Object} data - Command payload.
     */
    constructor(command, data) {
        this.command = command;
        this.data = data;
        Object.freeze(this);
    }

    /**
     * @param {*} raw - Untrusted endpoint request.
     * @returns {HostRequest} Validated request.
     */
    static parse(raw) {
        const request = ValidationUtils.object(raw, "Request");
        const command = ValidationUtils.requiredString(request.command, "Command");
        const data = request.data === undefined ? {} : ValidationUtils.object(request.data, "Command data");

        return new HostRequest(command, data);
    }
}

