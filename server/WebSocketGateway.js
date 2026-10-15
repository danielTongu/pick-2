"use strict";

import { isIP } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

/** Bounds hosted WebSocket resources and adapts accepted clients to the transport-neutral Host. */
export class WebSocketGateway {
    /** @type {number} Default maximum established sockets. */
    static MAX_CONNECTIONS = 5000;

    /** @type {number} Default simultaneous sockets per client IP. */
    static MAX_CONNECTIONS_PER_IP = 128;

    /** @type {number} Largest accepted client message. */
    static MAX_PAYLOAD_BYTES = 8 * 1024;

    /** @type {number} Largest queued outbound data per socket. */
    static MAX_BUFFERED_BYTES = 256 * 1024;

    /** @type {number} Transport-message accounting window. */
    static MESSAGE_WINDOW_MS = 10_000;

    /** @type {number} Maximum messages per socket per accounting window. */
    static MAX_MESSAGES_PER_WINDOW = 60;

    /** @type {number} Maximum unfinished Host requests per socket. */
    static MAX_IN_FLIGHT_REQUESTS = 8;

    /** @type {number} Maximum handshake attempts per IP per accounting window. */
    static MAX_UPGRADES_PER_IP = 120;

    /** @type {number} Handshake accounting window. */
    static UPGRADE_WINDOW_MS = 60_000;

    /** @type {number} Bound on retained handshake counters. */
    static MAX_TRACKED_IPS = 10_000;

    /** @type {number} Time between ping/pong checks. */
    static HEARTBEAT_INTERVAL_MS = 30_000;

    /** @type {number} Grace period before forcibly closing a rejected socket. */
    static CLOSE_TIMEOUT_MS = 1000;

    /** @type {import("../host/Host.js").Host} Authoritative application Host. */
    #host;

    /** @type {WebSocketServer} Server that owns accepted sockets and upgrades. */
    #server;

    /** @type {Set<string>} Exact allowed browser origins. */
    #allowedOrigins;

    /** @type {Set<string>} Explicitly trusted proxy peer addresses. */
    #trustedProxyIps;

    /** @type {Object} Validated resource limits for this gateway. */
    #limits;

    /** @type {Map<WebSocket, Object>} State and Host connection for each socket. */
    #clients = new Map();

    /** @type {Map<string, number>} Active socket counts by client IP. */
    #connectionsByIp = new Map();

    /** @type {Map<string, Object>} Bounded handshake-rate counters. */
    #upgradeAttempts = new Map();

    /** @type {Set<Promise>} Host disconnect operations awaiting completion. */
    #disconnects = new Set();

    /** @type {Promise<void>|null} Idempotent shutdown operation. */
    #closing = null;

