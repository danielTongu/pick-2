"use strict";


import {Constants} from "../core/Constants.js";
import {Game} from "../core/Game.js";
import {Client, ClientEvents} from "../runtime/Client.js";
import {Host} from "../runtime/Host.js";
import {Endpoint, WebSocketEndpoint} from "../runtime/Transport.js";
import {DomUtils} from "./utilities/DomUtils.js";

/** Provides shared controller, client, mode, and navigation state for an application view. */
export class View {

    /** @type {typeof Client|null} Active client owned by this view. */
    client = null;

    /** @type {"direct"|"hosted"} Active transport mode. */
    mode = ViewState.getMode();

    /** @type {typeof Game} Game constructor used by the in-browser runtime. */
    Game = Game;

    /** @type {URL} Destination used when leaving this view. */
    url;

    /**
     * Creates the shared state for an application view.
     *
     * @param {URL} url - Destination used when navigating away from the view.
     */
    constructor(url) {
        this.url = url;
    }

    /**
     * Creates a client over the endpoint selected by the transport mode.
     *
     * @param {"direct"|"hosted"} mode - Transport mode to use.
     * @returns {Client} Unopened client for the selected endpoint.
     */
    createClient(mode) {
        const endpoint = mode === "hosted"
            ? new WebSocketEndpoint(ViewState.getHostedUrl())
            : new Endpoint(new Host("direct", "fill", false, new this.Game()));

        return new Client(endpoint);
    }

    /**
     * Disconnects the current client and creates its replacement.
     *
     * @param {"direct"|"hosted"} mode - Transport mode for the replacement client.
     * @returns {Client} New unopened client.
     */
    replaceClient(mode) {
        this.disconnect();
        this.client = this.createClient(mode);
        return this.client;
    }

    /** Disconnects and releases the active client, when present. */
    disconnect() {
        this.client?.close();
        this.client = null;
    }

}


