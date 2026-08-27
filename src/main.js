"use strict";

import { GameClient } from "./client/GameClient.js";
import { LocalTransport } from "./client/LocalTransport.js";
import { ClientStore } from "./client/ClientStore.js";
import { WebSocketTransport } from "./client/WebSocketTransport.js";
import { Card } from "./core/Card.js";
import { Constants } from "./core/Constants.js";
import { LocalServer } from "./local/LocalServer.js";
import { DomUtils } from "./ui/DomUtils.js";
import { GuideController } from "./ui/GuideController.js";
import { GameController } from "./ui/GameController.js";
import { NetworkConnectionController } from "./ui/NetworkConnectionController.js";
import { PlayingCard } from "./ui/PlayingCard.js";
import { SessionController } from "./ui/SessionController.js";

/** @param {"local"|"network"} mode - Play mode. */
function createClient(mode) {
    const transport = mode === "network"
        ? new WebSocketTransport(ClientStore.getNetworkUrl())
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

/** Renders one score-ordered card from each special-card group. */
function renderSpecialCardFan() {
    const fan = document.querySelector(".card-fan");

    if (!(fan instanceof HTMLElement)) {
        return;
    }

    const {SUIT, VALUE} = Constants.CARD;
    const specialCards = [
        new Card(VALUE.TWO.id, SUIT.CLUBS, 0),
        new Card(VALUE.EIGHT.id, SUIT.DIAMONDS, 0),
        new Card(VALUE.JACK.id, SUIT.SPADES, 0),
        new Card(VALUE.ACE.id, SUIT.HEARTS, 0),
        new Card(VALUE.SEVEN.id, SUIT.HEARTS, 0),
        new Card(VALUE.JOKER.id, SUIT.BLACK, 0),
        new Card(VALUE.ACE.id, SUIT.SPADES, 0)
    ].sort((left, right) => left.score - right.score);

    fan.replaceChildren(...specialCards.map((card) => {
        const element = PlayingCard.create(card, {isDraggable: false});
        element.style.removeProperty("--card-rotation");
        element.dataset.decorative = "";
        return element;
    }));
}

/** Starts the shared game page. */
async function startGamePage() {
    const preferredMode = ClientStore.getMode();
    const gamePageView = DomUtils.require("#game-page-view", HTMLElement);
    const controller = new GameController();
    const networkController = new NetworkConnectionController();
    const notice = ClientStore.takeNotice();
    let client = null;
    let mode = "local";

    const updateModeUrl = (nextMode) => {
        const url = new URL(location.href);
        url.searchParams.set("mode", nextMode);
        history.replaceState(null, "", url);
    };

    const disconnect = () => {
        const previousClient = client;
        client = null;
        previousClient?.close();
    };

    const showNetworkState = (status, networkUrl = "") => {
        DomUtils.hide(gamePageView);
        networkController.show();
        networkController.render(status, networkUrl);
    };

    const connect = (nextMode) => {
        disconnect();
        mode = nextMode === "network" ? "network" : "local";
        ClientStore.setMode(mode);
        controller.selectMode(mode);
        const nextClient = createClient(mode);
        client = nextClient;
        nextClient.setController(controller);
        controller.setClient(nextClient);

        if (mode === "network") {
            const networkUrl = ClientStore.getNetworkUrl();
            nextClient.setStatusHandler((status) => {
                if (client !== nextClient || mode !== "network") {
                    return;
                }

                showNetworkState(status, networkUrl);
            });
            nextClient.setSyncHandler((view) => {
                if (client !== nextClient || mode !== "network" || view !== Constants.VIEWS.GAME) {
                    return;
                }

                networkController.hide();
                DomUtils.show(gamePageView);
                updateModeUrl("network");
            });
        }

        nextClient.connect();
    };

    const selectLocal = () => {
        networkController.cancel();
        networkController.hide();
        DomUtils.show(gamePageView);
        ClientStore.clearNetworkUrl();
        updateModeUrl("local");
        connect("local");
    };
    const selectNetwork = () => {
        disconnect();
        mode = "network";
        ClientStore.setMode("network");
        controller.selectMode("network");
        showNetworkState("connecting");
        void networkController.connect();
    };

    controller.setModeHandler((nextMode) => {
        if (nextMode === "network") {
            selectNetwork();
        } else {
            selectLocal();
        }
    });
    networkController.setConnectedHandler((networkUrl) => {
        ClientStore.setNetworkUrl(networkUrl);
        connect("network");
    });
    controller.setSessionHandler((action, payload) => {
        ClientStore.setMode(mode);
        ClientStore.setIntent({mode, action, payload});
        const sessionUrl = new URL("session/", document.baseURI);
        sessionUrl.searchParams.set("mode", mode);
        sessionUrl.searchParams.set("session", payload.sessionName);
        location.assign(sessionUrl.href);
    });

    await controller.initialize();
    networkController.initialize();

    if (notice !== null) {
        controller.handleNotification(notice);
    }

    if (preferredMode === "network") {
        selectNetwork();
    } else {
        selectLocal();
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
        renderSpecialCardFan();
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
