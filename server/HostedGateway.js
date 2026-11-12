"use strict";

import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { HostedProtocol } from "../shared/HostedProtocol.js";

/** Owns authenticated Hosted sessions for WebSocket admission, commands, and replay. */
export class HostedGateway {
    /** @type {Readonly<Object>} Default per-process session resource budgets. */
    static DEFAULT_LIMITS = Object.freeze({
        maxSessions: 5000, maxSessionsPerIp: 128,
        maxEventBytes: 262144, maxEvents: 128, maxInFlight: 8,
        maxCommandsPerWindow: 80, commandWindowMs: 10000,
        maxSessionCreatesPerIp: 120, creationWindowMs: 60000, maxTrackedIps: 10000,
        sessionTtlMs: 60000
    });

    /** @type {number} Expiration and throttle maintenance interval. */
    static MAINTENANCE_INTERVAL_MS = 10000;

    /** @type {import("../host/Host.js").Host} Transport-independent application host. */
    #host;

    /** @type {Set<string>} Exact allowed browser origins. */
    #allowedOrigins = new Set();

    /** @type {Set<string>} Explicitly trusted reverse proxy IPs. */
    #trustedProxyIps = new Set();

    /** @type {Object} Validated resource limits. */
    #limits;

    /** @type {Map<string, Object>} Bearer-token session records; tokens never enter snapshots. */
    #sessions = new Map();

    /** @type {Map<string, number>} Concurrent session counts by client IP. */
    #sessionsByIp = new Map();

    /** @type {Map<string, Object>} Bounded session-creation counters. */
    #creationAttempts = new Map();

    /** @type {Set<Promise>} Pending command and membership-cleanup operations. */
    #pending = new Set();

    /** @type {boolean} Whether shutdown has begun. */
    #closed = false;