/** Persists transport, navigation, and notification state for one browser tab. */
export class ViewState {
    /** @returns {string} Session key for the selected transport mode. */
    static get #MODE_KEY() {
        return `${this.#namespace()}.mode`;
    }

    /** @returns {string} Session key for pending Room navigation intent. */
    static get #INTENT_KEY() {
        return `${this.#namespace()}.gameIntent`;
    }

    /** @returns {string} Session key for a notification carried across navigation. */
    static get #NOTICE_KEY() {
        return `${this.#namespace()}.notice`;
    }

    /** @returns {string} Session key for the verified Hosted WebSocket URL. */
    static get #HOSTED_URL_KEY() {
        return `${this.#namespace()}.hostedUrl`;
    }

    /** @returns {string} Storage namespace selected by the document's game identifier. */
    static #namespace() {
        return globalThis.document?.body?.dataset.game ?? "game";
    }

    /** @returns {"direct"|"hosted"} Selected mode, defaulting to Direct. */
    static getMode() {
        return this.getModePreference() ?? "direct";
    }

    /** @returns {"direct"|"hosted"|null} URL-selected or session-selected mode, if valid. */
    static getModePreference() {
        const queryMode = new URLSearchParams(globalThis.location?.search ?? "").get("mode");
        const savedMode = globalThis.sessionStorage?.getItem(this.#MODE_KEY);
        const requestedMode = queryMode ?? savedMode;

        return requestedMode === "hosted" || requestedMode === "direct" ? requestedMode : null;
    }

    /** @param {"direct"|"hosted"} mode - Transport mode to persist. */
    static setMode(mode) {
        globalThis.sessionStorage?.setItem(this.#MODE_KEY, mode === "hosted" ? "hosted" : "direct");
    }

    /** @param {{mode:"direct"|"hosted", command:string, data:Record<string, *>}} intent - Room command and navigation data to persist. */
    static setIntent(intent) {
        globalThis.sessionStorage?.setItem(this.#INTENT_KEY, JSON.stringify(intent));
    }

    /** @returns {{mode:"direct"|"hosted", command:string, data:Record<string, *>}|null} Parsed Room intent, or null when absent or malformed. */
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

    /** @param {Record<string, *>} notice - Notification to show after navigation. */
    static setNotice(notice) {
        if (typeof notice === "object" && notice !== null) {
            globalThis.sessionStorage?.setItem(this.#NOTICE_KEY, JSON.stringify(notice));
        }
    }

    /** @returns {Record<string, *>|null} Pending notification, removed from storage before parsing. */
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

    /** @param {string} url - Verified Hosted WebSocket URL to persist. */
    static setHostedUrl(url) {
        globalThis.sessionStorage?.setItem(this.#HOSTED_URL_KEY, url);
    }

    /** Clears the last verified Hosted-mode URL. */
    static clearHostedUrl() {
        globalThis.sessionStorage?.removeItem(this.#HOSTED_URL_KEY);
    }

    /** @returns {string|null} Trimmed configured server origin, when supplied. */
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

        url.protocol = protocol;
        url.pathname = "/";
        url.search = "";
        url.hash = "";

        return url.href;
    }

    /** @returns {string|null} WebSocket URL for the host serving this page. */
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
            throw new Error("Network host is not available.");
        }

        return currentHostUrl;
    }
}


/** Coordinates Home controllers, transport selection, and Room navigation. */
export class HomeView extends View {

    /** @type {import("./controllers/HomeController.js").HomeController|null} Home interaction controller after startup. */
    #controller = null;

    /** @type {HTMLElement} Root Home view hidden during hosted connection setup. */
    #homeView = DomUtils.require("#home-view", HTMLElement);

    /** @type {import("./controllers/NetworkConnectionController.js").NetworkConnectionController|null} Hosted endpoint discovery UI. */
    #networkController = null;

    /** @type {"direct"|"hosted"|null} Persisted or URL-selected startup mode. */
    #preferredMode = ViewState.getModePreference();

    /** @type {Record<string, *>|null} One-time notification restored after navigation. */
    #notice = ViewState.takeNotice();

    /** @param {URL} url - Room destination used after a create, join, or view command. */
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
        const {NetworkConnectionController} = await import("./controllers/NetworkConnectionController.js");

        this.#controller = new HomeController();
        await this.#controller.initialize();
        this.#controller.renderYear();
        this.#controller.setModeHandler(this.#handleMode.bind(this));
        this.#controller.setGameHandler(this.#enterRoom.bind(this));

        if (this.#notice !== null) this.#controller.handleNotification(this.#notice);

        this.#networkController = new NetworkConnectionController();
        this.#networkController.setConnectedHandler(this.#handleHostedConnected.bind(this));
        this.#networkController.initialize();

        if (this.#preferredMode === "hosted") {
            this.#selectHosted(false);
        } else if (this.#preferredMode === "direct") {
            this.#selectDirect();
        } else {
            this.#selectHosted(true);
        }
    }

    /** @param {"direct"|"hosted"} mode - Mode to write to the current URL without navigation. */
    #updateModeUrl(mode) {
        const url = new URL(location.href);
        url.searchParams.set("mode", mode);
        history.replaceState(null, "", url);
    }

    /**
     * Replaces Home with Hosted connection status.
     *
     * @param {string} status - Connection status identifier.
     * @param {string} networkUrl - Hosted endpoint displayed to the user.
     */
    #showNetworkState(status, networkUrl) {
        DomUtils.hide(this.#homeView);
        this.#networkController.show();
        this.#networkController.render(status, networkUrl, "");
    }

    /**
     * Replaces the client, binds Home observers, and opens the selected transport.
     *
     * @param {"direct"|"hosted"} requestedMode - Transport mode to open.
     */
    #connect(requestedMode) {
        this.mode = requestedMode === "hosted" ? "hosted" : "direct";
        ViewState.setMode(this.mode);
        this.#controller.selectMode(this.mode);

        const nextClient = this.replaceClient(this.mode);
        this.#controller.setClient(nextClient);
        let statusHandler = null;
        let dataHandler = null;

        if (this.mode === "hosted") {
            const networkUrl = ViewState.getHostedUrl();
            statusHandler = this.#handleNetworkStatus.bind(this, nextClient, networkUrl);
            dataHandler = this.#handleNetworkData.bind(this, nextClient);
        }

        nextClient.open(new ClientEvents(this.#controller, statusHandler, dataHandler));
    }

    /**
     * Displays status only when it belongs to the current Hosted client.
     *
     * @param {typeof Client} expectedClient - Client that registered the callback.
     * @param {string} networkUrl - Hosted endpoint displayed to the user.
     * @param {string} status - Connection status identifier.
     */
    #handleNetworkStatus(expectedClient, networkUrl, status) {
        if (this.client === expectedClient && this.mode === "hosted") {
            this.#showNetworkState(status, networkUrl);
        }
    }

    /**
     * Reveals Home after the current Hosted client supplies Home data.
     *
     * @param {Client} expectedClient - Client that registered the callback.
     * @param {string} view - Response view identifier.
     */
    #handleNetworkData(expectedClient, view) {
        if (this.client !== expectedClient || this.mode !== "hosted" || view !== Constants.VIEWS.HOME) return;
        this.#networkController.hide();
        DomUtils.show(this.#homeView);
        this.#updateModeUrl("hosted");
    }

    /** Cancels hosted discovery and establishes an in-browser Direct client. */
    #selectDirect() {
        this.#networkController.cancel();
        this.#networkController.hide();
        DomUtils.show(this.#homeView);
        ViewState.clearHostedUrl();
        this.#updateModeUrl("direct");
        this.#connect("direct");
    }

    /** @param {boolean} fallbackToDirect - Whether failed discovery selects Direct mode. */
    #selectHosted(fallbackToDirect) {
        this.disconnect();
        this.mode = "hosted";
        ViewState.setMode("hosted");
        this.#controller.selectMode("hosted");
        this.#showNetworkState("connecting", "");
        void this.#networkController.connect(null).then(this.#handleAutomaticHostedResult.bind(this, fallbackToDirect));
    }

    /**
     * Performs the requested Direct fallback after Hosted discovery completes.
     *
     * @param {boolean} fallbackToDirect - Whether fallback was requested.
     * @param {boolean} isAvailable - Whether a Hosted endpoint was found.
     */
    #handleAutomaticHostedResult(fallbackToDirect, isAvailable) {
        if (fallbackToDirect && !isAvailable && this.mode === "hosted") this.#selectDirect();
    }

    /** @param {"direct"|"hosted"} mode - User-selected transport mode. */
    #handleMode(mode) {
        if (mode === "hosted") this.#selectHosted(false);
        else this.#selectDirect();
    }

    /** @param {string} networkUrl - Verified Hosted WebSocket URL. */
    #handleHostedConnected(networkUrl) {
        ViewState.setHostedUrl(networkUrl);
        this.#connect("hosted");
    }

    /**
     * Persists Room intent and navigates to the Room view.
     *
     * @param {string} command - Create, join, or view command.
     * @param {{name:string}} data - Command data containing the target Room name.
     */
    #enterRoom(command, data) {
        ViewState.setMode(this.mode);
        ViewState.setIntent({mode: this.mode, command, data});
        const roomUrl = new URL(this.url);
        roomUrl.searchParams.set("mode", this.mode);
        roomUrl.searchParams.set("room", data.name);
        location.assign(roomUrl.href);
    }
}


