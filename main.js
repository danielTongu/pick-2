"use strict";

import { Card } from "./core/Card.js";
import { Constants } from "./core/Constants.js";
import { Browser } from "./runtime/Browser.js";
import { Client, ClientEvents } from "./runtime/Client.js";
import { NetworkClient } from "./runtime/NetworkClient.js";
import { DomUtils } from "./ui/utilities/DomUtils.js";
import { RoomController } from "./ui/controllers/RoomController.js";
import { GuideController } from "./ui/controllers/GuideController.js";
import { HomeController } from "./ui/controllers/HomeController.js";
import { NetworkConnectionController } from "./ui/controllers/NetworkConnectionController.js";
import { PageState } from "./ui/PageState.js";
import { PlayingCard } from "./ui/PlayingCard.js";

function createClient(mode) {
    const endpoint = mode === "network"
        ? new NetworkClient(PageState.getNetworkUrl())
        : new Browser();

    return new Client(endpoint);
}

function renderYear() {
    const element = document.querySelector("#copyright-year");

    if (element instanceof HTMLTimeElement) {
        const year = String(new Date().getFullYear());
        element.dateTime = year;
        element.textContent = year;
    }
}

function compareCardScores(left, right) {
    return left.score - right.score;
}

function createFanCard(card) {
    const element = PlayingCard.create(card, false);
    element.style.removeProperty("--card-rotation");
    element.dataset.decorative = "";
    return element;
}

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
    ].sort(compareCardScores);

    fan.replaceChildren(...specialCards.map(createFanCard));
}

class HomePage {
    #homeView = DomUtils.require("#home-view", HTMLElement);
    #controller = new HomeController();
    #networkController = new NetworkConnectionController();
    #client = null;
    #mode = "local";
    #preferredMode = PageState.getMode();
    #notice = PageState.takeNotice();

    async start() {
        this.#controller.setModeHandler(this.#handleMode.bind(this));
        this.#controller.setGameHandler(this.#enterGame.bind(this));
        this.#networkController.setConnectedHandler(this.#handleNetworkConnected.bind(this));

        await this.#controller.initialize();
        this.#networkController.initialize();

        if (this.#notice !== null) {
            this.#controller.handleNotification(this.#notice);
        }

        if (this.#preferredMode === "network") {
            this.#selectNetwork();
        } else {
            this.#selectLocal();
        }
    }

