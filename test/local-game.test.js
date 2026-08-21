"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GameClient } from "../src/client/GameClient.js";
import { LocalTransport } from "../src/client/LocalTransport.js";
import { Transport } from "../src/client/Transport.js";
import { WebSocketTransport } from "../src/client/WebSocketTransport.js";
import { Constants } from "../src/core/Constants.js";
import { LocalServer } from "../src/local/LocalServer.js";

async function send(server, type, payload = {}) {
    const responses = [];
    server.onResponse = (response) => responses.push(response);
    await server.handle({type, payload: {tabId: "test-tab", sortKey: "none", ...payload}});
    return responses;
}

async function createSession(capacity, suffix = capacity) {
    const server = new LocalServer();
    const responses = await send(server, Constants.ACTIONS.CREATE, {
        sessionName: `Local Session ${suffix}`,
        playerName: "Daniel",
        capacity
    });
    const session = responses.findLast((response) => response.view === Constants.VIEWS.SESSION)?.sync;
    return {server, session, responses};
}

test("local sessions fill every remaining capacity seat with AI", async () => {
    for (const capacity of [2, 3, 4]) {
        const {session} = await createSession(capacity);

        assert.equal(session.capacity, capacity);
        assert.equal(session.playerCount, capacity);
        assert.equal(session.localPlayerName, "Daniel");
        assert.equal(session.circle.players[0].name, "Daniel");
        assert.equal(session.circle.players.slice(1).length, capacity - 1);
        assert.equal(session.mode, "local");
        assert.equal(session.capabilities.aiFill, true);
        assert.equal(session.capabilities.view, true);
    }
});

test("the local server uses the same game, session, and action response vocabulary", async () => {
    const server = new LocalServer();
    const gameResponses = await send(server, Constants.ACTIONS.LIST);

    assert.deepEqual(Object.keys(gameResponses[0]).sort(), ["message", "sync", "view"]);
    assert.equal(gameResponses[0].view, Constants.VIEWS.GAME);
    assert.equal(gameResponses[0].sync.mode, "local");
    assert.deepEqual(
        gameResponses[0].sync.sessions.map(({name, capacity, playerCount}) => ({name, capacity, playerCount})),
        Constants.DEFAULT_SESSIONS.map(({name, capacity, aiCount}) => ({name, capacity, playerCount: aiCount}))
    );

    const {session} = await createSession(2, "Protocol");
    assert.equal(session.status, Constants.STATUS.WAITING);
    assert.deepEqual(Object.keys(session).includes("circle"), true);
});

test("local default sessions support the same view and join actions as Server sessions", async () => {
    const server = new LocalServer();
    const sessionConfig = Constants.DEFAULT_SESSIONS[0];
    const visitResponses = await send(server, Constants.ACTIONS.VIEW, {
        sessionName: sessionConfig.name
    });
    const visitedSession = visitResponses.findLast((response) => response.view === Constants.VIEWS.SESSION).sync;

    assert.equal(visitedSession.name, sessionConfig.name);
    assert.equal(visitedSession.capacity, sessionConfig.capacity);
    assert.equal(visitedSession.playerCount, sessionConfig.aiCount);
    assert.equal(visitedSession.viewerCount, 1);
    assert.equal(visitedSession.localPlayerName, null);

    const joinResponses = await send(server, Constants.ACTIONS.JOIN, {
        sessionName: sessionConfig.name,
        playerName: "Daniel"
    });
    const joinedSession = joinResponses.findLast((response) => response.view === Constants.VIEWS.SESSION).sync;
    assert.equal(joinedSession.playerCount, sessionConfig.capacity);
    assert.equal(joinedSession.viewerCount, 0);
    assert.equal(joinedSession.localPlayerName, "Daniel");

    const game = (await send(server, Constants.ACTIONS.LEAVE))
        .findLast((response) => response.view === Constants.VIEWS.GAME).sync;
    assert.equal(game.sessions.some((listedSession) => listedSession.name === sessionConfig.name), true);
});

test("local sessions disappear from the registry when their player leaves", async () => {
    const {server} = await createSession(3, "Saved");
    const exitResponses = await send(server, Constants.ACTIONS.LEAVE);
    const game = exitResponses.findLast((response) => response.view === Constants.VIEWS.GAME).sync;

    assert.equal(game.sessions.length, Constants.DEFAULT_SESSIONS.length);
    assert.equal(game.sessions.some((session) => session.name === "Local Session Saved"), false);
    assert.equal(
        (await send(server, Constants.ACTIONS.LIST))[0].sync.sessions.length,
        Constants.DEFAULT_SESSIONS.length
    );
});

