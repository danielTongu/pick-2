"use strict";

/** One tab's authenticated membership in a room. */
export class RoomMembership {
    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {import("./HostConnection.js").HostConnection} connection - Connected Host connection.
     * @param {string} roomKey - Normalized room key.
     * @param {string|null} actorName - Seated actor or null.
     * @returns {RoomMembership}
     */
    constructor(tabId, connection, roomKey, actorName) {
        this.tabId = tabId;
        this.connection = connection;
        this.roomKey = roomKey;
        this.actorName = actorName;
    }

    /**
     * @param {string} actorName - Seated actor name.
     */
    join(actorName) {
        this.actorName = actorName;
    }

    /** Demotes a seated actor to a viewer. */
    view() {
        this.actorName = null;
    }
}
