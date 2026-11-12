"use strict";


import { SessionState } from "./SessionState.js";
import {Constants} from "../shared/Constants.js";
import {ValidationUtils} from "../shared/ValidationUtils.js";
import {Host} from "../host/Host.js";
import { HostedClient } from "./HostedClient.js";

/** Browser client session with local or hosted connection and navigation state. */
export class Session {

    /** @type {"direct"|"hosted"} Active transport mode. */
    mode = SessionState.getMode();

    /** @type {URL} Destination used when leaving this session. */
    url;

    /**
     * @type {string} Card ordering requested for room snapshots.
     */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /** @type {HostedClient|null} Hosted WebSocket admission and command transport. */
    #hostedClient = null;

    /** @type {import("../host/Host.js").Host|null} Browser-owned Host to stop on disconnect. */
    #localHost = null;

    /** @type {import("../host/HostConnection.js").HostConnection|null} Local Host-side connection. */
    #localConnection = null;

    /** @type {boolean} Whether the page session owns an active transport lifetime. */
    #isActive = false;

    /** @type {number} Invalidates queued work from an earlier local connection. */
    #generation = 0;

    /**
     * @type {import("./controllers/ViewController.js").ViewController|null} Active page controller.
     */
    #activeController = null;

    /**
     * @type {string|null} Tab-stable identity for in-browser Host commands only.
     */
    #localTabId = null;

    // ---- Construction and public transport API ----

    /** @param {URL} url - Destination used when navigating away from the session. */
    constructor(url) {
        this.url = url;
    }

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
     * Connects to a browser-owned Host or hosted Hosted origin, closing the prior route.
     *
     * @param {import("../host/Host.js").Host|string} target - Local Host or hosted URL.
     * @param {import("./controllers/ViewController.js").ViewController} controller - Active page controller.
     */
    connect(target, controller) {
        const apiOrigin = typeof target === "string"
            ? ValidationUtils.requiredString(target, "Hosted origin")
            : null;
        if (apiOrigin === null && typeof target?.accept !== "function") {
            throw new Error("Session requires a local Host or hosted Hosted origin.");
        }

        const hostedClient = apiOrigin === null ? null : new HostedClient(apiOrigin, {
            status: this.#handleStatus.bind(this), open: controller?.handleClientOpen?.bind(controller),
            close: controller?.handleClientClose?.bind(controller), response: this.#receive.bind(this),
            exhausted: this.#handleHostedExhausted.bind(this)
        });
        this.disconnect();

        this.#activeController = controller;
        this.#isActive = true;
        const generation = ++this.#generation;

        if (apiOrigin === null) {
            this.#localTabId ??= Session.#getTabId();
            this.#localHost = target;
            this.#handleStatus("connecting", "Starting direct room…");
            this.#localConnection = target.accept(
                this.#receiveLocal.bind(this, generation), this.#disconnectLocal.bind(this, generation)
            );
            queueMicrotask(this.#notifyLocalOpen.bind(this, generation));
        } else {
            this.#hostedClient = hostedClient;
            this.#hostedClient.start();
        }
    }

