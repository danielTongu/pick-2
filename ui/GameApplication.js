"use strict";

import { Constants } from "../core/Constants.js";
import { Browser } from "../runtime/Browser.js";
import { ClientEvents } from "../runtime/Client.js";
import { NetworkClient } from "../runtime/NetworkClient.js";
import { NetworkConnectionController } from "./controllers/NetworkConnectionController.js";
import { PageState } from "./PageState.js";
import { DomUtils } from "./utilities/DomUtils.js";
import { renderYear } from "./utilities/renderYear.js";

/** Supplies the game-owned parts used by the shared Home and Room application shell. */
export class GameApplicationConfig {
    /** Creates an immutable dependency contract for both application pages. */
    constructor(GameType, ClientType, HomeControllerType, RoomControllerType, GuideControllerType) {
        this.GameType = GameType;
        this.ClientType = ClientType;
        this.HomeControllerType = HomeControllerType;
        this.RoomControllerType = RoomControllerType;
        this.GuideControllerType = GuideControllerType;
        Object.freeze(this);
    }

    /** Creates client. */
    createClient(mode) {
        let endpoint;

        if (mode === "hosted") {
            endpoint = new NetworkClient(PageState.getHostedUrl());
        } else {
            endpoint = new Browser(new this.GameType());
        }

        return new this.ClientType(endpoint);
    }

    /** Resolves Home relative to the current deployment base. */
    homeUrl() {
        return new URL("./index.html", location.href);
    }

    /** Resolves Room relative to the document base URL. */
    roomUrl() {
        return new URL("./room.html", document.baseURI);
    }

    /** Initializes required state and event bindings. */
    initializeGuide() {
        if (this.GuideControllerType !== null) {
            new this.GuideControllerType().initialize();
        }
    }
}

/** Encapsulates home page behavior. */
class HomePage {
    /** @type {GameApplicationConfig} Shared game, client, and controller factories. */
    #config;

    /** @type {HTMLElement} Root Home view hidden during hosted connection setup. */
    #homeView = DomUtils.require("#home-view", HTMLElement);

    /** @type {HomeController} Home form, directory, and notification controller. */
    #controller;
    /** @type {NetworkConnectionController} Hosted endpoint discovery and connection view. */
    #networkController = new NetworkConnectionController();

    /** @type {Client|null} Active Direct or Hosted client. */
    #client = null;

    /** @type {string} Active Direct or Hosted transport mode. */
    #mode = "direct";

    /** @type {string|null} Persisted or URL-selected startup mode. */
    #preferredMode = PageState.getModePreference();

    /** @type {Object|null} One-time notification restored after navigation. */
    #notice = PageState.takeNotice();

    /** Creates the Home lifecycle and its controllers without opening a transport. */
    constructor(config) {
        this.#config = config;
        this.#controller = new config.HomeControllerType();
    }

    /** Binds Home controllers and establishes the preferred transport mode. */
    async start() {
        this.#controller.setModeHandler(this.#handleMode.bind(this));
        this.#controller.setGameHandler(this.#enterRoom.bind(this));
        this.#networkController.setConnectedHandler(this.#handleHostedConnected.bind(this));
        await this.#controller.initialize();
        this.#networkController.initialize();

        if (this.#notice !== null) this.#controller.handleNotification(this.#notice);

        if (this.#preferredMode === "hosted") {
            this.#selectHosted(false);
        } else if (this.#preferredMode === "direct") {
            this.#selectDirect();
        } else {
            this.#selectHosted(true);
        }
    }

    /** Synchronizes the selected mode into the current URL without navigation. */
    #updateModeUrl(mode) {
        const url = new URL(location.href);
        url.searchParams.set("mode", mode);
        history.replaceState(null, "", url);
    }

