"use strict";

/**
 * Browser endpoint that connects a Client directly to an in-tab Host.
 * No network transport is involved; custom room definitions use localStorage.
 */

import { Actor } from "../core/Actor.js";
import { EndpointEvents } from "./Client.js";
import { Host, HostChannel, HostConfig } from "./Host.js";

/** Browser-only storage for serializable custom-room definitions. */
class BrowserStore {
    /** @type {string} localStorage key scoped to the active game. */
    #key;

    /** @type {Map<string,Object>} In-memory fallback and last valid storage snapshot. */
    #memory = new Map();

    /** Creates game-scoped direct-room storage. @param {string} gameId - Stable game identifier. */
    constructor(gameId) {
        this.#key = `${gameId}.directGames`;
    }

    /** @returns {Promise<Object[]>} Validated custom-room definitions from persistent or fallback storage. */
    async load() {
        return Array.from(this.#read().values());
    }

    /** @param {Object} definition - Serializable room definition to persist. */
    async save(definition) {
        const definitions = this.#read();
        definitions.set(Actor.normalizeKey(definition.roomName), definition);
        this.#write(definitions);
    }

    /** @param {string} roomKey - Normalized room key to remove. */
    async remove(roomKey) {
        const definitions = this.#read();
        definitions.delete(roomKey);
        this.#write(definitions);
    }

    /** Reads and validates persisted definitions, falling back to the last in-memory snapshot. */
    #read() {
        let storage;

        try {
            storage = globalThis.localStorage;
        } catch (_error) {
            return new Map(this.#memory);
        }

        if (storage === undefined) {
            return new Map(this.#memory);
        }

        try {
            const serialized = storage.getItem(this.#key) ?? "[]";
            const stored = JSON.parse(serialized);
            const definitions = new Map();

            for (const definition of Array.isArray(stored) ? stored : []) {
                if (typeof definition?.roomName === "string") {
                    definitions.set(Actor.normalizeKey(definition.roomName), definition);
                }
            }

            this.#memory = definitions;
        } catch (_error) {}

        return new Map(this.#memory);
    }

    /** Replaces the memory snapshot and mirrors it to localStorage when available. */
    #write(definitions) {
        this.#memory = new Map(definitions);

        try {
            if (definitions.size === 0) {
                globalThis.localStorage?.removeItem(this.#key);
            } else {
                globalThis.localStorage?.setItem(this.#key, JSON.stringify(Array.from(definitions.values())));
            }
        } catch (_error) {}
    }
}

/** Direct browser endpoint for the shared transport-neutral Host. */
export class Browser {
    /** @type {Host} In-tab authoritative host shared by direct connections. */
    #host;

    /** Creates a direct endpoint for a game contract. @param {Object} game - Pick 2 host contract. */
    constructor(game) {
        this.#host = new Host(new HostConfig("direct", "fill", false, false, true, new BrowserStore(game.id)), game);
    }

    /**
     * Opens one direct in-browser Host connection.
     *
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     * @returns {BrowserConnection} Direct connection handle.
     */
    open(events) {
        if (!(events instanceof EndpointEvents)) {
            throw new Error("Browser.open requires EndpointEvents.");
        }

        return new BrowserConnection(this.#host, events);
    }
}

/** One direct browser connection to Host. */
class BrowserConnection {
    /** @type {EndpointEvents} Lifecycle callbacks supplied by Client. */
    #events;

    /** @type {{request:Function,close:Function}} Host-side peer handle. */
    #peer;

    /** @type {boolean} Whether queued requests and responses may still be delivered. */
    #isOpen = true;

    /**
     * @param {Host} host - Shared transport-neutral Host.
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     */
    constructor(host, events) {
        this.#events = events;
        events.status?.("connecting", "Starting direct room…");
        this.#peer = host.open(new HostChannel(this.#publish.bind(this), this.close.bind(this)));
        queueMicrotask(this.#notifyOpen.bind(this));
    }

    /** @param {Object} request - Canonical action request. @returns {boolean} Whether queued. */
    request(request) {
        if (!this.#isOpen) {
            return false;
        }

        queueMicrotask(this.#request.bind(this, structuredClone(request)));
        return true;
    }

    /** Closes the direct connection and notifies the endpoint. */
    close() {
        if (!this.#isOpen) {
            return;
        }

        this.#isOpen = false;
        void this.#peer.close();
        this.#events.status?.("disconnected", "Closed");
        this.#events.close?.();
    }

    /** Clones and queues a Host response for asynchronous browser delivery. */
    #publish(response) {
        if (this.#isOpen) {
            queueMicrotask(this.#receive.bind(this, structuredClone(response)));
        }
    }

    /** Delivers a queued Host response through the endpoint callback contract. */
    #receive(response) {
        this.#events.receive?.(response);
    }

    /** Dispatches a cloned request to the in-tab Host peer. */
    #request(request) {
        void this.#peer.request(request);
    }

    /** Announces the established direct connection unless it closed while queued. */
    #notifyOpen() {
        if (this.#isOpen) {
            this.#events.status?.("connected", "Direct");
            this.#events.open?.();
        }
    }
}
