"use strict";

/** One Host-side connection used by both the Host and its transport. */
export class HostConnection {
    /**
     * @type {function(HostConnection, *): Promise<void>} Dispatches an untrusted request to the owning Host.
     */
    #request;

    /**
     * @type {function(HostConnection): Promise<void>} Disconnects this connection from the owning Host.
     */
    #close;

    /** @type {function(Object): void} Sends a response through the transport. */
    #send;

    /** @type {function(number=, string=): void} Disconnects the transport. */
    #disconnect;

    /**
     * @param {string} id - Host-local connection identifier.
     * @param {function(Object): void} send - Transport response callback.
     * @param {function(number=, string=): void} disconnect - Transport disconnect callback.
     * @param {function(HostConnection, *): Promise<void>} request - Request dispatcher.
     * @param {function(HostConnection): Promise<void>} close - Close callback.
     */
    constructor(id, send, disconnect, request, close) {
        if (typeof send !== "function" || typeof disconnect !== "function" ||
            typeof request !== "function" || typeof close !== "function") {
            throw new Error("HostConnection requires send, disconnect, request, and close handlers.");
        }
        this.id = id;
        this.tabId = null;
        this.isOpen = true;
        this.#send = send;
        this.#disconnect = disconnect;
        this.#request = request;
        this.#close = close;
    }

    /**
     * @param {*} message - Untrusted command request.
     * @returns {Promise<void>}
     */
    receive(message) {
        return this.#request(this, message);
    }

    /**
     * @returns {Promise<void>}
     */
    close() {
        return this.#close(this);
    }

    /**
     * @param {Object} response - Canonical Host response.
     */
    publish(response) {
        if (this.isOpen) {
            this.#send(response);
        }
    }

    /**
     * @param {number} code - Transport close code.
     * @param {string} reason - Close reason.
     */
    terminate(code, reason) {
        this.#disconnect(code, reason);
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

    /** Marks the connection closed without asking the transport to close again. */
    markClosed() {
        this.isOpen = false;
    }
}