test("listed local sessions can be joined with a player name", async () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    };
    Object.defineProperty(globalThis, "localStorage", {value: storage, configurable: true});

    try {
        const owner = new LocalServer();
        await send(owner, Constants.ACTIONS.CREATE, {
            sessionName: "Shared Local Session",
            playerName: "Daniel",
            capacity: 3
        });

        const viewer = new LocalServer();
        const listedSession = (await send(viewer, Constants.ACTIONS.LIST))[0].sync.sessions
            .find((session) => session.name === "Shared Local Session");
        assert.equal(listedSession.playerName, undefined);

        const responses = await send(viewer, Constants.ACTIONS.JOIN, {
            sessionName: listedSession.name,
            playerName: "Casey"
        });
        const session = responses.findLast((response) => response.view === Constants.VIEWS.SESSION).sync;
        assert.equal(session.name, listedSession.name);
        assert.equal(session.localPlayerName, "Casey");

        await send(owner, Constants.ACTIONS.LEAVE);
        const observer = new LocalServer();
        const observerSessions = (await send(observer, Constants.ACTIONS.LIST))[0].sync.sessions;
        assert.equal(observerSessions.length, Constants.DEFAULT_SESSIONS.length);
        assert.equal(observerSessions.some((session) => session.name === "Shared Local Session"), false);
        viewer.disconnect();
    } finally {
        if (originalStorage === undefined) {
            delete globalThis.localStorage;
        } else {
            Object.defineProperty(globalThis, "localStorage", originalStorage);
        }
    }
});

test("disconnecting a local player removes its session", async () => {
    const {server} = await createSession(2, "Closed");
    server.disconnect();
    const game = (await send(server, Constants.ACTIONS.LIST))[0].sync;

    assert.equal(game.sessions.length, Constants.DEFAULT_SESSIONS.length);
    assert.equal(game.sessions.some((session) => session.name === "Local Session Closed"), false);
});

test("local game actions start the shared Session model through the common protocol", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
        const {server} = await createSession(2, "Action");
        const responses = await send(server, Constants.ACTIONS.START);
        const session = responses.findLast((response) => response.view === Constants.VIEWS.SESSION).sync;

        assert.equal(session.status, Constants.STATUS.PLAYING);
        assert.equal(session.circle.turnOwnerKey, session.circle.players[0].key);
        assert.equal(session.circle.players.every((player) => player.hand.cards.length === 7), true);
    } finally {
        Math.random = originalRandom;
    }
});

test("both transports implement the same short Transport API", () => {
    assert.equal(LocalTransport.prototype instanceof Transport, true);
    assert.equal(WebSocketTransport.prototype instanceof Transport, true);

    for (const method of ["connect", "send", "close"]) {
        assert.equal(typeof LocalTransport.prototype[method], "function");
        assert.equal(typeof WebSocketTransport.prototype[method], "function");
    }
});

test("GameClient adds the same session fields to every transport request", () => {
    class TestTransport extends Transport {
        request = null;
        connect() {}
        send(request) {
            this.request = request;
            return true;
        }
    }

    const transport = new TestTransport();
    const client = new GameClient(transport);
    client.sortKey = "rank";

    assert.equal(client.send(Constants.ACTIONS.CREATE, {sessionName: "Test"}), true);
    assert.equal(transport.request.type, Constants.ACTIONS.CREATE);
    assert.equal(transport.request.payload.sessionName, "Test");
    assert.equal(transport.request.payload.sortKey, "rank");
    assert.equal(typeof transport.request.payload.tabId, "string");
});

