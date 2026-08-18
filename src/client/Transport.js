"use strict";

/**
 * Common transport contract used by the browser game client.
 */
export class Transport {
    /** @type {Function|null} */
    onOpen = null;

    /** @type {Function|null} */
    onMessage = null;

    /** @type {Function|null} */
    onClose = null;

    /** @type {Function|null} */
    onStatus = null;

    /** Opens the transport. */
    connect() {
        throw new Error("Transport.connect() must be implemented.");
    }

    /**
     * Sends one action request.
     *
     * @param {{type:string,payload:Object}} _request - Action request.
     * @returns {boolean} Whether the request was accepted.
     */
    send(_request) {
        throw new Error("Transport.send() must be implemented.");
    }

    /** Closes the transport. */
    close() {}
}