    /** Detaches and closes the active client before a mode transition. */
    #disconnect() {
        const previousClient = this.#client;
        this.#client = null;
        previousClient?.close();
    }

    /** Replaces Home with the hosted-connection view and status detail. */
    #showNetworkState(status, networkUrl) {
        DomUtils.hide(this.#homeView);
        this.#networkController.show();
        this.#networkController.render(status, networkUrl, "");
    }

    /** Creates the selected endpoint, binds observers, and opens its client connection. */
    #connect(requestedMode) {
        this.#disconnect();
        this.#mode = requestedMode === "hosted" ? "hosted" : "direct";
        PageState.setMode(this.#mode);
        this.#controller.selectMode(this.#mode);

        const nextClient = this.#config.createClient(this.#mode);
        this.#client = nextClient;
        this.#controller.setClient(nextClient);
        let statusHandler = null;
        let dataHandler = null;

        if (this.#mode === "hosted") {
            const networkUrl = PageState.getHostedUrl();
            statusHandler = this.#handleNetworkStatus.bind(this, nextClient, networkUrl);
            dataHandler = this.#handleNetworkData.bind(this, nextClient);
        }

        nextClient.open(new ClientEvents(this.#controller, statusHandler, dataHandler));
    }

    /** Applies status only when it belongs to the current Hosted client. */
    #handleNetworkStatus(expectedClient, networkUrl, status) {
        if (this.#client === expectedClient && this.#mode === "hosted") {
            this.#showNetworkState(status, networkUrl);
        }
    }

    /** Reveals Home after the current Hosted client supplies authoritative Home data. */
    #handleNetworkData(expectedClient, view) {
        if (this.#client !== expectedClient || this.#mode !== "hosted" || view !== Constants.VIEWS.HOME) return;
        this.#networkController.hide();
        DomUtils.show(this.#homeView);
        this.#updateModeUrl("hosted");
    }

    /** Cancels hosted discovery and establishes an in-browser Direct client. */
    #selectDirect() {
        this.#networkController.cancel();
        this.#networkController.hide();
        DomUtils.show(this.#homeView);
        PageState.clearHostedUrl();
        this.#updateModeUrl("direct");
        this.#connect("direct");
    }

    /** Starts hosted discovery, optionally falling back to Direct when unavailable. */
    #selectHosted(fallbackToDirect) {
        this.#disconnect();
        this.#mode = "hosted";
        PageState.setMode("hosted");
        this.#controller.selectMode("hosted");
        this.#showNetworkState("connecting", "");
        void this.#networkController.connect(null).then(this.#handleAutomaticHostedResult.bind(this, fallbackToDirect));
    }

    /** Performs the requested Direct fallback after automatic hosted discovery fails. */
    #handleAutomaticHostedResult(fallbackToDirect, isAvailable) {
        if (fallbackToDirect && !isAvailable && this.#mode === "hosted") this.#selectDirect();
    }

    /** Routes a user-selected mode to its transition workflow. */
    #handleMode(mode) {
        if (mode === "hosted") this.#selectHosted(false);
        else this.#selectDirect();
    }

    /** Persists a verified hosted URL and opens its client. */
    #handleHostedConnected(networkUrl) {
        PageState.setHostedUrl(networkUrl);
        this.#connect("hosted");
    }

    /** Persists room intent and navigates to the shared Room page. */
    #enterRoom(command, data) {
        PageState.setMode(this.#mode);
        PageState.setIntent({ mode: this.#mode, command, data });
        const roomUrl = this.#config.roomUrl();
        roomUrl.searchParams.set("mode", this.#mode);
        roomUrl.searchParams.set("room", data.name);
        location.assign(roomUrl.href);
    }
}

/** Encapsulates room page behavior. */
class RoomPage {
    /** @type {GameApplicationConfig} Shared game, client, and controller factories. */
    #config;

    /** @type {string} Transport mode restored for the Room lifecycle. */
    #mode = PageState.getMode();

    /** @type {Object|null} Create, join, or view intent carried from Home. */
    #intent = PageState.getIntent();

    /** @type {Client|null} Active Direct or Hosted client. */
    #client = null;

    /** @type {RoomController|null} Controller created after intent validation. */
    #controller = null;

    /** @type {boolean} Whether mode and intent are sufficient to enter Room. */
    #isValid = true;

    /** Restores and validates Room navigation state before any connection opens. */
    constructor(config) {
        this.#config = config;
        const roomName = new URLSearchParams(location.search).get("room")?.trim() ?? "";

        if (this.#intent === null && roomName) {
            this.#intent = { mode: this.#mode, command: Constants.COMMANDS.VIEW, data: { roomName } };
        }

        if (this.#intent === null || this.#intent.mode !== this.#mode) this.#isValid = false;
    }

    /** Redirects invalid entry or initializes Room controllers and transport. */
    async start() {
        if (!this.#isValid) {
            location.replace(this.#homeUrl());
            return;
        }

        this.#client = this.#config.createClient(this.#mode);
        this.#controller = new this.#config.RoomControllerType();
        this.#controller.setClient(this.#client);
        this.#controller.setIntent(this.#intent);
        this.#controller.setReadyHandler(this.#handleReady.bind(this));
        this.#controller.setHomeHandler(this.#returnHome.bind(this));
        await this.#controller.initialize();
        this.#config.initializeGuide();
        this.#client.open(new ClientEvents(this.#controller, null, null));
        window.addEventListener("pagehide", this.#close.bind(this), { once: true });
    }

    /** Builds the mode-preserving Home URL used for Room exits. */
    #homeUrl() {
        const homeUrl = this.#config.homeUrl();
        homeUrl.searchParams.set("mode", this.#mode);
        return homeUrl.href;
    }

    /** Converts a successful create intent into the stable joined-room intent. */
    #handleReady(game) {
        if (this.#intent.command !== Constants.COMMANDS.CREATE) return;
        this.#intent = {
            ...this.#intent,
            command: Constants.COMMANDS.JOIN,
            data: { roomName: game.name, playerName: this.#intent.data.playerName }
        };
        PageState.setIntent(this.#intent);
        this.#controller.setIntent(this.#intent);
    }

    /** Persists an optional admission failure, closes Room, and navigates Home. */
    #returnHome(notice) {
        const isFailedAdmission = notice !== null;
        if (isFailedAdmission) PageState.setNotice(notice);
        PageState.clearIntent();
        this.#close();

        if (isFailedAdmission) location.replace(this.#homeUrl());
        else location.assign(this.#homeUrl());
    }

    /** Closes and releases the Room client exactly once. */
    #close() {
        this.#client?.close();
        this.#client = null;
    }
}

/** Reports an application-level failure without replacing user-facing notifications. */
function reportError(error) {
    console.error("Application error:", error);
}

/** Reports uncaught browser errors through the shared application logger. */
function handleWindowError(event) {
    reportError(event.error ?? event.message);
}

/** Reports unhandled promise rejections through the shared application logger. */
function handleUnhandledRejection(event) {
    reportError(event.reason);
}

/** Starts the shared page lifecycle using game-specific controllers and transport client. */
export async function startGameApplication(config) {
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    try {
        renderYear();
        const page = document.body.dataset.page;

        if (page === Constants.VIEWS.HOME) {
            await new HomePage(config).start();
        } else if (page === Constants.VIEWS.ROOM) {
            await new RoomPage(config).start();
        } else throw new Error(`Unknown page: ${page}`);
    } catch (error) {
        reportError(error);
    }
}
