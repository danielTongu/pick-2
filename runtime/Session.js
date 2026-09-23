"use strict";

/** Concrete peer handle returned by Host.accept(). */
export class HostPeer {
    /**
     * @type {function(*): Promise<void>} Dispatches an untrusted request to the owning Host.
     */
    #request;

    /**
     * @type {function(): Promise<void>} Disconnects this peer from the owning Host.
     */
    #close;

    /**
     * @param {function(*): Promise<void>} request - Request dispatcher.
     * @param {function(): Promise<void>} close - Close callback.
     */
    constructor(request, close) {
        this.#request = request;
        this.#close = close;
        Object.freeze(this);
    }

    /**
     * @param {*} message - Untrusted command request.
     * @returns {Promise<void>}
     */
    receive(message) {
        return this.#request(message);
    }

    /**
     * @returns {Promise<void>}
     */
    close() {
        return this.#close();
    }
}

/** One transport peer connected to a Host. */
export class PeerSession {
    /**
     * @param {string} id - Host-local peer identifier.
     * @param {import("./Transport.js").PeerChannel} channel - Transport publication boundary.
     */
    constructor(id, channel) {
        this.id = id;
        this.channel = channel;
        this.tabId = null;
        this.isOpen = true;
    }

    /**
     * @param {Object} response - Canonical Host response.
     */
    publish(response) {
        if (this.isOpen) {
            this.channel.send(response);
        }
    }

    /**
     * @param {number} code - Transport close code.
     * @param {string} reason - Close reason.
     */
    terminate(code, reason) {
        this.channel.disconnect(code, reason);
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     */
    authenticate(tabId) {
        this.tabId = tabId;
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     */
    clearAuthentication(tabId) {
        if (this.tabId === tabId) {
            this.tabId = null;
        }
    }

    /** Marks the peer closed without asking the transport to close again. */
    markClosed() {
        this.isOpen = false;
    }
}

/** One tab's authenticated membership in a room. */
export class RoomSession {
    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {PeerSession} peer - Connected peer.
     * @param {string} roomKey - Normalized room key.
     * @param {string|null} playerName - Seated player or null.
     * @returns {RoomSession}
     * @param {PeerSession} peer - Authenticated transport peer.
     * @param {string} roomKey - Normalized room identity.
     * @param {string|null} playerName - Seated player name, or null for a viewer.
     */
    constructor(tabId, peer, roomKey, playerName) {
        this.tabId = tabId;
        this.peer = peer;
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

/** Owns connected peers and their authenticated room-session indexes. */
export class SessionRegistry {
    /**
     * @type {Map<string, RoomSession>} Room sessions keyed by browser-tab identity.
     */
    #roomSessions = new Map();

    /**
     * @type {Map<string, Set<string>>} Browser-tab identities grouped by room.
     */
    #tabIdsByRoom = new Map();

    /**
     * @type {Set<PeerSession>} Peers subscribed to Home state.
     */
    #homePeers = new Set();

    /**
     * @type {number} Monotonic Host-local peer sequence.
     */
    #peerSequence = 0;

    /**
     * @param {import("./Transport.js").PeerChannel} channel - Transport boundary.
     * @returns {PeerSession} New peer.
     */
    createPeer(channel) {
        return new PeerSession(`peer-${++this.#peerSequence}`, channel);
    }

    /**
     * @param {PeerSession} peer - Connected peer.
     */
    subscribeHome(peer) {
        if (peer.isOpen) {
            this.#homePeers.add(peer);
        }
    }

    /**
     * @param {PeerSession} peer - Connected peer.
     */
    unsubscribeHome(peer) {
        this.#homePeers.delete(peer);
    }

    /**
     * @returns {PeerSession[]} Stable snapshot of Home subscribers.
     */
    homePeers() {
        return Array.from(this.#homePeers);
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @returns {boolean} Whether registered.
     */
    has(tabId) {
        return this.#roomSessions.has(tabId);
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @returns {RoomSession|null} Current room session.
     */
    get(tabId) {
        return this.#roomSessions.get(tabId) ?? null;
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {PeerSession} peer - Connected peer.
     * @param {string} roomKey - Normalized room key.
     * @param {string|null} playerName - Seated player or null.
     * @returns {RoomSession}
     */
    register(tabId, peer, roomKey, playerName) {
        const session = new RoomSession(tabId, peer, roomKey, playerName);
        this.#roomSessions.set(tabId, session);
        peer.authenticate(tabId);

        let tabIds = this.#tabIdsByRoom.get(roomKey);
        if (tabIds === undefined) {
            tabIds = new Set();
            this.#tabIdsByRoom.set(roomKey, tabIds);
        }
        tabIds.add(tabId);
        this.unsubscribeHome(peer);

        return session;
    }

    /**
     * @param {string} tabId - Browser-tab identity.
     * @param {PeerSession} peer - Connected peer.
     * @returns {RoomSession|null}
     */
    unregister(tabId, peer) {
        const session = this.get(tabId);
        if (session === null || session.peer !== peer) {
            return null;
        }

        const tabIds = this.#tabIdsByRoom.get(session.roomKey);
        tabIds?.delete(tabId);
        if (tabIds?.size === 0) {
            this.#tabIdsByRoom.delete(session.roomKey);
        }

        this.#roomSessions.delete(tabId);
        peer.clearAuthentication(tabId);
        return session;
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @returns {RoomSession[]} Stable session snapshot.
     */
    inRoom(roomKey) {
        const sessions = [];
        for (const tabId of this.#tabIdsByRoom.get(roomKey) ?? []) {
            const session = this.get(tabId);
            if (session !== null) sessions.push(session);
        }
        return sessions;
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @param {string} playerName - Player name.
     * @returns {RoomSession|null}
     */
    findPlayer(roomKey, playerName) {
        return this.inRoom(roomKey).find(function matches(session) {
            return session.playerName === playerName;
        }) ?? null;
    }

    /**
     * @param {PeerSession} peer - Connected peer.
     * @returns {RoomSession|null}
     */
    findPeer(peer) {
        for (const session of this.#roomSessions.values()) {
            if (session.peer === peer) return session;
        }
        return null;
    }

    /**
     * @param {RoomSession} session - Captured session.
     * @returns {boolean} Whether it remains registered.
     */
    isCurrent(session) {
        return this.get(session.tabId) === session;
    }

    /**
     * @returns {RoomSession[]} Stable snapshot of every room session.
     */
    allRoomSessions() {
        return Array.from(this.#roomSessions.values());
    }

    /** Clears every index after Host has completed transport cleanup. */
    clear() {
        this.#roomSessions.clear();
        this.#tabIdsByRoom.clear();
        this.#homePeers.clear();
    }
}
