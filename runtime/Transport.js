"use strict";

import { ValidationUtils } from "../core/ValidationUtils.js";


/** Lifecycle callbacks shared by every Client endpoint implementation. */
export class EndpointEvents {
    /**
     * @param {(function(Object|string): void)|null} receive - Raw response callback.
     * @param {(function(string, string): void)|null} status - Connection-status callback.
     * @param {(function(): void)|null} open - Open callback.
     * @param {(function(): void)|null} close - Close callback.
     */
    constructor(receive, status, open, close) {
        this.receive = receive;
        this.status = status;
        this.open = open;
        this.close = close;
        Object.freeze(this);
    }
}



/** Default in-process endpoint connecting Client to a browser-owned Host. */
export class Endpoint {
    /** @type {import("./Host.js").Host|null} In-process authoritative Host. */
    host;

    /** @param {import("./Host.js").Host|null} [host=null] - In-process authoritative Host. */
    constructor(host = null) {
        this.host = host;
    }

    /** @param {EndpointEvents} events - Client lifecycle callbacks. @returns {Connection} Open connection. */
    open(events) {
        if (!(events instanceof EndpointEvents)) throw new Error("Endpoint.open requires EndpointEvents.");
        return this.createConnection(events);
    }

    /** @param {EndpointEvents} events - Client lifecycle callbacks. @returns {Connection} Direct connection. */
    createConnection(events) {
        return new Connection(this.host, events);
    }
}



/** Publication boundary supplied to Host by a Direct endpoint or Hosted server. */
export class PeerChannel {
    /**
     * @param {function(Object): void} send - Sends a response to the endpoint.
     * @param {function(number=, string=): void} disconnect - Closes the endpoint connection.
     */
    constructor(send, disconnect) {
        if (typeof send !== "function" || typeof disconnect !== "function") {
            throw new Error("PeerChannel requires send and disconnect functions.");
        }

        this.send = send;
        this.disconnect = disconnect;
        Object.freeze(this);
    }
}



/** Browser-only WebSocket endpoint. */
export class WebSocketEndpoint extends Endpoint {
    /** @type {string} Validated WebSocket endpoint URL. */
    #url;

    /** @param {string} url - WebSocket endpoint URL. */
    constructor(url) {
        super();
        this.#url = ValidationUtils.requiredString(url, "WebSocket URL");
    }

    /**
     * Opens a reconnecting browser WebSocket connection.
     *
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     * @returns {WebSocketConnection} Connection handle.
     */
    createConnection(events) {
        return new WebSocketConnection(this.#url, events);
    }
}



/** Default in-process Client connection. */
export class Connection {
    /** @type {import("./Host.js").Host|null} In-process authoritative Host. */
    host;

    /** @type {EndpointEvents} Client lifecycle callbacks. */
    events;

    /** @type {boolean} Whether the connection accepts requests and responses. */
    isOpen;

    /** @type {import("./Session.js").HostPeer|null} Direct Host peer. */
    peer;

    /**
     * @param {import("./Host.js").Host|null} host - Direct Host; null for a specialized connection.
     * @param {EndpointEvents} events - Client callbacks.
     * @param {boolean} connect - Whether to connect to the Host immediately.
     */
    constructor(host, events, connect = true) {
        if (!(events instanceof EndpointEvents)) {
            throw new Error("Connection requires EndpointEvents.");
        }
        if (connect && typeof host?.accept !== "function") {
            throw new Error("Direct Connection requires a Host.");
        }

        this.host = host;
        this.events = events;
        this.isOpen = true;
        this.peer = null;
        if (connect) {
            events.status?.("connecting", "Starting direct room…");
            this.peer = host.accept(this.createChannel());
            queueMicrotask(this.notifyOpen.bind(this));
        }
    }

    /** @returns {PeerChannel} Host publication channel used by this connection. */
    createChannel() {
        return new PeerChannel(this.receive.bind(this), this.close.bind(this));
    }

    /** @param {Object} request - Canonical command request. @returns {boolean} Whether queued. */
    request(request) {
        if (!this.isOpen) return false;
        queueMicrotask(this.deliver.bind(this, structuredClone(request)));
        return true;
    }

    /** @param {Object} request - Cloned command request. */
    deliver(request) {
        if (this.isOpen) {
            void this.peer?.receive(request);
        }
    }

