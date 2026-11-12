"use strict";

import { HostedProtocol } from "../shared/HostedProtocol.js";

/** Single WebSocket lifecycle for Hosted admission, room commands, gameplay, and replay. */
export class HostedClient {
    /** @type {string} Configured HTTP server origin. */
    #origin;

    /** @type {Object} Status, open, close, response, and exhausted callbacks. */
    #callbacks;

    /** @type {string|null} Secret bearer token; never persisted or placed in a URL. */
    #token = null;

    /** @type {WebSocket|null} Active or connecting live channel. */
    #socket = null;

    /** @type {number} Last fully delivered live event sequence. */
    #cursor = 0;

    /** @type {number} Invalidates obsolete network callbacks. */
    #generation = 0;

    /** @type {boolean} Whether the page still owns this transport lifetime. */
    #running = false;

    /** @type {boolean} Whether the authenticated socket accepts game commands. */
    #connected = false;

    /** @type {boolean} Whether the newly created server session needs page admission. */
    #needsAdmission = false;

    /** @type {boolean} Whether this connection should retry automatically. */
    #retry;

    /** @type {boolean} Whether recovery already owns the next connection attempt. */
    #recovering = false;

    /** @type {number} Consecutive failed connection attempts. */
    #retryAttempts = 0;

    /** @type {number} Protocol failures during this client lifetime; ready frames cannot reset this budget. */
    #protocolFailures = 0;

    /** @type {ReturnType<typeof setTimeout>|null} Pending reconnect attempt. */
    #retryTimer = null;

    /** @type {ReturnType<typeof setTimeout>|null} Current socket authentication deadline. */
    #authenticationTimer = null;

