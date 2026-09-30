"use strict";


import {Constants} from "../core/Constants.js";
import {ValidationUtils} from "../core/ValidationUtils.js";
import {Host} from "../host/Host.js";

/** Browser client view with local or hosted connection and navigation state. */
export class View {
    /** @type {"direct"|"hosted"} Active transport mode. */
    mode = ViewState.getMode();

    /** @type {URL} Destination used when leaving this view. */
    url;

    /** @param {URL} url - Destination used when navigating away from the view. */
    constructor(url) {
        this.url = url;
    }

    /**
     * @type {string} Card ordering requested for room snapshots.
     */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /** @type {string|null} Hosted WebSocket URL used for reconnects. */
    #webSocketUrl = null;

    /** @type {WebSocket|null} Active or connecting hosted socket. */
    #socket = null;

    /** @type {number|null} Pending reconnect timer. */
    #reconnectTimer = null;

    /** @type {number} Consecutive hosted reconnect attempts. */
    #reconnectAttempts = 0;

    /** @type {import("../host/Host.js").Host|null} Browser-owned Host to stop on disconnect. */
    #localHost = null;

    /** @type {import("../host/HostConnection.js").HostConnection|null} Local Host-side connection. */
    #hostConnection = null;

    /** @type {boolean} Whether this client is open. */
    #isOpen = false;

    /** @type {number} Invalidates queued work from an earlier local connection. */
    #generation = 0;

    /**
     * @type {import("./controllers/ViewController.js").ViewController|null} Active page controller.
     */
    #activeController = null;

    /**
     * @type {(function(string, string): void)|null} Optional connection-status observer.
     */
    #onStatus = null;

    /**
     * @type {(function(string|null, Object): void)|null} Optional view-data observer.
     */
    #onData = null;

    /**
     * @type {string} Tab-stable identifier included with every request.
     */
    #tabId = View.#getTabId();

    /**
     * @returns {string} Current card sort key.
     */
    get sortKey() {
        return this.#sortKey;
    }

    /**
     * @param {string} value - Card sort key.
     */
    set sortKey(value) {
        const sortKey = ValidationUtils.requiredString(value, "Sort key");
        if (!Constants.CARD.SORT_OPTIONS.includes(sortKey)) {
            throw new Error(`Invalid card sort key: ${sortKey}`);
        }
        this.#sortKey = sortKey;
    }

    /**
     * Connects to a browser-owned Host or hosted WebSocket URL, closing the prior route.
     *
     * @param {import("../host/Host.js").Host|string} target - Local Host or hosted URL.
     * @param {import("./controllers/ViewController.js").ViewController} controller - Active page controller.
     * @param {(function(string, string): void)|null} [onStatus=null] - Connection status observer.
     * @param {(function(string|null, Object): void)|null} [onData=null] - View data observer.
     */
    connect(target, controller, onStatus = null, onData = null) {
        const hostedUrl = typeof target === "string"
            ? ValidationUtils.requiredString(target, "WebSocket URL")
            : null;
        if (hostedUrl === null && typeof target?.accept !== "function") {
            throw new Error("View requires a local Host or hosted WebSocket URL.");
        }

        this.disconnect();

        this.#activeController = controller;
        this.#onStatus = onStatus;
        this.#onData = onData;
        this.#isOpen = true;
        const generation = ++this.#generation;

        if (hostedUrl === null) {
            this.#localHost = target;
            this.#handleStatus("connecting", "Starting direct room…");
            this.#hostConnection = target.accept(
                this.#receiveLocal.bind(this, generation), this.#disconnectLocal.bind(this, generation)
            );
            queueMicrotask(this.#notifyLocalOpen.bind(this, generation));
        } else {
            this.#webSocketUrl = hostedUrl;
            this.#openWebSocket(generation);
        }
    }

