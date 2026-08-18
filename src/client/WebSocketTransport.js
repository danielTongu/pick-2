"use strict";

import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { Transport } from "./Transport.js";

/**
 * Connects GameClient to the Server-mode WebSocket endpoint.
 */
export class WebSocketTransport extends Transport {
    /** @type {string} */
    #url;

    /** @type {WebSocket|null} */
    #socket = null;

    /** @type {number|null} */
    #reconnectTimer = null;

    /** @type {number} */
    #reconnectAttempts = 0;

    /** @type {boolean} */
    #shouldReconnect = true;

    /**
     * @param {string} url - WebSocket URL.
     */
    constructor(url) {
        super();
        this.#url = NormalizeUtils.requiredString(url, "WebSocket URL");
    }

    /** Opens the WebSocket connection. */
    connect() {
        this.#shouldReconnect = true;
        this.#reconnectAttempts = 0;
        this.#open();
    }

    /**
     * Sends one request.
     *
     * @param {{type:string,payload:Object}} request - Action request.
     * @returns {boolean} Whether the socket accepted the request.
     */
    send(request) {
        const canSend = this.#socket instanceof WebSocket && this.#socket.readyState === WebSocket.OPEN;

        if (canSend) {
            this.#socket.send(JSON.stringify(request));
        }

        return canSend;
    }

    /** Closes the WebSocket connection without reconnecting. */
    close() {
        this.#shouldReconnect = false;
        this.#cancelReconnect();
        this.#socket?.close();
        this.#socket = null;
    }

    /** Opens and binds a new WebSocket. */
    #open() {
        this.onStatus?.("connecting", "Connecting...");
        const socket = new WebSocket(this.#url);

        this.#socket = socket;
        socket.addEventListener("open", () => {
            if (this.#socket !== socket) {
                return;
            }

            this.#cancelReconnect();
            this.#reconnectAttempts = 0;
            this.onStatus?.("connected", "Server");
            this.onOpen?.();
        });
        socket.addEventListener("message", (event) => {
            if (this.#socket === socket) {
                this.onMessage?.(event.data);
            }
        });
        socket.addEventListener("close", () => {
            if (this.#socket !== socket) {
                return;
            }

            this.#socket = null;
            this.onStatus?.("disconnected", "Disconnected");
            this.onClose?.();
            this.#scheduleReconnect();
        });
        socket.addEventListener("error", () => {
            if (this.#socket === socket) {
                this.onStatus?.("error", "Connection error");
                socket.close();
            }
        });
    }

    /** Schedules a bounded reconnect attempt. */
    #scheduleReconnect() {
        if (!this.#shouldReconnect || this.#reconnectAttempts >= 5 || this.#reconnectTimer !== null) {
            return;
        }

        const delay = Math.min(1000 * (2 ** this.#reconnectAttempts), 30_000);
        this.#reconnectAttempts += 1;
        this.#reconnectTimer = globalThis.setTimeout(() => {
            this.#reconnectTimer = null;
            this.#open();
        }, delay);
    }

    /** Cancels a scheduled reconnect. */
    #cancelReconnect() {
        if (this.#reconnectTimer !== null) {
            globalThis.clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }
}
