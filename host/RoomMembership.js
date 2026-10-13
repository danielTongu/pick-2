"use strict";

/** One tab's authenticated membership in a room. */
export class RoomMembership {
    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {import("./HostConnection.js").HostConnection} connection - Connected Host connection.
     * @param {string} roomKey - Normalized room key.
     * @param {string|null} playerName - Seated player or null.
     * @returns {RoomMembership}
     */
    constructor(tabId, connection, roomKey, playerName) {
        this.tabId = tabId;
        this.connection = connection;
        this.roomKey = roomKey;
        this.playerName = playerName;
    }

    /**
     * @param {string} playerName - Seated player name.
     */
    join(playerName) {
        this.playerName = playerName;
    }

    /** Demotes a seated player to a viewer. */
    view() {
        this.playerName = null;
    }
}