    #updateModeUrl(mode) {
        const url = new URL(location.href);
        url.searchParams.set("mode", mode);
        history.replaceState(null, "", url);
    }

    #disconnect() {
        const previousClient = this.#client;
        this.#client = null;
        previousClient?.close();
    }

    #showNetworkState(status, networkUrl) {
        DomUtils.hide(this.#homeView);
        this.#networkController.show();
        this.#networkController.render(status, networkUrl, "");
    }

    #connect(requestedMode) {
        this.#disconnect();
        this.#mode = requestedMode === "network" ? "network" : "local";
        PageState.setMode(this.#mode);
        this.#controller.selectMode(this.#mode);

        const nextClient = createClient(this.#mode);
        this.#client = nextClient;
        this.#controller.setClient(nextClient);

        let statusHandler = null;
        let dataHandler = null;

        if (this.#mode === "network") {
            const networkUrl = PageState.getNetworkUrl();
            statusHandler = this.#handleNetworkStatus.bind(this, nextClient, networkUrl);
            dataHandler = this.#handleNetworkData.bind(this, nextClient);
        }

        nextClient.open(new ClientEvents(this.#controller, statusHandler, dataHandler));
    }

    #handleNetworkStatus(expectedClient, networkUrl, status) {
        if (this.#client === expectedClient && this.#mode === "network") {
            this.#showNetworkState(status, networkUrl);
        }
    }

    #handleNetworkData(expectedClient, view) {
        if (
            this.#client !== expectedClient ||
            this.#mode !== "network" ||
            view !== Constants.VIEWS.HOME
        ) {
            return;
        }

        this.#networkController.hide();
        DomUtils.show(this.#homeView);
        this.#updateModeUrl("network");
    }

    #selectLocal() {
        this.#networkController.cancel();
        this.#networkController.hide();
        DomUtils.show(this.#homeView);
        PageState.clearNetworkUrl();
        this.#updateModeUrl("local");
        this.#connect("local");
    }

    #selectNetwork() {
        this.#disconnect();
        this.#mode = "network";
        PageState.setMode("network");
        this.#controller.selectMode("network");
        this.#showNetworkState("connecting", "");
        void this.#networkController.connect(null);
    }

    #handleMode(mode) {
        if (mode === "network") {
            this.#selectNetwork();
        } else {
            this.#selectLocal();
        }
    }

    #handleNetworkConnected(networkUrl) {
        PageState.setNetworkUrl(networkUrl);
        this.#connect("network");
    }

    #enterGame(action, data) {
        PageState.setMode(this.#mode);
        PageState.setIntent({mode: this.#mode, action, data});

        const roomUrl = new URL("./room.html", document.baseURI);
        roomUrl.searchParams.set("mode", this.#mode);
        roomUrl.searchParams.set("room", data.roomName);
        location.assign(roomUrl.href);
    }
}

class GamePage {
    #mode = PageState.getMode();
    #intent = PageState.getIntent();
    #client = null;
    #controller = null;
    #isValid = true;

    constructor() {
        const query = new URLSearchParams(location.search);
        const roomName = query.get("room")?.trim() ?? "";

        if (this.#intent === null && roomName) {
            this.#intent = {
                mode: this.#mode,
                action: Constants.ACTIONS.VIEW,
                data: {roomName}
            };
        }

        if (this.#intent === null || this.#intent.mode !== this.#mode) {
            this.#isValid = false;
        }
    }

    async start() {
        if (!this.#isValid) {
            location.replace(new URL("../", location.href));
            return;
        }

        this.#client = createClient(this.#mode);
        this.#controller = new RoomController();
        this.#controller.setClient(this.#client);
        this.#controller.setIntent(this.#intent);
        this.#controller.setReadyHandler(this.#handleReady.bind(this));
        this.#controller.setHomeHandler(this.#returnHome.bind(this));

        await this.#controller.initialize();
        new GuideController().initialize();
        this.#client.open(new ClientEvents(this.#controller, null, null));
        window.addEventListener("pagehide", this.#close.bind(this), {once: true});
    }

    #handleReady(game) {
        if (this.#intent.action === Constants.ACTIONS.CREATE) {
            this.#intent = {
                ...this.#intent,
                action: Constants.ACTIONS.JOIN,
                data: {
                    roomName: game.roomName,
                    playerName: this.#intent.data.playerName
                }
            };
            PageState.setIntent(this.#intent);
            this.#controller.setIntent(this.#intent);
        }
    }

    #returnHome(notice) {
        const isFailedAdmission = notice !== null;

        if (isFailedAdmission) {
            PageState.setNotice(notice);
        }

        PageState.clearIntent();
        this.#client.close();

        const homeUrl = new URL("./", location.href);
        homeUrl.searchParams.set("mode", this.#mode);

        if (isFailedAdmission) {
            location.replace(homeUrl.href);
        } else {
            location.assign(homeUrl.href);
        }
    }

    #close() {
        this.#client.close();
    }
}

function reportError(error) {
    console.error("Application error:", error);
}

function handleWindowError(event) {
    reportError(event.error ?? event.message);
}

function handleUnhandledRejection(event) {
    reportError(event.reason);
}

window.addEventListener("error", handleWindowError);
window.addEventListener("unhandledrejection", handleUnhandledRejection);

try {
    renderYear();
    const page = document.body.dataset.page;

    if (page === Constants.VIEWS.HOME) {
        renderSpecialCardFan();
        await new HomePage().start();
    } else if (page === Constants.VIEWS.ROOM) {
        await new GamePage().start();
    } else {
        throw new Error(`Unknown page: ${page}`);
    }
} catch (error) {
    reportError(error);
}