/** Coordinates Room admission, controllers, transport, and Home navigation. */
export class RoomView extends View {

    /** @type {import("./controllers/RoomController.js").RoomController|null} Room interaction controller after startup. */
    #controller = null;

    /** @type {import("./controllers/GuideController.js").GuideController|null} Game-guide controller after startup. */
    #guideController = null;

    /** @type {{mode:"direct"|"hosted", command:string, data:Record<string, *>}|null} Create, join, or view intent carried from Home. */
    #intent = ViewState.getIntent();

    /** @type {boolean} Whether mode and intent are enough to enter Room. */
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
        const {GuideController} = await import("./controllers/GuideController.js");

        this.#controller = new RoomController();
        await this.#controller.initialize();
        const client = this.replaceClient(this.mode);
        client.open(new ClientEvents(this.#controller, null, null));
        this.#controller.renderYear();
        this.#controller.setClient(client);
        this.#controller.setIntent(this.#intent);
        this.#controller.setReadyHandler(this.#handleReady.bind(this));
        this.#controller.setHomeHandler(this.#returnHome.bind(this));

        this.#guideController = new GuideController();
        this.#guideController?.initialize();

        window.addEventListener("pagehide", this.disconnect.bind(this), {once: true});
    }

    /** @returns {string} Home URL carrying the active transport mode. */
    #homeUrl() {
        const homeUrl = new URL(this.url);
        homeUrl.searchParams.set("mode", this.mode);
        return homeUrl.href;
    }

    /**
     * Converts successful creation intent into a stable joined-Room intent.
     *
     * @param {{name:string}} game - Created game snapshot.
     */
    #handleReady(game) {
        if (this.#intent.command !== Constants.COMMANDS.CREATE) return;
        this.#intent = {
            ...this.#intent,
            command: Constants.COMMANDS.JOIN,
            data: {roomName: game.name, playerName: this.#intent.data.playerName}
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