    /** @param {Object} response - Canonical Host response. */
    receive(response) {
        if (this.isOpen) queueMicrotask(this.deliverResponse.bind(this, structuredClone(response)));
    }

    /** @param {Object} response - Cloned Host response. */
    deliverResponse(response) {
        if (this.isOpen) {
            this.events.receive?.(response);
        }
    }

    /** @param {number} [_code] - Optional transport close code. @param {string} [_reason] - Optional close reason. */
    close(_code, _reason) {
        if (!this.isOpen) return;
        this.isOpen = false;
        void this.peer?.close();
        this.events.status?.("disconnected", "Closed");
        this.events.close?.();
    }

    /** Announces readiness after construction completes. */
    notifyOpen() {
        if (this.isOpen) {
            this.events.status?.("connected", "Direct");
            this.events.open?.();
        }
    }
}



/** One reconnecting browser WebSocket connection. */
class WebSocketConnection extends Connection {
    /** @type {string} Validated WebSocket endpoint URL. */
    #url;

    /** @type {WebSocket|null} Current socket, including sockets still connecting. */
    #socket = null;

    /** @type {number|null} Pending reconnect timeout identifier. */
    #reconnectTimer = null;

    /** @type {number} Consecutive reconnect attempts used for exponential backoff. */
    #reconnectAttempts = 0;

    /**
     * @param {string} url - WebSocket endpoint URL.
     * @param {EndpointEvents} events - Endpoint lifecycle callbacks.
     */
    constructor(url, events) {
        super(null, events, false);
        this.#url = url;
        this.#connect();
    }

    /** @param {Object} request - Canonical command request. @returns {boolean} Whether sent. */
    request(request) {
        const canSend = this.#socket instanceof WebSocket && this.#socket.readyState === WebSocket.OPEN;

        if (canSend) {
            this.#socket.send(JSON.stringify(request));
        }

        return canSend;
    }

    /** @param {number} [code] - Optional WebSocket close code. @param {string} [reason] - Optional close reason. */
    close(code, reason) {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.#cancelReconnect();
        this.#socket?.close(code, reason);
        this.#socket = null;
        this.events.status?.("disconnected", "Closed");
        this.events.close?.();
    }

    /** Creates the current socket and binds guarded lifecycle listeners. */
    #connect() {
        const isReconnecting = this.#reconnectAttempts > 0;
        this.events.status?.(
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

    /** @param {WebSocket} socket - Socket that emitted the open event. */
    #handleOpen(socket) {
        if (this.#socket !== socket || !this.isOpen) {
            return;
        }

        this.#cancelReconnect();
        this.#reconnectAttempts = 0;
        this.events.status?.("connected", "Network");
        this.events.open?.();
    }

    /** @param {WebSocket} socket - Socket that received data. @param {MessageEvent} event - Message event. */
    #handleMessage(socket, event) {
        if (this.#socket === socket && this.isOpen) {
            this.events.receive?.(event.data);
        }
    }

    /** @param {WebSocket} socket - Socket that emitted the close event. */
    #handleClose(socket) {
        if (this.#socket !== socket) {
            return;
        }

        this.#socket = null;
        this.events.status?.("disconnected", "Disconnected");
        this.events.close?.();
        this.#scheduleReconnect();
    }

    /** @param {WebSocket} socket - Socket that emitted the error event. */
    #handleError(socket) {
        if (this.#socket === socket) {
            this.events.status?.("error", "Connection error");
            socket.close();
        }
    }

    /** Schedules one exponential-backoff reconnect, capped at five attempts and 30 seconds. */
    #scheduleReconnect() {
        if (!this.isOpen || this.#reconnectAttempts >= 5 || this.#reconnectTimer !== null) {
            return;
        }

        const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
        this.#reconnectAttempts += 1;
        this.events.status?.("reconnecting", "Reconnecting…");
        this.#reconnectTimer = globalThis.setTimeout(this.#reconnect.bind(this), delay);
    }

    /** Clears the elapsed timer and begins the next connection attempt. */
    #reconnect() {
        this.#reconnectTimer = null;
        this.#connect();
    }

    /** Cancels and clears the pending reconnect timeout, if any. */
    #cancelReconnect() {
        if (this.#reconnectTimer !== null) {
            globalThis.clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }
}
