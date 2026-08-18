"use strict";

import { GameClient } from "./client/GameClient.js";
import { LocalTransport } from "./client/LocalTransport.js";
import { ServerStatus } from "./client/ServerStatus.js";
import { ClientStore } from "./client/ClientStore.js";
import { WebSocketTransport } from "./client/WebSocketTransport.js";
import { Constants } from "./core/Constants.js";
import { LocalServer } from "./local/LocalServer.js";
import { DomUtils } from "./ui/DomUtils.js";
import { GuideController } from "./ui/GuideController.js";
import { GameController } from "./ui/GameController.js";
import { SessionController } from "./ui/SessionController.js";

/** @param {"local"|"server"} mode - Play mode. */
function createClient(mode) {
    const transport = mode === "server"
        ? new WebSocketTransport(ClientStore.getServerUrl())
        : new LocalTransport(new LocalServer());

    return new GameClient(transport);
}

/** Renders the current copyright year when present. */
function renderYear() {
    const element = document.querySelector("#copyright-year");

    if (element instanceof HTMLTimeElement) {
        const year = String(new Date().getFullYear());
        element.dateTime = year;
        element.textContent = year;
    }
}

/** Starts the shared game page. */
async function startGamePage() {
    const controller = new GameController();
    const notice = ClientStore.takeNotice();
    let client = null;
    let mode = "local";
    const preferredMode = ClientStore.getMode();

    const connect = (nextMode) => {
        client?.close();
        mode = nextMode === "server" ? "server" : "local";
        ClientStore.setMode(mode);
        controller.selectMode(mode);
        client = createClient(mode);
        client.setController(controller);
        controller.setClient(client);
        client.connect();
    };

    controller.setModeHandler((nextMode) => connect(nextMode));
    controller.setSessionHandler((action, payload) => {
        ClientStore.setMode(mode);
        ClientStore.setIntent({mode, action, payload});
        const sessionUrl = new URL("session/", document.baseURI);
        sessionUrl.searchParams.set("mode", mode);
        sessionUrl.searchParams.set("session", payload.sessionName);
        location.assign(sessionUrl.href);
    });

    await controller.initialize();

    if (notice !== null) {
        controller.handleNotification(notice);
    }

    controller.setServerAvailable(false);
    connect("local");

    const isServerAvailable = await ServerStatus.check();
    controller.setServerAvailable(isServerAvailable);

    if (isServerAvailable && preferredMode === "server") {
        connect("server");
    }
}

/** Starts the shared session page. */
async function startSessionPage() {
    const mode = ClientStore.getMode();
    const query = new URLSearchParams(location.search);
    const sessionName = query.get("session")?.trim() ?? "";
    let intent = ClientStore.getIntent();

    if (intent === null && sessionName) {
        intent = {
            mode,
            action: Constants.ACTIONS.VIEW,
            payload: {sessionName}
        };
    }

    if (intent === null || intent.mode !== mode) {
        location.replace(new URL("../", location.href));
        return;
    }

    const client = createClient(mode);
    const controller = new SessionController();

    client.setController(controller);
    controller.setClient(client);
    controller.setIntent(intent);
    controller.setReadyHandler((session) => {
        if (intent.action === Constants.ACTIONS.CREATE) {
            intent = {
                ...intent,
                action: Constants.ACTIONS.JOIN,
                payload: {
                    sessionName: session.name,
                    playerName: intent.payload.playerName
                }
            };
            ClientStore.setIntent(intent);
            controller.setIntent(intent);
        }
    });
    controller.setGameHandler((notice = null) => {
        const isFailedAdmission = notice !== null;

        if (notice !== null) {
            ClientStore.setNotice(notice);
        }

        ClientStore.clearIntent();
        client.close();
        const gameUrl = new URL("../", location.href);
        gameUrl.searchParams.set("mode", mode);

        if (isFailedAdmission) {
            location.replace(gameUrl.href);
        } else {
            location.assign(gameUrl.href);
        }
    });

    await controller.initialize();
    new GuideController().initialize();
    client.connect();
    window.addEventListener("pagehide", () => client.close(), {once: true});
}

/** Reports an unexpected page error. */
function reportError(error) {
    console.error("Application error:", error);
}

window.addEventListener("error", (event) => reportError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportError(event.reason));

try {
    renderYear();
    const page = document.body.dataset.page;

    if (page === Constants.VIEWS.GAME) {
        await startGamePage();
    } else if (page === Constants.VIEWS.SESSION) {
        await startSessionPage();
    } else {
        throw new Error(`Unknown page: ${page}`);
    }
} catch (error) {
    reportError(error);
    DomUtils.hide(document.body);
    throw error;
}