    /**
     * Creates a gateway with synchronous admission checks before the WebSocket handshake completes.
     * Compression is disabled, so admission and connection accounting do not yield between checks.
     * @param {import("node:http").Server} server - Owning HTTP server.
     * @param {import("../host/Host.js").Host} host - Application Host.
     * @param {Object} policy - Allowed origins, trusted proxy IPs, and optional resource limits.
     */
    constructor(server, host, policy) {
        this.#host = host;
        this.#allowedOrigins = new Set();
        for (const origin of policy.allowedOrigins) {
            const url = new URL(origin);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
                throw new Error(`Invalid allowed WebSocket origin: ${origin}`);
            }
            this.#allowedOrigins.add(url.origin);
        }
        if (this.#allowedOrigins.size === 0) throw new Error("WebSocket allowed origins must not be empty.");
        this.#trustedProxyIps = new Set();
        for (const address of policy.trustedProxyIps ?? []) {
            const normalized = WebSocketGateway.#normalizeAddress(address);
            if (!normalized) throw new Error(`Invalid trusted proxy IP: ${address}`);
            this.#trustedProxyIps.add(normalized);
        }
        this.#limits = Object.freeze({
            maxConnections: WebSocketGateway.MAX_CONNECTIONS,
            maxConnectionsPerIp: WebSocketGateway.MAX_CONNECTIONS_PER_IP,
            maxPayloadBytes: WebSocketGateway.MAX_PAYLOAD_BYTES,
            maxBufferedBytes: WebSocketGateway.MAX_BUFFERED_BYTES,
            messageWindowMs: WebSocketGateway.MESSAGE_WINDOW_MS,
            maxMessagesPerWindow: WebSocketGateway.MAX_MESSAGES_PER_WINDOW,
            maxInFlightRequests: WebSocketGateway.MAX_IN_FLIGHT_REQUESTS,
            maxUpgradesPerIp: WebSocketGateway.MAX_UPGRADES_PER_IP,
            upgradeWindowMs: WebSocketGateway.UPGRADE_WINDOW_MS,
            maxTrackedIps: WebSocketGateway.MAX_TRACKED_IPS,
            ...policy.limits
        });
        for (const [name, limit] of Object.entries(this.#limits)) {
            if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid WebSocket limit: ${name}`);
        }
        this.#server = new WebSocketServer({
            server,
            maxPayload: this.#limits.maxPayloadBytes,
            perMessageDeflate: false,
            verifyClient: this.#verifyUpgrade.bind(this)
        });
        this.#server.on("connection", this.#connect.bind(this));
    }

    /** Prunes handshake counters, pings responsive clients, and removes clients missing their pong. */
    maintain() {
        const now = Date.now();
        for (const [address, counter] of this.#upgradeAttempts) {
            if (now - counter.startedAt >= this.#limits.upgradeWindowMs) this.#upgradeAttempts.delete(address);
        }
        for (const [socket, state] of this.#clients) {
            if (!state.alive) {
                socket.terminate();
            } else if (socket.readyState === WebSocket.OPEN) {
                state.alive = false;
                socket.ping();
            }
        }
    }

    /** Closes sockets and waits for Host memberships to be released. */
    close() {
        if (this.#closing === null) this.#closing = this.#shutdown();
        return this.#closing;
    }

    /** @returns {Promise<void>} Socket and membership cleanup completion. */
    async #shutdown() {
        for (const socket of this.#server.clients) socket.terminate();
        await new Promise(this.#closeServer.bind(this));
        await Promise.allSettled(this.#disconnects);
        this.#server.removeAllListeners();
        this.#upgradeAttempts.clear();
    }

    /** @param {Function} resolve - Resolves when the WebSocket server has closed. */
    #closeServer(resolve) {
        this.#server.close(resolve);
    }

    /**
     * Admits only configured browser origins and enforces global, IP, and handshake-rate limits.
     * @param {Object} info - WebSocket handshake information.
     * @param {Function} done - Synchronous admission result callback.
     */
    #verifyUpgrade(info, done) {
        if (!this.#allowedOrigins.has(info.origin)) {
            done(false, 403, "Origin not allowed");
            return;
        }
        const address = this.#clientAddress(info.req);
        if (!address || !this.#allowUpgrade(address)) {
            done(false, 429, "Too many connection attempts", { "Retry-After": String(Math.ceil(this.#limits.upgradeWindowMs / 1000)) });
        } else if (this.#closing !== null || this.#server.clients.size >= this.#limits.maxConnections) {
            done(false, 503, "Connection capacity reached", { "Retry-After": "30" });
        } else if ((this.#connectionsByIp.get(address) ?? 0) >= this.#limits.maxConnectionsPerIp) {
            done(false, 429, "Connection limit reached", { "Retry-After": "30" });
        } else {
            done(true);
        }
    }

    /**
     * Checks a bounded, per-IP handshake counter.
     * @param {string} address - Normalized client address.
     * @returns {boolean} Whether another handshake attempt is permitted.
     */
    #allowUpgrade(address) {
        const now = Date.now();
        let counter = this.#upgradeAttempts.get(address);
        if (counter === undefined) {
            if (this.#upgradeAttempts.size >= this.#limits.maxTrackedIps) return false;
            counter = { startedAt: now, count: 0 };
            this.#upgradeAttempts.set(address, counter);
        }
        if (now - counter.startedAt >= this.#limits.upgradeWindowMs) {
            counter.startedAt = now;
            counter.count = 0;
        }
        counter.count += 1;
        return counter.count <= this.#limits.maxUpgradesPerIp;
    }

    /**
     * Uses forwarded addresses only through a chain of explicitly trusted proxy peers.
     * @param {import("node:http").IncomingMessage} request - Upgrade request.
     * @returns {string} Normalized client address, or empty text for an invalid peer.
     */
    #clientAddress(request) {
        let address = WebSocketGateway.#normalizeAddress(request.socket.remoteAddress);
        const forwarded = request.headers["x-forwarded-for"];
        if (this.#trustedProxyIps.has(address) && typeof forwarded === "string") {
            const chain = forwarded.split(",");
            for (let index = chain.length - 1; index >= 0 && this.#trustedProxyIps.has(address); index -= 1) {
                const next = WebSocketGateway.#normalizeAddress(chain[index].trim());
                if (!next) return WebSocketGateway.#normalizeAddress(request.socket.remoteAddress);
                address = next;
            }
        }
        return address;
    }

    /**
     * Normalizes IPv4, IPv6, and IPv4-mapped IPv6 without trusting caller-controlled labels.
     * @param {*} address - Address to normalize.
     * @returns {string} Canonical IP address, or empty text when invalid.
     */
    static #normalizeAddress(address) {
        if (typeof address !== "string") return "";
        address = address.split("%")[0];
        const family = isIP(address);
        if (family === 4) return address;
        if (family !== 6) return "";
        const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
        if (!normalized.startsWith("::ffff:")) return normalized;
        const parts = normalized.slice(7).split(":");
        const high = Number.parseInt(parts[0], 16);
        const low = Number.parseInt(parts[1], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }

    /**
     * Accounts for an admitted connection and binds bounded message handling.
     * @param {WebSocket} socket - Accepted client.
     * @param {import("node:http").IncomingMessage} request - Upgrade request.
     */
    #connect(socket, request) {
        const address = this.#clientAddress(request);
        this.#connectionsByIp.set(address, (this.#connectionsByIp.get(address) ?? 0) + 1);
        const state = { address, connection: null, alive: true, startedAt: Date.now(), messages: 0, inFlight: 0 };
        this.#clients.set(socket, state);
        socket.on("close", this.#disconnect.bind(this, socket));
        socket.on("error", WebSocketGateway.#ignoreSocketError);
        socket.on("pong", this.#handlePong.bind(this, state));
        socket.on("message", this.#receive.bind(this, socket, state));
        try {
            state.connection = this.#host.accept(this.#publish.bind(this, socket), this.#closeSocket.bind(this, socket));
        } catch (error) {
            console.error("WebSocket admission failed:", error);
            this.#closeSocket(socket, 1011, "Server error");
        }
    }

    /**
     * Releases capacity immediately on close and schedules authoritative membership cleanup.
     * @param {WebSocket} socket - Closed client.
     */
    #disconnect(socket) {
        const state = this.#clients.get(socket);
        if (state === undefined) return;
        this.#clients.delete(socket);
        const count = (this.#connectionsByIp.get(state.address) ?? 1) - 1;
        if (count > 0) this.#connectionsByIp.set(state.address, count);
        else this.#connectionsByIp.delete(state.address);
        const cleanup = Promise.resolve().then(WebSocketGateway.#closeConnection.bind(null, state.connection));
        this.#disconnects.add(cleanup);
        void cleanup.catch(WebSocketGateway.#reportCleanupError).finally(this.#disconnects.delete.bind(this.#disconnects, cleanup));
    }

    /** @param {Object|null} connection - Host-side connection to release. */
    static async #closeConnection(connection) {
        await connection?.close();
    }

    /** @param {*} error - Unexpected membership cleanup error. */
    static #reportCleanupError(error) {
        console.error("WebSocket cleanup failed:", error);
    }

    /** Absorbs transport errors; close owns capacity and membership cleanup. */
    static #ignoreSocketError() {}

    /** @param {Object} state - Client whose heartbeat was answered. */
    #handlePong(state) {
        state.alive = true;
    }

    /**
     * Validates and rate-limits a frame before allocating Host work.
     * @param {WebSocket} socket - Sending client.
     * @param {Object} state - Per-client accounting.
     * @param {Buffer} message - Reassembled message, already bounded by maxPayload.
     * @param {boolean} isBinary - Whether the frame is binary.
     */
    #receive(socket, state, message, isBinary) {
        if (socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now - state.startedAt >= this.#limits.messageWindowMs) {
            state.startedAt = now;
            state.messages = 0;
        }
        state.messages += 1;
        if (state.messages > this.#limits.maxMessagesPerWindow || state.inFlight >= this.#limits.maxInFlightRequests) {
            this.#closeSocket(socket, 1008, "Request limit reached");
            return;
        }
        if (isBinary) {
            this.#closeSocket(socket, 1003, "Text messages required");
            return;
        }
        let request;
        try {
            request = JSON.parse(message.toString());
        } catch (_error) {
            this.#closeSocket(socket, 1007, "Invalid JSON");
            return;
        }
        state.inFlight += 1;
        void Promise.resolve().then(WebSocketGateway.#dispatch.bind(null, state.connection, request))
            .catch(this.#requestFailed.bind(this, socket))
            .finally(WebSocketGateway.#completeRequest.bind(null, state));
    }

    /**
     * @param {Object} connection - Host connection.
     * @param {*} request - Parsed application request.
     */
    static async #dispatch(connection, request) {
        await connection.receive(request);
    }

    /** @param {Object} state - Client whose Host request has completed. */
    static #completeRequest(state) {
        state.inFlight -= 1;
    }

    /**
     * @param {WebSocket} socket - Client whose request failed unexpectedly.
     * @param {*} error - Unexpected Host error.
     */
    #requestFailed(socket, error) {
        console.error("WebSocket request failed:", error);
        this.#closeSocket(socket, 1011, "Server error");
    }

    /**
     * Sends only while the socket is open and terminates slow consumers before queues grow unbounded.
     * @param {WebSocket} socket - Destination socket.
     * @param {Object} response - Transport response.
     */
    #publish(socket, response) {
        if (socket.readyState !== WebSocket.OPEN) return;
        const payload = JSON.stringify(response);
        if (socket.bufferedAmount + Buffer.byteLength(payload) > this.#limits.maxBufferedBytes) {
            socket.terminate();
            return;
        }
        socket.send(payload);
    }

    /**
     * Closes a client with a bounded grace period.
     * @param {WebSocket} socket - Socket to close.
     * @param {number} code - WebSocket close code.
     * @param {string} reason - Short close reason.
     */
    #closeSocket(socket, code, reason) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.close(code, reason);
        const timer = globalThis.setTimeout(socket.terminate.bind(socket), WebSocketGateway.CLOSE_TIMEOUT_MS);
        timer.unref?.();
        socket.once("close", globalThis.clearTimeout.bind(null, timer));
    }
}