    /** Closes the active local or hosted route. */
    disconnect() {
        if (!this.#isOpen) return;
        this.#isOpen = false;
        this.#generation += 1;

        if (this.#webSocketUrl !== null) {
            this.#webSocketUrl = null;
            this.#cancelReconnect();
            this.#reconnectAttempts = 0;
            const socket = this.#socket;
            this.#socket = null;
            socket?.close();
            this.#handleStatus("disconnected", "Closed");
            this.#handleClose();
            return;
        }

        const hostConnection = this.#hostConnection;
        this.#hostConnection = null;
        const localHost = this.#localHost;
        this.#localHost = null;
        void hostConnection?.close();
        void localHost?.shutdown?.();
        this.#handleStatus("disconnected", "Closed");
        this.#handleClose();
    }

    /**
     * Sends one canonical Room command request.
     *
     * @param {string} command - Command name from Constants.COMMANDS.
     * @param {Object} data - Command-specific data.
     * @returns {boolean} Whether the request was accepted.
     */
    request(command, data) {
        const normalizedCommand = ValidationUtils.requiredString(command, "Command");
        const commandData = ValidationUtils.object(data, "Command data");

        const request = {
            command: normalizedCommand,
            data: { ...commandData, sortKey: this.#sortKey, tabId: this.#tabId }
        };

        if (this.#hostConnection !== null) {
            if (!this.#isOpen) return false;
            queueMicrotask(this.#deliverLocalRequest.bind(this, this.#generation, structuredClone(request)));
            return true;
        }

        const canSend = this.#isOpen && this.#socket instanceof WebSocket &&
            this.#socket.readyState === WebSocket.OPEN;
        if (canSend) this.#socket.send(JSON.stringify(request));
        return canSend;
    }

    /** @param {number} generation - Connection generation. */
    #openWebSocket(generation) {
        const isReconnecting = this.#reconnectAttempts > 0;
        this.#handleStatus(isReconnecting ? "reconnecting" : "connecting",
            isReconnecting ? "Reconnecting…" : "Connecting…");
        const socket = new WebSocket(this.#webSocketUrl);
        this.#socket = socket;
        socket.addEventListener("open", this.#handleSocketOpen.bind(this, generation, socket));
        socket.addEventListener("message", this.#handleSocketMessage.bind(this, generation, socket));
        socket.addEventListener("close", this.#handleSocketClose.bind(this, generation, socket));
        socket.addEventListener("error", this.#handleSocketError.bind(this, generation, socket));
    }

    /**
     * @param {number} generation - Connection generation.
     * @param {WebSocket} socket - Socket that opened.
     */
    #handleSocketOpen(generation, socket) {
        if (generation !== this.#generation || socket !== this.#socket || !this.#isOpen) return;
        this.#cancelReconnect();
        this.#reconnectAttempts = 0;
        this.#handleStatus("connected", "Hosted");
        this.#handleOpen();
    }

    /**
     * @param {number} generation - Connection generation.
     * @param {WebSocket} socket - Socket that received data.
     * @param {MessageEvent} event - Inbound message.
     */
    #handleSocketMessage(generation, socket, event) {
        if (generation === this.#generation && socket === this.#socket && this.#isOpen) this.#receive(event.data);
    }

    /**
     * @param {number} generation - Connection generation.
     * @param {WebSocket} socket - Socket that closed.
     */
    #handleSocketClose(generation, socket) {
        if (generation !== this.#generation || socket !== this.#socket || !this.#isOpen) return;
        this.#socket = null;
        this.#handleStatus("disconnected", "Disconnected");
        this.#handleClose();
        this.#scheduleReconnect(generation);
    }

    /**
     * @param {number} generation - Connection generation.
     * @param {WebSocket} socket - Socket that failed.
     */
    #handleSocketError(generation, socket) {
        if (generation === this.#generation && socket === this.#socket && this.#isOpen) {
            this.#handleStatus("error", "Connection error");
            socket.close();
        }
    }

    /** @param {number} generation - Connection generation. */
    #scheduleReconnect(generation) {
        if (!this.#isOpen || this.#reconnectAttempts >= 5 || this.#reconnectTimer !== null) return;
        const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
        this.#reconnectAttempts += 1;
        this.#handleStatus("reconnecting", "Reconnecting…");
        this.#reconnectTimer = globalThis.setTimeout(this.#reconnect.bind(this, generation), delay);
    }

    /** @param {number} generation - Connection generation. */
    #reconnect(generation) {
        this.#reconnectTimer = null;
        if (this.#isOpen && generation === this.#generation) this.#openWebSocket(generation);
    }

    /** Cancels a pending hosted reconnect. */
    #cancelReconnect() {
        if (this.#reconnectTimer !== null) {
            globalThis.clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    /**
     * @param {number} generation - Local connection generation.
     * @param {Object} request - Cloned local request.
     */
    #deliverLocalRequest(generation, request) {
        if (this.#isOpen && generation === this.#generation) void this.#hostConnection?.receive(request);
    }

    /** @param {number} generation - Local connection generation. */
    #disconnectLocal(generation) {
        if (generation === this.#generation) this.disconnect();
    }

    /**
     * @param {number} generation - Local connection generation.
     * @param {Object} response - Local Host response.
     */
    #receiveLocal(generation, response) {
        if (this.#isOpen && generation === this.#generation) {
            queueMicrotask(this.#deliverLocalResponse.bind(this, generation, structuredClone(response)));
        }
    }

    /**
     * @param {number} generation - Local connection generation.
     * @param {Object} response - Cloned local Host response.
     */
    #deliverLocalResponse(generation, response) {
        if (this.#isOpen && generation === this.#generation) this.#receive(response);
    }

    /** @param {number} generation - Local connection generation. */
    #notifyLocalOpen(generation) {
        if (this.#isOpen && generation === this.#generation) {
            this.#handleStatus("connected", "Direct");
            this.#handleOpen();
        }
    }

    /**
     * @param {string} status - Connection status.
     * @param {string} label - Display label.
     */
    #handleStatus(status, label) {
        this.#activeController?.handleConnectionStatus?.(status, label);
        this.#onStatus?.(status, label);
    }

    /** Notifies the page controller that the connection can accept requests. */
    #handleOpen() {
        this.#activeController?.handleClientOpen?.();
    }

    /** Notifies the page controller that the connection closed. */
    #handleClose() {
        this.#activeController?.handleClientClose?.();
    }

    /**
     * @param {Object|string} raw - Raw connection response.
     */
    #receive(raw) {
        const response = View.#parseResponse(raw);

        if (response === null) {
            console.warn("Invalid server response:", raw);
            return;
        }

        if (response.data !== null) {
            this.#activeController?.handleData?.(response.view, response.data, response.message);
            this.#onData?.(response.view, response.data);
        }

        if (response.message !== null && response.view !== Constants.VIEWS.HOME) {
            this.#activeController?.handleNotification?.(response.message);
        }
    }

    /**
     * @param {Object|string} raw - Raw connection response.
     * @returns {{view:string|null,message:Object|null,data:Object|null}|null} Canonical response, or null.
     */
    static #parseResponse(raw) {
        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

            if (typeof parsed !== "object" || parsed === null) {
                return null;
            }

            return {
                view:
                    typeof parsed[Constants.RESPONSE_KEYS.VIEW] === "string"
                        ? parsed[Constants.RESPONSE_KEYS.VIEW]
                        : null,
                message:
                    typeof parsed[Constants.RESPONSE_KEYS.MESSAGE] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.MESSAGE] !== null
                        ? parsed[Constants.RESPONSE_KEYS.MESSAGE]
                        : null,
                data:
                    typeof parsed[Constants.RESPONSE_KEYS.DATA] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.DATA] !== null
                        ? parsed[Constants.RESPONSE_KEYS.DATA]
                        : null
            };
        } catch (_error) {
            return null;
        }
    }

    /**
     * @returns {string} Existing tab identifier, or a newly generated and persisted identifier.
     */
    static #getTabId() {
        const storage = globalThis.sessionStorage;
        let tabId = storage?.getItem("game.tabId") ?? "";

        if (!tabId) {
            tabId =
                globalThis.crypto?.randomUUID?.() ??
                `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            storage?.setItem("game.tabId", tabId);
        }

        return tabId;
    }
}


/** Persists transport, navigation, and notification state for one browser tab. */
export class ViewState {
    /**
     * @returns {string} Browser-tab storage key for the selected connection mode.
     */
    static get #MODE_KEY() {
        return `${this.#namespace()}.mode`;
    }

    /**
     * @returns {string} Browser-tab storage key for pending Room navigation intent.
     */
    static get #INTENT_KEY() {
        return `${this.#namespace()}.gameIntent`;
    }

    /**
     * @returns {string} Browser-tab storage key for a notification carried across navigation.
     */
    static get #NOTICE_KEY() {
        return `${this.#namespace()}.notice`;
    }

    /**
     * @returns {string} Browser-tab storage key for the verified Hosted WebSocket URL.
     */
    static get #HOSTED_URL_KEY() {
        return `${this.#namespace()}.hostedUrl`;
    }

    /**
     * @returns {string} Storage namespace selected by the document's game identifier.
     */
    static #namespace() {
        return globalThis.document?.body?.dataset.game ?? "game";
    }

    /**
     * @returns {"direct"|"hosted"} Selected mode, defaulting to Direct.
     */
    static getMode() {
        return this.getModePreference() ?? "direct";
    }

    /**
     * @returns {"direct"|"hosted"|null} URL-selected or stored mode, if valid.
     */
    static getModePreference() {
        const queryMode = new URLSearchParams(globalThis.location?.search ?? "").get("mode");
        const savedMode = globalThis.sessionStorage?.getItem(this.#MODE_KEY);
        const requestedMode = queryMode ?? savedMode;

        return requestedMode === "hosted" || requestedMode === "direct" ? requestedMode : null;
    }

    /**
     * @param {"direct"|"hosted"} mode - Transport mode to persist.
     */
    static setMode(mode) {
        globalThis.sessionStorage?.setItem(this.#MODE_KEY, mode === "hosted" ? "hosted" : "direct");
    }

    /**
     * @param {{mode:"direct"|"hosted", command:string, data:Record<string, *>}} intent - Room command and navigation data to persist.
     */
    static setIntent(intent) {
        globalThis.sessionStorage?.setItem(this.#INTENT_KEY, JSON.stringify(intent));
    }

    /**
     * @returns {{mode:"direct"|"hosted", command:string, data:Record<string, *>}|null} Parsed Room intent, or null when absent or malformed.
     */
    static getIntent() {
        try {
            const value = JSON.parse(globalThis.sessionStorage?.getItem(this.#INTENT_KEY) ?? "null");
            return typeof value === "object" && value !== null ? value : null;
        } catch (_error) {
            return null;
        }
    }

    /** Clears the saved Room intent. */
    static clearIntent() {
        globalThis.sessionStorage?.removeItem(this.#INTENT_KEY);
    }

    /**
     * @param {Record<string, *>} notice - Notification to show after navigation.
     */
    static setNotice(notice) {
        if (typeof notice === "object" && notice !== null) {
            globalThis.sessionStorage?.setItem(this.#NOTICE_KEY, JSON.stringify(notice));
        }
    }

    /**
     * @returns {Record<string, *>|null} Pending notification, removed from storage before parsing.
     */
    static takeNotice() {
        const storage = globalThis.sessionStorage;
        const serialized = storage?.getItem(this.#NOTICE_KEY) ?? "null";
        storage?.removeItem(this.#NOTICE_KEY);

        try {
            const notice = JSON.parse(serialized);
            return typeof notice === "object" && notice !== null ? notice : null;
        } catch (_error) {
            return null;
        }
    }

    /**
     * @param {string} url - Verified Hosted WebSocket URL to persist.
     */
    static setHostedUrl(url) {
        globalThis.sessionStorage?.setItem(this.#HOSTED_URL_KEY, url);
    }

    /** Clears the last verified Hosted-mode URL. */
    static clearHostedUrl() {
        globalThis.sessionStorage?.removeItem(this.#HOSTED_URL_KEY);
    }

    /**
     * @returns {string|null} Trimmed configured server origin, when supplied.
     */
    static getConfiguredServerOrigin() {
        const origin = globalThis.document
            ?.querySelector('meta[name="game-server-origin"]')
            ?.getAttribute("content")
            ?.trim();

        return origin || null;
    }

    /**
     * Resolves a server origin as a Hosted-mode WebSocket URL.
     *
     * @param {string|null} origin - Server origin to resolve.
     * @returns {string} WebSocket URL.
     * @throws {Error} When the origin is absent or uses an unsupported protocol.
     */
    static resolveHostedUrl(origin) {
        if (origin === null) {
            throw new Error("Server origin is not configured.");
        }

        const url = new URL(origin, globalThis.location?.href);
        const protocols = {
            "http:": "ws:",
            "https:": "wss:",
            "ws:": "ws:",
            "wss:": "wss:"
        };
        const protocol = protocols[url.protocol];

        if (protocol === undefined) {
            throw new Error(`Unsupported server protocol: ${url.protocol}`);
        }
        if (url.username || url.password) {
            throw new Error("Host addresses cannot include credentials.");
        }

        url.protocol = protocol;
        url.pathname = "/";
        url.search = "";
        url.hash = "";

        return url.href;
    }

    /**
     * @returns {string|null} WebSocket URL for the host serving this page.
     */
    static getCurrentHostUrl() {
        const origin = globalThis.location?.origin;

        if (!origin || origin === "null") {
            return null;
        }

        return this.resolveHostedUrl(origin);
    }

    /**
     * @returns {string} Last verified, configured, or current-host WebSocket URL.
     * @throws {Error} When no Hosted endpoint can be resolved.
     */
    static getHostedUrl() {
        const savedUrl = globalThis.sessionStorage?.getItem(this.#HOSTED_URL_KEY)?.trim();

        if (savedUrl) {
            return savedUrl;
        }

        const configuredOrigin = this.getConfiguredServerOrigin();

        if (configuredOrigin !== null) {
            return this.resolveHostedUrl(configuredOrigin);
        }

        const currentHostUrl = this.getCurrentHostUrl();

        if (currentHostUrl === null) {
            throw new Error("Hosted endpoint is not available.");
        }

        return currentHostUrl;
    }

    /** @returns {string|null} Hosted URL previously verified on the Connection page. */
    static getVerifiedHostedUrl() {
        return globalThis.sessionStorage?.getItem(this.#HOSTED_URL_KEY)?.trim() || null;
    }
}


/** One bounded browser WebSocket availability probe. */
class WebSocketProbe {
    /** @type {string} Endpoint under test. */
    #endpoint;
    /** @type {WebSocket|null} Temporary socket. */
    #socket = null;
    /** @type {number|null} Probe timeout. */
    #timer = null;
    /** @type {function(Object): void|null} Promise resolver. */
    #resolve = null;
    /** @type {number} Probe start time. */
    #startedAt = 0;

    /** @param {string} endpoint - WebSocket endpoint under test. */
    constructor(endpoint) {
        this.#endpoint = endpoint;
    }

    /** @returns {Promise<{available:boolean, elapsedMs:number, failure:string}>} Probe outcome. */
    check() {
        this.#startedAt = Date.now();
        return new Promise(this.#start.bind(this));
    }

    /** @param {function(Object): void} resolve - Probe outcome resolver. */
    #start(resolve) {
        this.#resolve = resolve;
        this.#timer = globalThis.setTimeout(
            this.#finish.bind(this, false, `Timed out after ${Constants.CONNECTION_PROBE_TIMEOUT_MS} ms.`),
            Constants.CONNECTION_PROBE_TIMEOUT_MS
        );
        try {
            this.#socket = new WebSocket(this.#endpoint);
            this.#socket.addEventListener("open", this.#finish.bind(this, true, ""), {once: true});
            this.#socket.addEventListener("error", this.#finish.bind(this, false, "WebSocket handshake failed."), {once: true});
        } catch (error) {
            this.#finish(false, error instanceof Error ? error.message : String(error));
        }
    }

    /** Stops an obsolete or departing-page probe. */
    cancel() {
        this.#finish(false, "Canceled.");
    }

    /**
     * @param {boolean} available - Whether the endpoint opened.
     * @param {string} failure - Browser-visible failure detail.
     */
    #finish(available, failure) {
        if (this.#resolve === null) return;
        const resolve = this.#resolve;
        this.#resolve = null;
        if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
        this.#timer = null;
        this.#socket?.close();
        this.#socket = null;
        resolve({available, elapsedMs: Date.now() - this.#startedAt, failure});
    }
}

/** Coordinates the standalone Hosted Connection page. */
export class ConnectionView extends View {
    /** @type {import("./controllers/ConnectionController.js").ConnectionController|null} Page controller. */
    #controller = null;
    /** @type {WebSocketProbe|null} Active availability probe. */
    #probe = null;
    /** @type {number} Invalidates older probe sequences. */
    #generation = 0;
    /** @type {number} Total endpoint probes on this page. */
    #probeCount = 0;

    /** Initializes page controls and probes configured hosts. */
    async start() {
        const {ConnectionController} = await import("./controllers/ConnectionController.js");
        this.#controller = new ConnectionController();
        this.#controller.initialize(this.#submit.bind(this));
        this.#controller.renderYear();
        window.addEventListener("pagehide", this.#cancel.bind(this), {once: true});

        const isAutomatic = new URLSearchParams(location.search).get("auto") === "1";
        const available = await this.#probeHosts(null);
        if (isAutomatic && available === false) {
            ViewState.setMode("direct");
            location.replace(this.#homeUrl("direct"));
        }
    }

    /** @param {string} origin - User-entered host address. */
    #submit(origin) {
        if (origin === "") {
            void this.#probeHosts(null);
            return;
        }
        try {
            void this.#probeHosts(ViewState.resolveHostedUrl(origin));
        } catch (error) {
            this.#cancel();
            this.#controller.render(Constants.CONNECTION_STATUS.ERROR, {
                endpoint: origin, failure: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /** Invalidates the current probe without navigating. */
    #cancel() {
        this.#generation += 1;
        this.#probe?.cancel();
        this.#probe = null;
    }

    /**
     * @param {string|null} preferredUrl - Explicit endpoint or configured/same-origin candidates.
     * @returns {Promise<boolean|null>} Availability, or null when superseded.
     */
    async #probeHosts(preferredUrl) {
        this.#cancel();
        const generation = this.#generation;
        let configurationError = "";
        let configuredUrl = null;
        const configuredOrigin = ViewState.getConfiguredServerOrigin();
        if (configuredOrigin !== null) {
            try {
                configuredUrl = ViewState.resolveHostedUrl(configuredOrigin);
            } catch (error) {
                configurationError = error instanceof Error ? error.message : String(error);
            }
        }
        let currentHostUrl = null;
        try {
            currentHostUrl = ViewState.getCurrentHostUrl();
        } catch (_error) {
        }

        const candidates = preferredUrl === null
            ? [...new Set([configuredUrl, currentHostUrl].filter(Boolean))]
            : [preferredUrl];
        if (candidates.length === 0) {
            this.#controller.render(Constants.CONNECTION_STATUS.UNCONFIGURED, {failure: configurationError});
            return false;
        }

        for (const [index, endpoint] of candidates.entries()) {
            const attempt = ++this.#probeCount;
            const metrics = {endpoint, attempt, candidate: index + 1, candidateCount: candidates.length};
            this.#controller.render(Constants.CONNECTION_STATUS.CONNECTING, metrics);
            this.#probe = new WebSocketProbe(endpoint);
            const outcome = await this.#probe.check();
            if (generation !== this.#generation) return null;
            this.#probe = null;

            if (outcome.available) {
                this.#controller.render(Constants.CONNECTION_STATUS.CONNECTED, {...metrics, elapsedMs: outcome.elapsedMs});
                ViewState.setHostedUrl(endpoint);
                ViewState.setMode("hosted");
                location.replace(this.#homeUrl("hosted"));
                return true;
            }
            this.#controller.render(Constants.CONNECTION_STATUS.ERROR, {...metrics, ...outcome});
        }
        return false;
    }

    /**
     * @param {"direct"|"hosted"} mode - Home mode.
     * @returns {string} Home URL.
     */
    #homeUrl(mode) {
        const url = new URL(this.url);
        url.searchParams.set("mode", mode);
        return url.href;
    }
}
/** Coordinates Home controllers, transport selection, and Room navigation. */
export class HomeView extends View {

    /**
     * @type {import("./controllers/HomeController.js").HomeController|null} Home interaction controller after startup.
     */
    #controller = null;

    /**
     * @type {"direct"|"hosted"|null} Persisted or URL-selected startup mode.
     */
    #preferredMode = ViewState.getModePreference();

    /**
     * @type {Record<string, *>|null} One-time notification restored after navigation.
     */
    #notice = ViewState.takeNotice();

    /**
     * @param {URL} url - Room destination used after a create, join, or view command.
     */
    constructor(url) {
        super(url);
    }

    /**
     * Loads and initializes Home controllers, then establishes the preferred transport.
     *
     * @returns {Promise<void>}
     */
    async start() {
        const {HomeController} = await import("./controllers/HomeController.js");

        this.#controller = new HomeController();
        await this.#controller.initialize();
        this.#controller.renderYear();
        this.#controller.setModeHandler(this.#handleMode.bind(this));
        this.#controller.setRoomHandler(this.#enterRoom.bind(this));

        if (this.#notice !== null) this.#controller.handleNotification(this.#notice);

        if (this.#preferredMode !== "hosted") {
            this.#connect("direct");
        } else if (this.#preferredMode === "hosted" && ViewState.getVerifiedHostedUrl() !== null) {
            this.#connect("hosted");
        } else {
            this.#openConnectionPage(false);
        }
    }

    /**
     * @param {"direct"|"hosted"} mode - Mode to write to the current URL without navigation.
     */
    #updateModeUrl(mode) {
        const url = new URL(location.href);
        url.searchParams.set("mode", mode);
        history.replaceState(null, "", url);
    }

    /**
     * Connects this view to the selected Host and binds Home observers.
     *
     * @param {"direct"|"hosted"} requestedMode - Transport mode to open.
     */
    #connect(requestedMode) {
        this.mode = requestedMode === "hosted" ? "hosted" : "direct";
        ViewState.setMode(this.mode);
        this.#controller.selectMode(this.mode);

        this.#controller.setView(this);
        const target = this.mode === "hosted"
            ? ViewState.getVerifiedHostedUrl()
            : new Host("direct", "fill", false);
        this.connect(target, this.#controller);
        this.#updateModeUrl(this.mode);
    }

    /**
     * Opens the standalone page that verifies a Hosted connection.
     * @param {boolean} isAutomatic - Whether to fall back to Direct if probing fails.
     */
    #openConnectionPage(isAutomatic) {
        this.disconnect();
        const url = new URL("./connection.html", location.href);
        if (isAutomatic) url.searchParams.set("auto", "1");
        location.assign(url.href);
    }

    /**
     * @param {"direct"|"hosted"} mode - User-selected transport mode.
     */
    #handleMode(mode) {
        if (mode === "hosted") {
            this.#openConnectionPage(false);
        } else {
            ViewState.clearHostedUrl();
            this.#connect("direct");
        }
    }

    /**
     * Persists Room intent and navigates to the Room view.
     *
     * @param {string} command - Create, join, or view command.
     * @param {{roomName:string}} data - Command data containing the target Room name.
     */
    #enterRoom(command, data) {
        ViewState.setMode(this.mode);
        ViewState.setIntent({mode: this.mode, command, data});
        const roomUrl = new URL(this.url);
        roomUrl.searchParams.set("mode", this.mode);
        roomUrl.searchParams.set("room", data.roomName);
        location.assign(roomUrl.href);
    }
}


/** Coordinates Room admission, controllers, transport, and Home navigation. */
export class RoomView extends View {

    /**
     * @type {import("./controllers/RoomController.js").RoomController|null} Room interaction controller after startup.
     */
    #controller = null;

    /**
     * @type {import("./controllers/FaqController.js").FaqController|null} FAQ controller after startup.
     */
    #faqController = null;

    /**
     * @type {{mode:"direct"|"hosted", command:string, data:Record<string, *>}|null} Create, join, or view intent carried from Home.
     */
    #intent = ViewState.getIntent();

    /**
     * @type {boolean} Whether mode and intent are enough to enter Room.
     */
    #isValid = true;

    /**
     * Restores and validates Room navigation state before opening a connection.
     *
     * @param {URL} url - Home destination used when leaving the Room.
     */
    constructor(url) {
        super(url);
        const roomName = new URLSearchParams(location.search).get("room")?.trim() ?? "";

        if (this.#intent === null && roomName) {
            this.#intent = {mode: this.mode, command: Constants.COMMANDS.VIEW, data: {roomName}};
        }

        if (this.#intent === null || this.#intent.mode !== this.mode) this.#isValid = false;
    }

    /**
     * Redirects invalid entry or initializes the Room controllers and client.
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (!this.#isValid) {
            location.replace(this.#homeUrl());
            return;
        }

        const {RoomController} = await import("./controllers/RoomController.js");
        const {FaqController} = await import("./controllers/FaqController.js");

        this.#controller = new RoomController();
        await this.#controller.initialize();
        const target = this.mode === "hosted"
            ? ViewState.getHostedUrl()
            : new Host("direct", "fill", false);
        this.connect(target, this.#controller);
        this.#controller.renderYear();
        this.#controller.setView(this);
        this.#controller.setIntent(this.#intent);
        this.#controller.setReadyHandler(this.#handleReady.bind(this));
        this.#controller.setHomeHandler(this.#returnHome.bind(this));

        this.#faqController = new FaqController();
        this.#faqController?.initialize();

        window.addEventListener("pagehide", this.disconnect.bind(this), {once: true});
    }

    /**
     * @returns {string} Home URL carrying the active transport mode.
     */
    #homeUrl() {
        const homeUrl = new URL(this.url);
        homeUrl.searchParams.set("mode", this.mode);
        return homeUrl.href;
    }

    /**
     * Converts successful creation intent into a stable joined-Room intent.
     *
     * @param {{name:string}} room - Created Room snapshot.
     */
    #handleReady(room) {
        if (this.#intent.command !== Constants.COMMANDS.CREATE) return;
        this.#intent = {
            ...this.#intent,
            command: Constants.COMMANDS.JOIN,
            data: {roomName: room.name, actorName: this.#intent.data.actorName}
        };
        ViewState.setIntent(this.#intent);
        this.#controller.setIntent(this.#intent);
    }

    /**
     * Persists an admission failure when present, disconnects, and returns Home.
     *
     * @param {Record<string, *>|null} notice - Failure notice, or null for a normal exit.
     */
    #returnHome(notice) {
        const isFailedAdmission = notice !== null;
        if (isFailedAdmission) ViewState.setNotice(notice);
        ViewState.clearIntent();
        this.disconnect();

        if (isFailedAdmission) location.replace(this.#homeUrl());
        else location.assign(this.#homeUrl());
    }

}
