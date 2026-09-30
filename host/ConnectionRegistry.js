"use strict";

import { HostConnection } from "./HostConnection.js";
import { RoomMembership } from "./RoomMembership.js";

/** Owns Host connections and their authenticated room-membership indexes. */
export class ConnectionRegistry {
    /**
     * @type {Map<string, RoomMembership>} Room memberships keyed by browser-tab identity.
     */
    #memberships = new Map();

    /**
     * @type {Map<string, Set<string>>} Browser-tab identities grouped by room.
     */
    #tabIdsByRoom = new Map();

    /**
     * @type {Set<HostConnection>} Connections subscribed to Home state.
     */
    #homeConnections = new Set();

    /**
     * @type {number} Monotonic Host-local connection sequence.
     */
    #connectionSequence = 0;

    /**
     * @param {function(Object): void} send - Transport response callback.
     * @param {function(number=, string=): void} disconnect - Transport disconnect callback.
     * @param {function(HostConnection, *): Promise<void>} request - Request dispatcher.
     * @param {function(HostConnection): Promise<void>} close - Close callback.
     * @returns {HostConnection} New connection.
     */
    createConnection(send, disconnect, request, close) {
        return new HostConnection(`connection-${++this.#connectionSequence}`, send, disconnect, request, close);
    }

    /**
     * @param {HostConnection} connection - Host connection.
     */
    subscribeHome(connection) {
        if (connection.isOpen) {
            this.#homeConnections.add(connection);
        }
    }

    /**
     * @param {HostConnection} connection - Host connection.
     */
    unsubscribeHome(connection) {
        this.#homeConnections.delete(connection);
    }

    /**
     * @returns {HostConnection[]} Stable snapshot of Home subscribers.
     */
    homeConnections() {
        return Array.from(this.#homeConnections);
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @returns {boolean} Whether registered.
     */
    has(tabId) {
        return this.#memberships.has(tabId);
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @returns {RoomMembership|null} Current room membership.
     */
    get(tabId) {
        return this.#memberships.get(tabId) ?? null;
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {HostConnection} connection - Host connection.
     * @param {string} roomKey - Normalized room key.
     * @param {string|null} actorName - Seated actor or null.
     * @returns {RoomMembership}
     */
    register(tabId, connection, roomKey, actorName) {
        const membership = new RoomMembership(tabId, connection, roomKey, actorName);
        this.#memberships.set(tabId, membership);
        connection.authenticate(tabId);

        let tabIds = this.#tabIdsByRoom.get(roomKey);
        if (tabIds === undefined) {
            tabIds = new Set();
            this.#tabIdsByRoom.set(roomKey, tabIds);
        }
        tabIds.add(tabId);
        this.unsubscribeHome(connection);

        return membership;
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {HostConnection} connection - Host connection.
     * @returns {RoomMembership|null}
     */
    unregister(tabId, connection) {
        const membership = this.get(tabId);
        if (membership === null || membership.connection !== connection) {
            return null;
        }

        const tabIds = this.#tabIdsByRoom.get(membership.roomKey);
        tabIds?.delete(tabId);
        if (tabIds?.size === 0) {
            this.#tabIdsByRoom.delete(membership.roomKey);
        }

        this.#memberships.delete(tabId);
        connection.clearAuthentication(tabId);
        return membership;
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @returns {RoomMembership[]} Stable membership snapshot.
     */
    inRoom(roomKey) {
        const memberships = [];
        for (const tabId of this.#tabIdsByRoom.get(roomKey) ?? []) {
            const membership = this.get(tabId);
            if (membership !== null) memberships.push(membership);
        }
        return memberships;
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @param {string} actorName - Actor name.
     * @returns {RoomMembership|null}
     */
    findActor(roomKey, actorName) {
        return this.inRoom(roomKey).find(function matches(membership) {
            return membership.actorName === actorName;
        }) ?? null;
    }

    /**
     * @param {HostConnection} connection - Host connection.
     * @returns {RoomMembership|null}
     */
    findConnection(connection) {
        for (const membership of this.#memberships.values()) {
            if (membership.connection === connection) return membership;
        }
        return null;
    }

    /**
     * @param {RoomMembership} membership - Captured membership.
     * @returns {boolean} Whether it remains registered.
     */
    isCurrent(membership) {
        return this.get(membership.tabId) === membership;
    }

    /**
     * @returns {RoomMembership[]} Stable snapshot of every room membership.
     */
    allRoomMemberships() {
        return Array.from(this.#memberships.values());
    }

    /** Clears every index after Host has completed transport cleanup. */
    clear() {
        this.#memberships.clear();
        this.#tabIdsByRoom.clear();
        this.#homeConnections.clear();
    }
}