    /** Closes the active local or hosted route. */
    disconnect() {
        if (!this.#isActive) return;
        this.#isActive = false;
        this.#generation += 1;

        if (this.#hostedClient !== null) {
            this.#hostedClient.stop();
            this.#hostedClient = null;
        }

        const localConnection = this.#localConnection;
        this.#localConnection = null;
        const localHost = this.#localHost;
        this.#localHost = null;
        void localConnection?.close();
        void localHost?.shutdown?.();
        this.#handleStatus("disconnected", "Closed");
        this.#activeController?.handleClientClose?.();
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
        const commandData = { ...ValidationUtils.object(data, "Command data"), sortKey: this.#sortKey };

        if (this.#localConnection !== null) {
            if (!this.#isActive) return false;
            const request = {
                command: normalizedCommand,
                data: { ...commandData, tabId: this.#localTabId }
            };
            queueMicrotask(this.#deliverLocalRequest.bind(this, this.#generation, structuredClone(request)));
            return true;
        }

        return this.#isActive && this.#hostedClient !== null && this.#hostedClient.request(normalizedCommand, commandData);
    }

    /** Opens manual connection recovery after the live connection retry budget is exhausted. */
    #handleHostedExhausted() {
        this.disconnect();
        SessionState.clearIntent();
        const url = new URL("./connection.html", location.href);
        url.searchParams.set("failed", "1");
        location.replace(url.href);
    }

    // ---- Local transport lifecycle ----

    /**
     * @param {number} generation - Local connection generation.
     * @param {Object} request - Cloned local request.
     */
    #deliverLocalRequest(generation, request) {
        if (this.#isActive && generation === this.#generation) void this.#localConnection?.receive(request);
    }

    /**
     * @param {number} generation - Local connection generation.
     * @param {Object} response - Local Host response.
     */
    #receiveLocal(generation, response) {
        if (this.#isActive && generation === this.#generation) {
            queueMicrotask(this.#deliverLocalResponse.bind(this, generation, structuredClone(response)));
        }
    }

    /**
     * @param {number} generation - Local connection generation.
     * @param {Object} response - Cloned local Host response.
     */
    #deliverLocalResponse(generation, response) {
        if (this.#isActive && generation === this.#generation) this.#receive(response);
    }

    /** @param {number} generation - Local connection generation. */
    #notifyLocalOpen(generation) {
        if (this.#isActive && generation === this.#generation) {
            this.#handleStatus("connected", "Local");
            this.#activeController?.handleClientOpen?.();
        }
    }

    /** @param {number} generation - Local connection generation. */
    #disconnectLocal(generation) {
        if (generation === this.#generation) this.disconnect();
    }

    // ---- Controller delivery and response parsing ----

    /**
     * @param {string} status - Connection status.
     * @param {string} label - Display label.
     */
    #handleStatus(status, label) {
        this.#activeController?.handleConnectionStatus?.(status, label);
    }

    /**
     * @param {Object|string} raw - Raw connection response.
     */
    #receive(raw) {
        const response = Session.#parseResponse(raw);

        if (response === null) {
            console.warn("Invalid server response:", raw);
            return;
        }

        if (response.data !== null) {
            this.#activeController?.handleData?.(response.view, response.data, response.message);
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


/** Coordinates the standalone Hosted Connection page. */
export class ConnectionSession extends Session {
    /** @type {import("./controllers/ConnectionController.js").ConnectionController|null} Page controller. */
    #controller = null;

    /** @type {HostedClient|null} One session-handshake attempt owned by this page. */
    #client = null;

    /** @type {number} Invalidates older connection attempts. */
    #generation = 0;

    /** @type {number} Total socket attempts on this page. */
    #attemptCount = 0;

    /** Initializes recovery controls and connects to the configured host. */
    async start() {
        const {ConnectionController} = await import("./controllers/ConnectionController.js");
        this.#controller = new ConnectionController();
        this.#controller.initialize(this.#connectServer.bind(this), this.#selectMode.bind(this));
        this.#controller.renderYear();
        window.addEventListener("pagehide", this.#cancel.bind(this), {once: true});

        if (new URLSearchParams(location.search).get("failed") === "1") {
            let endpoint = "";
            try {
                endpoint = SessionState.getHostedUrl();
            } catch (_error) {
            }
            this.#controller.render(endpoint ? Constants.STATUS.ERROR : Constants.STATUS.UNCONFIGURED, {
                endpoint, failure: "Live reconnection attempts failed. Retry Live or play Local."
            });
            return;
        }
        this.#connectServer();
    }

    /** @param {string} mode - Local play or a Live retry selected by the toggle. */
    #selectMode(mode) {
        if (mode === "direct") {
            this.#cancel();
            SessionState.setMode("direct");
            location.replace(this.#homeUrl("direct"));
        } else {
            this.#connectServer();
        }
    }

    /** Stops the current socket attempt without navigating. */
    #cancel() {
        this.#generation += 1;
        this.#client?.stop();
        this.#client = null;
    }

    /** Connects to the configured endpoint and updates only the current page attempt. */
    #connectServer() {
        this.#cancel();
        const generation = this.#generation;
        let endpoint;
        try {
            endpoint = SessionState.getHostedUrl();
        } catch (error) {
            this.#controller.render(Constants.STATUS.UNCONFIGURED, { failure: error.message });
            return;
        }
        const metrics = { endpoint, attempt: ++this.#attemptCount, candidate: 1, candidateCount: 1 };
        this.#controller.render(Constants.STATUS.CONNECTING, metrics);
        const startedAt = Date.now();
        this.#client = new HostedClient(endpoint, {
            open: function connected() {
                if (generation === this.#generation) {
                    this.#cancel();
                    this.#controller.render(Constants.STATUS.CONNECTED, { ...metrics, elapsedMs: Date.now() - startedAt });
                    SessionState.setMode("hosted");
                    location.replace(this.#homeUrl("hosted"));
                }
            }.bind(this),
            exhausted: function unavailable() {
                if (generation === this.#generation) {
                    this.#client = null;
                    this.#controller.render(Constants.STATUS.ERROR, { ...metrics,
                        elapsedMs: Date.now() - startedAt, failure: "Live WebSocket connection failed." });
                }
            }.bind(this)
        }, false);
        this.#client.start();
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
export class HomeSession extends Session {
    /**
     * @type {import("./controllers/HomeController.js").HomeController|null} Home interaction controller after startup.
     */
    #controller = null;

