"use strict";

import { Transport } from "./Transport.js";

/**
 * Connects GameClient to the in-browser LocalServer.
 */
export class LocalTransport extends Transport {
    /** @type {import("../local/LocalServer.js").LocalServer} */
    #server;

    /** @type {boolean} */
    #isOpen = false;

    /**
     * @param {import("../local/LocalServer.js").LocalServer} server - Local server.
     */
    constructor(server) {
        super();
        this.#server = server;
    }

    /** Opens the local connection asynchronously. */
    connect() {
        if (this.#isOpen) {
            return;
        }

        this.#isOpen = true;
        this.#server.onResponse = (response) => {
            if (this.#isOpen) {
                queueMicrotask(() => this.onMessage?.(structuredClone(response)));
            }
        };

        queueMicrotask(() => {
            if (this.#isOpen) {
                this.onStatus?.("connected", "Local");
                this.onOpen?.();
            }
        });
    }

    /**
     * Sends one request to the local server.
     *
     * @param {{type:string,payload:Object}} request - Action request.
     * @returns {boolean} Whether the request was accepted.
     */
    send(request) {
        if (!this.#isOpen) {
            return false;
        }

        queueMicrotask(() => {
            void this.#server.handle(structuredClone(request));
        });

        return true;
    }

    /** Closes the local connection. */
    close() {
        if (!this.#isOpen) {
            return;
        }

        this.#isOpen = false;
        this.#server.disconnect();
        this.onStatus?.("disconnected", "Closed");
        this.onClose?.();
    }
}
