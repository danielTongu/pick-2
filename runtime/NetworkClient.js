"use strict";

/** Browser endpoint that transports Client requests over WebSockets. */

import { ValidationUtils } from "../core/ValidationUtils.js";
import { EndpointEvents } from "./Client.js";

/** Browser-only WebSocket endpoint. */
export class NetworkClient {
    #url;

    /** @param {string} url - WebSocket endpoint URL. */
    constructor(url) {
        this.#url = ValidationUtils.requiredString(url, "WebSocket URL");
    }

    /**
     * Opens a reconnecting browser WebSocket connection.
     *
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     * @returns {NetworkConnection} Connection handle.
     */
    open(events) {
        if (!(events instanceof EndpointEvents)) {
            throw new Error("NetworkClient.open requires EndpointEvents.");
        }

        return new NetworkConnection(this.#url, events);
    }
}

/** One reconnecting browser WebSocket connection. */
class NetworkConnection {
    #url;
    #events;
    #socket = null;
    #reconnectTimer = null;
    #reconnectAttempts = 0;
    #isOpen = true;

    /**
     * @param {string} url - WebSocket endpoint URL.
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     */
    constructor(url, events) {
        this.#url = url;
        this.#events = events;
        this.#connect();
    }

    /** @param {Object} request - Canonical action request. @returns {boolean} Whether sent. */
    request(request) {
        const canSend = this.#socket instanceof WebSocket &&
            this.#socket.readyState === WebSocket.OPEN;

        if (canSend) {
            this.#socket.send(JSON.stringify(request));
        }

        return canSend;
    }

    /** Closes the socket and cancels pending reconnects. */
    close() {
        this.#isOpen = false;
        this.#cancelReconnect();
        this.#socket?.close();
        this.#socket = null;
    }

    #connect() {
        const isReconnecting = this.#reconnectAttempts > 0;
        this.#events.status?.(
            isReconnecting ? "reconnecting" : "connecting",
            isReconnecting ? "Reconnecting…" : "Connecting…"
        );
        const socket = new WebSocket(this.#url);

        this.#socket = socket;
        socket.addEventListener("open", this.#handleOpen.bind(this, socket));
        socket.addEventListener("message", this.#handleMessage.bind(this, socket));
        socket.addEventListener("close", this.#handleClose.bind(this, socket));
        socket.addEventListener("error", this.#handleError.bind(this, socket));
    }

    #handleOpen(socket) {
        if (this.#socket !== socket || !this.#isOpen) {
            return;
        }

        this.#cancelReconnect();
        this.#reconnectAttempts = 0;
        this.#events.status?.("connected", "Network");
        this.#events.open?.();
    }

    #handleMessage(socket, event) {
        if (this.#socket === socket && this.#isOpen) {
            this.#events.receive?.(event.data);
        }
    }

    #handleClose(socket) {
        if (this.#socket !== socket) {
            return;
        }

        this.#socket = null;
        this.#events.status?.("disconnected", "Disconnected");
        this.#events.close?.();
        this.#scheduleReconnect();
    }

    #handleError(socket) {
        if (this.#socket === socket) {
            this.#events.status?.("error", "Connection error");
            socket.close();
        }
    }

    #scheduleReconnect() {
        if (!this.#isOpen || this.#reconnectAttempts >= 5 || this.#reconnectTimer !== null) {
            return;
        }

        const delay = Math.min(1000 * (2 ** this.#reconnectAttempts), 30_000);
        this.#reconnectAttempts += 1;
        this.#events.status?.("reconnecting", "Reconnecting…");
        this.#reconnectTimer = globalThis.setTimeout(this.#reconnect.bind(this), delay);
    }

    #reconnect() {
        this.#reconnectTimer = null;
        this.#connect();
    }

    #cancelReconnect() {
        if (this.#reconnectTimer !== null) {
            globalThis.clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }
}