test("static and server deployments share one game page and one session page", () => {
    const gameHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sessionHtml = readFileSync(new URL("../session/index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server/Server.js", import.meta.url), "utf8");

    assert.match(gameHtml, /<body data-page="game">/);
    assert.match(gameHtml, /id="session-registration-form"/);
    assert.match(gameHtml, /id="session-list-table-body"/);
    const sharedHeaderPattern = /<header id="app-header">\s*<h1[\s\S]*?<\/h1>\s*<aside id="connection-status"/;

    assert.match(gameHtml, sharedHeaderPattern);
    assert.match(sessionHtml, sharedHeaderPattern);
    assert.match(gameHtml, /<aside[^>]+id="connection-status"[^>]+class="toggle-switch"[^>]+role="radiogroup"[^>]+data-status="connecting"/);
    assert.match(gameHtml, /<aside[^>]+id="connection-status"[^>]*>\s*<label>\s*<input id="local-mode-input"/);
    assert.match(gameHtml, /id="local-mode-input"[^>]+value="local"/);
    assert.match(gameHtml, /id="server-mode-input"[^>]+value="server"/);
    assert.doesNotMatch(gameHtml, /id="connection-status-indicator"/);
    assert.doesNotMatch(gameHtml, /id="play-mode-group"/);
    assert.doesNotMatch(gameHtml, /id="local-session-note"/);
    assert.doesNotMatch(gameHtml, /id="connection-status-label"/);
    assert.match(gameHtml, /id="request-mode-control"[^>]+class="toggle-switch"[^>]+role="radiogroup"/);
    assert.doesNotMatch(gameHtml, /<fieldset/);
    assert.doesNotMatch(gameHtml, /id="mode-group"/);
    assert.match(gameHtml, /id="session-list-panel"/);
    assert.doesNotMatch(gameHtml, /id="request-mode-control" hidden/);
    assert.doesNotMatch(gameHtml, /id="session-list-panel" hidden/);
    assert.match(gameHtml, /<tbody id="session-list-table-body">[\s\S]*?class="empty-session-row"/);
    assert.doesNotMatch(gameHtml, /id="game-guide-section"/);
    assert.match(sessionHtml, /<body data-page="session">/);
    assert.match(sessionHtml, /id="session-play-area"[^>]+data-is-turn-bound="false"/);
    assert.match(sessionHtml, /class="[^"]*local-player-region[^"]*"[^>]+data-card-count="0"/);
    assert.match(sessionHtml, /class="[^"]*local-player-region[^"]*"[^>]+id="local-player-hand"/);
    assert.match(sessionHtml, /class="playing-card-area" id="discard-pile"/);
    assert.doesNotMatch(sessionHtml, /id="local-player-region"/);
    assert.match(sessionHtml, /id="game-guide-section"/);
    assert.match(sessionHtml, /<tr class="placeholder-row"[^>]*>[\s\S]*?<td>--<\/td>/);
    assert.doesNotMatch(sessionHtml, /id="session-mode-label"/);
    assert.doesNotMatch(sessionHtml, /id="connection-status-indicator"/);
    assert.match(gameHtml, /\.\/src\/main\.js/);
    assert.match(sessionHtml, /\.\.\/src\/main\.js/);
    assert.match(gameHtml, /\.\/web\/shared\/styles\/pick2-index\.css/);
    assert.match(sessionHtml, /\.\.\/web\/shared\/styles\/session-index\.css/);
    assert.match(gameHtml, /\.\/web\/shared\/styles\/base\.css/);
    assert.match(sessionHtml, /\.\.\/web\/shared\/styles\/base\.css/);
    assert.match(main, /new LocalTransport\(new LocalServer\(\)\)/);
    assert.match(main, /new WebSocketTransport/);
    assert.match(server, /session\/index\.html/);
    assert.match(server, /\["\/session", "\/session\/", "\/session\/index\.html"\]/);
    assert.doesNotMatch(server, /response\.redirect\([^)]*\/session/);
    assert.doesNotMatch(server, /web\/server/);
});

test("shared controllers depend on GameClient vocabulary rather than edition services", () => {
    const gameController = readFileSync(new URL("../src/ui/GameController.js", import.meta.url), "utf8");
    const sessionController = readFileSync(new URL("../src/ui/SessionController.js", import.meta.url), "utf8");

    for (const source of [gameController, sessionController]) {
        assert.doesNotMatch(source, /Static|ConnectionService|LocalGameService|ServerSessionController/);
        assert.match(source, /this\.client/);
    }

    assert.match(gameController, /row\.addEventListener\("click", openSession\)/);
    assert.match(gameController, /row\.addEventListener\("keydown"/);
    assert.match(gameController, /row\.tabIndex = 0/);
    assert.match(gameController, /this\.#sessionHandler\?\.\(Constants\.ACTIONS\.VIEW, \{sessionName\}\)/);
    assert.doesNotMatch(gameController, /this\.#capabilities\.viewers === true/);
    assert.match(gameController, /cell\.textContent = "No sessions available\."/);
    assert.match(gameController, /for \(const input of \[this\.#localModeInput, this\.#serverModeInput\]\)/);
    assert.match(gameController, /this\.#modeHandler\?\.\(input\.value\)/);
    assert.match(gameController, /registrationMode === "join" && !isSessionListed/);
    assert.match(gameController, /title: "Session not found"/);
    assert.match(sessionController, /this\.#session === null && !this\.#isLeaving/);
});

test("the landing page keeps canonical search metadata", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
    const canonicalUrl = "https://danieltongu.github.io/pick-2/";

    assert.match(html, /<title>Play Pick 2 \| Your Modern Card Table<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}">`));
    assert.match(sitemap, new RegExp(`<loc>${canonicalUrl}<\\/loc>`));
});

test("the shared session preserves touch-friendly card presentation", () => {
    const html = readFileSync(new URL("../session/index.html", import.meta.url), "utf8");
    const cardCss = readFileSync(new URL("../web/shared/styles/playing-card.css", import.meta.url), "utf8");
    const sessionCss = readFileSync(new URL("../web/shared/styles/session-index.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../web/shared/styles/pick2-index.css", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../src/ui/LocalPlayerController.js", import.meta.url), "utf8");

    assert.doesNotMatch(html, /id="card-size-range"/);
    assert.match(cardCss, /--card-size:\s*100cqh/);
    assert.match(cardCss, /\.playing-card-drag-handle\s*\{[\s\S]*?width:\s*100%/);
    assert.match(cardCss, /\.playing-card-area:not\(#discard-pile\)[\s\S]*overflow-x:\s*auto/);
    assert.match(sessionCss, /@keyframes turn-owner-border-strobe/);
    assert.match(sessionCss, /\[data-is-turn-bound="false"\] > \.local-player-region/);
    assert.match(gameCss, /\.toggle-switch label:has\(input:checked\)/);
    assert.match(controller, /setBooleanState\(this\.root, "isTurnBound", true\)/);
    assert.match(controller, /setBooleanState\(this\.root, "isTurnBound", false\)/);
});