    /**
     * Creates the session owner without opening sockets or installing global timers.
     * @param {import("../host/Host.js").Host} host - Application authority.
     * @param {Object} policy - Allowed origins, trusted proxies, and optional limits.
     */
    constructor(host, policy) {
        this.#host = host;
        for (const origin of policy.allowedOrigins) {
            const url = new URL(origin);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
                url.pathname !== "/" || url.search || url.hash) throw new Error(`Invalid allowed WebSocket origin: ${origin}`);
            this.#allowedOrigins.add(url.origin);
        }
        if (this.#allowedOrigins.size === 0) throw new Error("WebSocket allowed origins must not be empty.");
        for (const address of policy.trustedProxyIps ?? []) {
            const normalized = HostedGateway.#normalizeAddress(address);
            if (!normalized) throw new Error(`Invalid trusted proxy IP: ${address}`);
            this.#trustedProxyIps.add(normalized);
        }
        this.#limits = Object.freeze({ ...HostedGateway.DEFAULT_LIMITS, ...policy.limits });
        for (const [name, value] of Object.entries(this.#limits)) {
            if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid session limit: ${name}`);
        }
    }

    /**
     * Checks the exact browser Origin before the upgrade is accepted.
     * @param {string} origin - Browser-supplied origin.
     * @returns {boolean} Whether the deployment explicitly permits this origin.
     */
    allowsOrigin(origin) {
        return this.#allowedOrigins.has(origin);
    }

    /**
     * Creates a new bounded session and attaches its initial socket.
     * @param {string} address - Client IP resolved through trusted proxies.
     * @param {Function} send - Bounded frame sender.
     * @param {Function} disconnect - Socket close callback.
     * @returns {Object} Stream operations or the WebSocket rejection code.
     */
    createStream(address, send, disconnect) {
        const capacityReached = this.#sessions.size >= this.#limits.maxSessions ||
            (this.#sessionsByIp.get(address) ?? 0) >= this.#limits.maxSessionsPerIp;
        if (this.#closed || !address || !this.#allowCreation(address) || capacityReached) {
            return { stream: null, closeCode: 1013 };
        }
        const token = randomBytes(32).toString("base64url");
        const session = { token, address, tabId: randomUUID(), connection: null, stream: null, events: [],
            eventBytes: 2, sequence: 0, acknowledgedSequence: 0, lastSeenAt: Date.now(),
            windowStartedAt: Date.now(), commands: 0, inFlight: 0 };
        this.#sessions.set(token, session);
        this.#sessionsByIp.set(address, (this.#sessionsByIp.get(address) ?? 0) + 1);
        try {
            session.connection = this.#host.accept(this.#publish.bind(this, session), this.#release.bind(this, session));
            return this.openStream(token, 0, send, disconnect);
        } catch (error) {
            this.#release(session);
            throw error;
        }
    }

    /**
     * Authenticates a live stream using a first-frame token, then replays unacknowledged events.
     * Socket lifetime is independent from the retained session's membership lifetime.
     * @param {string} token - Secret credential delivered inside the encrypted socket, never its URL.
     * @param {number} cursor - Last delivered event sequence.
     * @param {Function} send - Bounded socket-frame sender.
     * @param {Function} disconnect - Socket close callback.
     * @returns {{stream:Object|null, closeCode?:number}} Stream operations or the WebSocket rejection code.
     */
    openStream(token, cursor, send, disconnect) {
        const session = typeof token === "string" ? this.#sessions.get(token) : undefined;
        let result = { stream: null, closeCode: 4001 };
        if (!this.#closed && session !== undefined) {
            if (Date.now() - session.lastSeenAt >= this.#limits.sessionTtlMs) {
                this.#release(session);
            } else {
                const events = this.#events(session, cursor);
                if (events === null) {
                    this.#release(session);
                    result.closeCode = 4009;
                } else {
                    session.stream?.disconnect(4000, "Connection replaced");
                    const stream = { send, disconnect };
                    session.stream = stream;
                    session.lastSeenAt = Date.now();
                    send({ type: "ready", service: "pick-2", version: HostedProtocol.VERSION, token: session.token });
                    for (const event of events) send({ type: "event", ...event });
                    result = { stream: {
                        receive: this.#receiveStream.bind(this, session, stream),
                        acknowledge: this.#acknowledgeStream.bind(this, session, stream),
                        touch: this.#touchStream.bind(this, session, stream),
                        close: this.#detachStream.bind(this, session, stream),
                        release: this.#releaseStream.bind(this, session, stream)
                    } };
                }
            }
        }
        return result;
    }

    /**
     * Admits room and gameplay commands only from the currently authenticated socket.
     * @param {Object} session - Retained Hosted session.
     * @param {Object} stream - Current socket identity.
     * @param {Object} request - Untrusted game command.
     */
    #receiveStream(session, stream, request) {
        if (this.#sessions.has(session.token) && session.stream === stream) {
            const command = request?.command;
            const data = request?.data;
            if (!HostedProtocol.COMMANDS.includes(command) || data === null || typeof data !== "object" || Array.isArray(data)) {
                stream.disconnect(1008, "Valid command required");
            } else if (!this.#allowCommand(session) || session.inFlight >= this.#limits.maxInFlight) {
                stream.disconnect(1008, "Request limit reached");
            } else {
                session.lastSeenAt = Date.now();
                session.inFlight += 1;
                this.#track(this.#dispatch(session, { command, data: { ...data, tabId: session.tabId } }));
            }
        }
    }

    /**
     * Releases delivered events while preserving replay across a dropped connection.
     * @param {Object} session - Retained Hosted session.
     * @param {Object} stream - Current socket identity.
     * @param {number} cursor - Last fully delivered event.
     */
    #acknowledgeStream(session, stream, cursor) {
        if (session.stream === stream && this.#sessions.has(session.token)) {
            if (this.#events(session, cursor) === null) {
                stream.disconnect(4009, "Invalid event cursor");
                this.#release(session);
            }
        }
    }

    /**
     * Records transport liveness without changing game activity or player idle windows.
     * @param {Object} session - Retained Hosted session.
     * @param {Object} stream - Current socket identity.
     */
    #touchStream(session, stream) {
        if (session.stream === stream && this.#sessions.has(session.token)) session.lastSeenAt = Date.now();
    }

    /**
     * Detaches an obsolete socket without removing the player's retained membership.
     * @param {Object} session - Retained Hosted session.
     * @param {Object} stream - Closed socket identity.
     */
    #detachStream(session, stream) {
        if (session.stream === stream) session.stream = null;
    }

    /** Expires abandoned sessions and old IP counters without refreshing game activity. */
    maintain() {
        const now = Date.now();
        for (const session of this.#sessions.values()) {
            if (now - session.lastSeenAt >= this.#limits.sessionTtlMs) this.#release(session);
        }
        for (const [address, counter] of this.#creationAttempts) {
            if (now - counter.startedAt >= this.#limits.creationWindowMs) this.#creationAttempts.delete(address);
        }
    }

    /** Stops admission, releases memberships, and waits for outstanding Host work. */
    async close() {
        this.#closed = true;
        for (const session of this.#sessions.values()) this.#release(session);
        while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
        this.#creationAttempts.clear();
    }

    /**
     * Releases acknowledged events and returns only missed recipient-specific responses.
     * @param {Object} session - Authenticated session.
     * @param {number} cursor - Last successfully delivered sequence number.
     * @returns {Object[]|null} Retained events, or null for an invalid/unavailable cursor.
     */
    #events(session, cursor) {
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > session.sequence) {
            return null;
        }
        if (cursor < session.acknowledgedSequence || (session.events.length > 0 && cursor < session.events[0].sequence - 1)) {
            return null;
        }
        session.acknowledgedSequence = cursor;
        session.events = session.events.filter(function unacknowledged(event) { return event.sequence > cursor; });
        session.eventBytes = Buffer.byteLength(JSON.stringify(session.events));
        return session.events.slice();
    }

    /**
     * Ends only the session owned by this current socket; obsolete sockets cannot release replacements.
     * @param {Object} session - Retained Hosted session.
     * @param {Object} stream - Socket attempting explicit departure.
     */
    #releaseStream(session, stream) {
        if (session.stream === stream) this.#release(session);
    }

    /**
     * Retains already-redacted Host responses within bounded memory.
     * @param {Object} session - Recipient session.
     * @param {Object} response - Recipient-specific Host envelope.
     */
    #publish(session, response) {
        if (!this.#sessions.has(session.token)) return;
        const event = { sequence: ++session.sequence, response };
        const bytes = Buffer.byteLength(JSON.stringify(event)) + (session.events.length > 0 ? 1 : 0);
        if (session.events.length >= this.#limits.maxEvents || session.eventBytes + bytes > this.#limits.maxEventBytes) {
            this.#release(session);
        } else {
            session.events.push(event);
            session.eventBytes += bytes;
            session.stream?.send({ type: "event", ...event });
        }
    }

    /**
     * Dispatches accepted Host work and prevents asynchronous failures escaping the socket lifecycle.
     * @param {Object} session - Initiating authenticated session.
     * @param {Object} command - Canonical Host request with server-owned tab identity.
     */
    async #dispatch(session, command) {
        try {
            await session.connection.receive(command);
        } catch (error) {
            console.error("Hosted command failed:", error);
            this.#release(session);
        } finally {
            session.inFlight -= 1;
        }
    }

    /**
     * Removes capacity immediately and releases authoritative membership once.
     * @param {Object} session - Session being deleted, expired, or disconnected.
     * @returns {Promise<void>} Membership cleanup completion.
     */
    #release(session) {
        let cleanup = Promise.resolve();
        if (this.#sessions.delete(session.token)) {
            session.stream?.disconnect(4001, "Session expired or deleted");
            session.stream = null;
            const count = (this.#sessionsByIp.get(session.address) ?? 1) - 1;
            if (count > 0) this.#sessionsByIp.set(session.address, count);
            else this.#sessionsByIp.delete(session.address);
            cleanup = Promise.resolve().then(HostedGateway.#closeConnection.bind(null, session.connection));
            this.#track(cleanup);
        }
        return cleanup;
    }

    /**
     * Tracks a pending operation and consumes its rejection after logging.
     * @param {Promise} operation - Host command or membership cleanup.
     */
    #track(operation) {
        this.#pending.add(operation);
        void operation.catch(HostedGateway.#reportFailure).finally(this.#pending.delete.bind(this.#pending, operation));
    }

    /** @param {Object|null} connection - Host membership connection to close. */
    static async #closeConnection(connection) {
        await connection?.close();
    }

    /** @param {*} error - Unexpected cleanup failure; no credentials are logged. */
    static #reportFailure(error) {
        console.error("Hosted cleanup failed:", error);
    }

    /**
     * Applies the per-session command budget.
     * @param {Object} session - Authenticated session.
     * @returns {boolean} Whether this request fits the window.
     */
    #allowCommand(session) {
        const now = Date.now();
        if (now - session.windowStartedAt >= this.#limits.commandWindowMs) {
            session.windowStartedAt = now;
            session.commands = 0;
        }
        session.commands += 1;
        return session.commands <= this.#limits.maxCommandsPerWindow;
    }

    /**
     * Applies bounded per-IP session creation accounting.
     * @param {string} address - Trusted client IP.
     * @returns {boolean} Whether another creation attempt is allowed.
     */
    #allowCreation(address) {
        const now = Date.now();
        let counter = this.#creationAttempts.get(address);
        if (counter === undefined) {
            if (this.#creationAttempts.size >= this.#limits.maxTrackedIps) return false;
            counter = { startedAt: now, count: 0 };
            this.#creationAttempts.set(address, counter);
        }
        if (now - counter.startedAt >= this.#limits.creationWindowMs) {
            counter.startedAt = now;
            counter.count = 0;
        }
        counter.count += 1;
        return counter.count <= this.#limits.maxSessionCreatesPerIp;
    }

    /**
     * Resolves client IP through explicitly trusted proxy peers only.
     * @param {Object} request - HTTP headers and socket peer.
     * @returns {string} Normalized client IP.
     */
    clientAddress(request) {
        let address = HostedGateway.#normalizeAddress(request.remoteAddress);
        const forwarded = request.headers["x-forwarded-for"];
        if (this.#trustedProxyIps.has(address) && typeof forwarded === "string") {
            const chain = forwarded.split(",");
            for (let index = chain.length - 1; index >= 0 && this.#trustedProxyIps.has(address); index -= 1) {
                const next = HostedGateway.#normalizeAddress(chain[index].trim());
                if (!next) return HostedGateway.#normalizeAddress(request.remoteAddress);
                address = next;
            }
        }
        return address;
    }

    /**
     * Normalizes IPv4, IPv6, and IPv4-mapped IPv6 addresses.
     * @param {*} address - Socket or trusted forwarded address.
     * @returns {string} Canonical IP or empty string.
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

}