    /**
     * @type {Record<string, *>|null} One-time notification restored after navigation.
     */
    #notice = SessionState.takeNotice();

    /**
     * Loads and initializes Home controllers, then establishes the preferred transport.
     *
     * @returns {Promise<void>}
     */
    async start() {
        window.addEventListener("pagehide", this.disconnect.bind(this), {once: true});
        const {HomeController} = await import("./controllers/HomeController.js");

        this.#controller = new HomeController();
        await this.#controller.initialize();
        this.#controller.renderYear();
        this.#controller.setModeHandler(this.#handleMode.bind(this));
        this.#controller.setRoomHandler(this.#enterRoom.bind(this));

        if (this.#notice !== null) this.#controller.handleNotification(this.#notice);

        this.#connect(SessionState.getMode());
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
        SessionState.setMode(this.mode);
        this.#controller.selectMode(this.mode);

        this.#controller.setSession(this);
        try {
            const target = this.mode === "hosted"
                ? SessionState.getHostedUrl()
                : new Host("direct", "fill", false);
            this.connect(target, this.#controller);
            this.#updateModeUrl(this.mode);
        } catch (error) {
            if (this.mode === "hosted") {
                this.disconnect();
                location.assign(new URL("./connection.html", location.href).href);
            } else throw error;
        }
    }

    /**
     * @param {"direct"|"hosted"} mode - User-selected transport mode.
     */
    #handleMode(mode) {
        this.#connect(mode);
    }

    /**
     * Persists Room intent and navigates to the Room session.
     *
     * @param {string} command - Create, join, or view command.
     * @param {{roomName:string}} data - Command data containing the target Room name.
     */
    #enterRoom(command, data) {
        SessionState.setMode(this.mode);
        SessionState.setIntent({mode: this.mode, command, data});
        const roomUrl = new URL(this.url);
        roomUrl.searchParams.set("mode", this.mode);
        roomUrl.searchParams.set("room", data.roomName);
        location.assign(roomUrl.href);
    }
}


/** Coordinates Room admission, controllers, transport, and Home navigation. */
export class RoomSession extends Session {
    /**
     * @type {import("./controllers/RoomController.js").RoomController|null} Room interaction controller after startup.
     */
    #controller = null;

    /**
     * @type {{mode:"direct"|"hosted", command:string, data:Record<string, *>}|null} Create, join, or view intent carried from Home.
     */
    #intent = SessionState.getIntent();

    /** @type {boolean} Whether room admission has previously been attempted. */
    #hasOpened = false;

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
            ? SessionState.getHostedUrl()
            : new Host("direct", "fill", false);
        this.connect(target, this.#controller);
        this.#controller.renderYear();
        this.#controller.setSession(this);
        this.#controller.setReadyHandler(this.#handleReady.bind(this));
        this.#controller.setHomeHandler(this.#returnHome.bind(this));

        new FaqController().initialize();

        window.addEventListener("pagehide", this.disconnect.bind(this), {once: true});
    }

    /**
     * Addresses every room operation using the session's authoritative navigation intent.
     * @param {string} command - Game command.
     * @param {Object} data - Action-specific fields.
     * @returns {boolean} Whether the transport accepted delivery.
     */
    request(command, data) {
        return super.request(command, { roomName: this.#intent?.data.roomName, ...data });
    }

    /** Submits session-owned admission intent, using Join after a Create reconnect. */
    openRoom() {
        if (this.#intent === null) {
            this.#returnHome(null);
            return;
        }
        const command = this.#hasOpened && this.#intent.command === Constants.COMMANDS.CREATE
            ? Constants.COMMANDS.JOIN : this.#intent.command;
        this.#hasOpened = true;
        this.request(command, this.#intent.data);
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
            data: {roomName: room.name, playerName: this.#intent.data.playerName}
        };
        SessionState.setIntent(this.#intent);
    }

    /**
     * Persists an admission failure when present, disconnects, and returns Home.
     *
     * @param {Record<string, *>|null} notice - Failure notice, or null for a normal exit.
     */
    #returnHome(notice) {
        const isFailedAdmission = notice !== null;
        if (isFailedAdmission) SessionState.setNotice(notice);
        SessionState.clearIntent();
        this.disconnect();

        if (isFailedAdmission) location.replace(this.#homeUrl());
        else location.assign(this.#homeUrl());
    }
}
