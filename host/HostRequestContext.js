"use strict";

import { ValidationUtils } from "../core/ValidationUtils.js";

/** Progressively resolved state for one Host request. */
export class HostRequestContext {
    /**
     * @param {import("./HostConnection.js").HostConnection} connection - Requesting connection.
     * @param {import("./HostRequest.js").HostRequest} request - Validated request.
     */
    constructor(connection, request) {
        this.connection = connection;
        this.request = request;
        this.tabId = null;
        this.membership = null;
        this.roomKey = null;
        this.room = null;
    }

    /**
     * @returns {HostRequestContext} This resolved context.
     */
    identifyTab() {
        this.tabId = ValidationUtils.requiredString(this.request.data.tabId, "tabId");
        return this;
    }

    /**
     * @param {import("./RoomMembership.js").RoomMembership|null} membership - Current room membership.
     * @returns {HostRequestContext} This context.
     */
    attachMembership(membership) {
        this.membership = membership;
        return this;
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @param {import("../core/Room.js").Room} room - Room model.
     * @returns {HostRequestContext} This context.
     */
    attachRoom(roomKey, room) {
        this.roomKey = roomKey;
        this.room = room;
        return this;
    }
}
