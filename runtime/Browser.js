"use strict";

/**
 * Browser endpoint that connects a Client directly to an in-tab Host.
 * No network transport is involved; custom room definitions use localStorage.
 */

import { Player } from "../core/Player.js";
import { EndpointEvents } from "./Client.js";
import { Host, HostChannel, HostConfig } from "./Host.js";

/** Browser-only storage for serializable custom-room definitions. */
class BrowserStore {
    static #KEY = "pick2.localGames";
    #memory = new Map();

    /** @returns {Promise<Object[]>} Stored custom-room definitions. */
    async load() {
        return Array.from(this.#read().values());
    }

    /** @param {Object} definition - Serializable room definition to persist. */
    async save(definition) {
        const definitions = this.#read();
        definitions.set(Player.normalizeKey(definition.roomName), definition);
        this.#write(definitions);
    }

    /** @param {string} roomKey - Normalized room key to remove. */
    async remove(roomKey) {
        const definitions = this.#read();
        definitions.delete(roomKey);
        this.#write(definitions);
    }

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
            const serialized = storage.getItem(BrowserStore.#KEY) ?? "[]";
            const stored = JSON.parse(serialized);
            const definitions = new Map();

            for (const definition of Array.isArray(stored) ? stored : []) {
                if (typeof definition?.roomName === "string") {
                    definitions.set(Player.normalizeKey(definition.roomName), definition);
                }
            }

            this.#memory = definitions;
        } catch (_error) {}

        return new Map(this.#memory);
    }

    #write(definitions) {
        this.#memory = new Map(definitions);

        try {
            if (definitions.size === 0) {
                globalThis.localStorage?.removeItem(BrowserStore.#KEY);
            } else {
                globalThis.localStorage?.setItem(
                    BrowserStore.#KEY,
                    JSON.stringify(Array.from(definitions.values()))
                );
            }
        } catch (_error) {}
    }
}

/** Direct browser endpoint for the shared transport-neutral Host. */
export class Browser {
    #host = new Host(new HostConfig(
        "local",
        "fill",
        false,
        false,
        true,
        new BrowserStore()
    ));

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
    #events;
    #peer;
    #isOpen = true;

    /**
     * @param {Host} host - Shared transport-neutral Host.
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     */
    constructor(host, events) {
        this.#events = events;
        events.status?.("connecting", "Starting local room…");
        this.#peer = host.open(new HostChannel(
            this.#publish.bind(this),
            this.close.bind(this)
        ));
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

    #publish(response) {
        if (this.#isOpen) {
            queueMicrotask(this.#receive.bind(this, structuredClone(response)));
        }
    }

    #receive(response) {
        this.#events.receive?.(response);
    }

    #request(request) {
        void this.#peer.request(request);
    }

    #notifyOpen() {
        if (this.#isOpen) {
            this.#events.status?.("connected", "Local");
            this.#events.open?.();
        }
    }
}