    /**
     * Binds one deployment origin and its live channel to browser session callbacks.
     * @param {string} origin - HTTP/HTTPS server address without credentials.
     * @param {Object} callbacks - Transport lifecycle and response callbacks.
     * @param {boolean} retry - Whether to retry after transport failure.
     */
    constructor(origin, callbacks, retry = true) {
        const url = new URL(origin);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
            throw new Error("Hosted server requires an HTTP/HTTPS origin without credentials.");
        }
        this.#origin = url.origin;
        this.#callbacks = callbacks;
        this.#retry = retry;
    }

    /** Opens the channel and requests either a fresh session or authenticated replay. */
    start() {
        if (!this.#running) {
            this.#running = true;
            this.#retryAttempts = 0;
            this.#protocolFailures = 0;
            this.#open(++this.#generation);
        }
    }

    /** Cancels transport resources and best-effort releases remote membership on departure. */
    stop() {
        this.#running = false;
        this.#connected = false;
        this.#generation += 1;
        this.#clearTimers();
        const socket = this.#socket;
        this.#socket = null;
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "release" }));
        }
        socket?.close();
        this.#token = null;
        this.#cursor = 0;
    }

    /**
     * Sends one command without automatically replaying uncertain mutations.
     * @param {string} command - Canonical room or game command.
     * @param {Object} data - Command-specific fields.
     * @returns {boolean} Whether the active socket accepted delivery.
     */
    request(command, data) {
        if (!HostedProtocol.COMMANDS.includes(command)) throw new Error(`Unknown Hosted command: ${command}`);
        if (this.#running && this.#connected && this.#socket?.readyState === WebSocket.OPEN) {
            this.#socket.send(JSON.stringify({ command, data }));
            return true;
        }
        return false;
    }

    /**
     * Opens one bounded socket attempt while retaining a valid credential across network loss.
     * @param {number} generation - Current transport lifetime.
     */
    #open(generation) {
        this.#recovering = false;
        this.#notify("status", this.#retryAttempts > 0 ? "reconnecting" : "connecting", "Connecting…");
        if (!this.#current(generation)) return;
        try {
            const url = new URL(HostedProtocol.PATH, this.#origin);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            const socket = new WebSocket(url.href);
            this.#socket = socket;
            socket.addEventListener("open", this.#authenticate.bind(this, generation, socket));
            socket.addEventListener("message", this.#receiveFrame.bind(this, generation, socket));
            socket.addEventListener("close", this.#socketClosed.bind(this, generation, socket));
            socket.addEventListener("error", this.#socketFailed.bind(this, generation, socket));
            this.#authenticationTimer = globalThis.setTimeout(
                this.#recover.bind(this, generation), HostedProtocol.CONNECTION_TIMEOUT_MS);
        } catch (_error) {
            this.#recover(generation);
        }
    }

    /**
     * Creates a fresh session or supplies its secret only in the first frame.
     * @param {number} generation - Current transport lifetime.
     * @param {WebSocket} socket - Newly opened socket.
     */
    #authenticate(generation, socket) {
        if (this.#current(generation) && socket === this.#socket) {
            if (this.#token === null) {
                this.#needsAdmission = true;
                socket.send(JSON.stringify({ type: "create" }));
            } else {
                socket.send(JSON.stringify({ type: "authenticate", token: this.#token, after: this.#cursor }));
            }
        }
    }

    /**
     * Processes readiness and ordered pushed events, acknowledging only delivered frames.
     * @param {number} generation - Current transport lifetime.
     * @param {WebSocket} socket - Live channel delivering the frame.
     * @param {MessageEvent} event - JSON server frame.
     */
    #receiveFrame(generation, socket, event) {
        if (this.#current(generation) && socket === this.#socket) {
            try {
                const frame = JSON.parse(event.data);
                if (frame.type === "ready" && !this.#connected) {
                    if (frame.service !== "pick-2" || frame.version !== HostedProtocol.VERSION ||
                        typeof frame.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(frame.token) ||
                        (this.#token !== null && frame.token !== this.#token)) {
                        throw new Error("Invalid session handshake.");
                    }
                    this.#token = frame.token;
                    globalThis.clearTimeout(this.#authenticationTimer);
                    this.#authenticationTimer = null;
                    this.#connected = true;
                    this.#retryAttempts = 0;
                    this.#notify("status", "connected", "Live");
                    if (this.#needsAdmission && this.#current(generation) && socket === this.#socket) {
                        this.#needsAdmission = false;
                        this.#notify("open");
                    }
                } else if (frame.type === "event" && this.#connected) {
                    if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== this.#cursor + 1 ||
                        frame.response === null || typeof frame.response !== "object") {
                        throw new Error("Invalid live event sequence.");
                    }
                    this.#notify("response", frame.response);
                    if (this.#current(generation) && socket === this.#socket && socket.readyState === WebSocket.OPEN) {
                        this.#cursor = frame.sequence;
                        socket.send(JSON.stringify({ type: "acknowledge", after: this.#cursor }));
                    }
                } else {
                    throw new Error("Unexpected live frame.");
                }
            } catch (_error) {
                this.#recover(generation, "protocol");
            }
        }
    }

    /**
     * Preserves valid credentials across ordinary socket loss and renews expired ones.
     * @param {number} generation - Current transport lifetime.
     * @param {WebSocket} socket - Closed live channel.
     * @param {CloseEvent} event - Close code from the server.
     */
    #socketClosed(generation, socket, event) {
        if (this.#current(generation) && socket === this.#socket) {
            if (event.code === 4009) this.#recover(generation, "protocol");
            else if (event.code === 4001) this.#recover(generation, "expired");
            else this.#recover(generation);
        }
    }

    /**
     * Routes handshake failures through the bounded reconnect lifecycle.
     * @param {number} generation - Current transport lifetime.
     * @param {WebSocket} socket - Failing live channel.
     */
    #socketFailed(generation, socket) {
        if (this.#current(generation) && socket === this.#socket) this.#recover(generation);
    }

    /**
     * Reports page callback failures without changing transport state or exposing payloads.
     * @param {string} name - Owning page callback.
     * @param {...*} args - Callback arguments.
     */
    #notify(name, ...args) {
        try {
            this.#callbacks[name]?.(...args);
        } catch (error) {
            console.error("Page callback failed:", error);
        }
    }

    /**
     * Reconnects after 1, 2, 4, 8, and 16 seconds without replaying uncertain mutations.
     * @param {number} generation - Current transport lifetime.
     * @param {"network"|"expired"|"protocol"} reason - Failure class; protocol errors have an independent lifetime budget.
     */
    #recover(generation, reason = "network") {
        if (this.#current(generation) && !this.#recovering) {
            this.#recovering = true;
            if (reason === "protocol") this.#protocolFailures += 1;
            const retireSession = reason !== "network";
            const retryGeneration = ++this.#generation;
            this.#connected = false;
            this.#clearTimers();
            const socket = this.#socket;
            this.#socket = null;
            if (retireSession && socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "release" }));
            }
            socket?.close();
            if (retireSession) {
                this.#token = null;
                this.#cursor = 0;
            }
            this.#notify("close");
            if (!this.#current(retryGeneration)) return;
            if (!this.#retry || this.#retryAttempts >= 5 || this.#protocolFailures > 5) {
                this.stop();
                this.#notify("exhausted");
            } else {
                const retryAttempt = reason === "protocol"
                    ? Math.max(this.#retryAttempts, this.#protocolFailures - 1) : this.#retryAttempts;
                const delay = 1000 * 2 ** retryAttempt;
                this.#retryAttempts = retryAttempt + 1;
                this.#notify("status", "reconnecting", "Reconnecting…");
                this.#retryTimer = globalThis.setTimeout(this.#open.bind(this, retryGeneration), delay);
            }
        }
    }

    /**
     * Rejects callbacks from a previous transport generation.
     * @param {number} generation - Callback lifetime.
     * @returns {boolean} Whether callbacks can still be delivered.
     */
    #current(generation) {
        return this.#running && generation === this.#generation;
    }

    /** Releases authentication deadlines and pending recovery timers. */
    #clearTimers() {
        globalThis.clearTimeout(this.#retryTimer);
        globalThis.clearTimeout(this.#authenticationTimer);
        this.#retryTimer = null;
        this.#authenticationTimer = null;
    }

}
