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

test("local default sessions support the same view and join actions as Network sessions", async () => {
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

test("GameClient exposes transport status and fresh synchronization events", () => {
    class TestTransport extends Transport {
        connect() {}
        send() { return true; }
    }

    const transport = new TestTransport();
    const client = new GameClient(transport);
    const statuses = [];
    const syncs = [];
    client.setController({handleSync() {}});
    client.setStatusHandler((status) => statuses.push(status));
    client.setSyncHandler((view, sync) => syncs.push({view, sync}));

    transport.onStatus("reconnecting", "Reconnecting…");
    transport.onMessage(JSON.stringify({view: Constants.VIEWS.GAME, message: null, sync: {version: 2}}));

    assert.deepEqual(statuses, ["reconnecting"]);
    assert.deepEqual(syncs, [{view: Constants.VIEWS.GAME, sync: {version: 2}}]);
});

test("Local and Network modes share one game page and one session page", () => {
    const gameHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sessionHtml = readFileSync(new URL("../session/index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server/Server.js", import.meta.url), "utf8");
    const landingCss = readFileSync(
        new URL("../web/shared/styles/pick2-index.css", import.meta.url),
        "utf8"
    );

    assert.match(gameHtml, /<body data-page="game">/);
    assert.match(gameHtml, /id="session-registration-form"/);
    assert.match(gameHtml, /id="session-list-table-body"/);
    const sharedHeaderPattern = /<header id="app-header">\s*<a id="app-home-link"[\s\S]*?<h1 class="brand-mark"[\s\S]*?<aside class="brand-copy">[\s\S]*?<\/a>\s*<aside id="connection-status"/;

    assert.match(gameHtml, sharedHeaderPattern);
    assert.match(sessionHtml, sharedHeaderPattern);
    assert.equal(gameHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(gameHtml.match(/id="app-footer"/g)?.length, 1);
    assert.match(gameHtml, /<aside[^>]+id="connection-status"[^>]+class="toggle-switch"[^>]+role="radiogroup"[^>]+data-status="connecting"/);
    assert.match(gameHtml, /<aside[^>]+id="connection-status"[^>]*>\s*<label>\s*<input id="local-mode-input"/);
    assert.match(gameHtml, /id="local-mode-input"[^>]+value="local"/);
    assert.match(gameHtml, /id="network-mode-input"[^>]+value="network"/);
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
    assert.match(gameHtml, /<article id="network-connection-view"[^>]+hidden>/);
    assert.match(sessionHtml, /id="session-play-area"[^>]+data-is-player-view="true"/);
    assert.match(sessionHtml, /id="player-area"[^>]+data-is-turn-owner="false"[^>]+data-is-winner="true"/);
    assert.match(sessionHtml, /id="player-summary"[\s\S]*?<span data-card-count="0"><\/span>/);
    assert.match(sessionHtml, /class="playing-card-area" id="player-hand"/);
    assert.match(sessionHtml, /class="playing-card-area" id="discard-pile"/);
    assert.doesNotMatch(sessionHtml, /id="local-player-region"/);
    assert.match(sessionHtml, /id="game-guide-section"/);
    assert.match(sessionHtml, /<tr class="placeholder-row"[^>]*>[\s\S]*?<td>--<\/td>/);
    assert.doesNotMatch(sessionHtml, /id="session-mode-label"/);
    assert.doesNotMatch(sessionHtml, /id="connection-status-indicator"/);
    assert.match(gameHtml, /\.\/src\/main\.js/);
    assert.doesNotMatch(gameHtml, /network-connection\.js/);
    assert.match(gameHtml, /<aside class="card-fan" aria-hidden="true" inert><\/aside>/);
    assert.match(
        gameHtml,
        /<header class="hero">\s*<section class="eyebrow">[\s\S]*?<section>\s*<aside>[\s\S]*?<aside class="card-fan"/
    );
    assert.match(
        landingCss,
        /\.hero > section:last-child\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/
    );
    assert.match(
        landingCss,
        /\.card-fan\s*\{[\s\S]*?position:\s*relative;/
    );
    assert.match(landingCss, /\.card-fan > playing-card\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(landingCss, /--card-rotation:\s*-24deg;/);
    assert.doesNotMatch(landingCss, /--fan-angle/);
    assert.match(main, /new Card\(VALUE\.TWO\.id, SUIT\.CLUBS, 0\)/);
    assert.match(main, /new Card\(VALUE\.EIGHT\.id, SUIT\.DIAMONDS, 0\)/);
    assert.match(main, /new Card\(VALUE\.JACK\.id, SUIT\.SPADES, 0\)/);
    assert.match(main, /new Card\(VALUE\.ACE\.id, SUIT\.HEARTS, 0\)/);
    assert.match(main, /\.sort\(\(left, right\) => left\.score - right\.score\)/);
    assert.match(main, /PlayingCard\.create\(card, \{isDraggable: false\}\)/);
    assert.match(main, /element\.style\.removeProperty\("--card-rotation"\)/);
    assert.match(sessionHtml, /\.\.\/src\/main\.js/);
    assert.match(gameHtml, /\.\/web\/shared\/styles\/pick2-index\.css/);
    assert.match(sessionHtml, /\.\.\/web\/shared\/styles\/session-index\.css/);
    assert.match(gameHtml, /\.\/web\/shared\/styles\/base\.css/);
    assert.match(sessionHtml, /\.\.\/web\/shared\/styles\/base\.css/);
    assert.match(gameHtml, /\.\/web\/shared\/styles\/table\.css/);
    assert.match(sessionHtml, /\.\.\/web\/shared\/styles\/table\.css/);
    assert.ok(gameHtml.indexOf("styles/table.css") < gameHtml.indexOf("styles/pick2-index.css"));
    assert.ok(sessionHtml.indexOf("styles/table.css") < sessionHtml.indexOf("styles/session-index.css"));
    assert.doesNotMatch(gameHtml, /table-data\.css/);
    assert.doesNotMatch(sessionHtml, /table-data\.css/);
    assert.doesNotMatch(gameHtml + sessionHtml, /<caption\b/);
    assert.match(gameHtml, /<button id="session-enter-button">Enter session<\/button>/);
    assert.match(gameHtml, /<button id="alert-ok-button">OK<\/button>/);
    assert.match(sessionHtml, /<button id="session-play-button">Play<\/button>/);
    assert.match(sessionHtml, /<button id="session-invite-button" hidden>Invite<\/button>/);
    assert.match(sessionHtml, /<button id="countdown-ok-button">OK<\/button>/);
    assert.match(sessionHtml, /<button id="suit-selection-timeout-button">timeout<\/button>/);
    assert.match(sessionHtml, /<button id="suit-selection-submit-button">Submit<\/button>/);
    assert.match(sessionHtml, /<button id="session-end-dismiss-button">dismiss<\/button>/);
    assert.doesNotMatch(gameHtml + sessionHtml, /id="(?:quick-start|core-rules|special-cards)"/);
    assert.match(main, /new LocalTransport\(new LocalServer\(\)\)/);
    assert.match(main, /new WebSocketTransport/);
    assert.match(server, /session\/index\.html/);
    assert.match(server, /\["\/session", "\/session\/", "\/session\/index\.html"\]/);
    assert.doesNotMatch(server, /network\/index\.html/);
    assert.doesNotMatch(server, /\["\/network", "\/network\/", "\/network\/index\.html"\]/);
    assert.doesNotMatch(server, /response\.redirect\([^)]*\/session/);
    assert.doesNotMatch(server, /web\/network/);
});

test("the session-end dialog opens once per finish and clears for a new game", () => {
    const controller = readFileSync(new URL("../src/ui/SessionController.js", import.meta.url), "utf8");
    const sessionEndController = readFileSync(new URL("../src/ui/SessionEndController.js", import.meta.url), "utf8");

    assert.match(
        controller,
        /previousStatus !== Constants\.STATUS\.FINISHED[\s\S]*?nextStatus === Constants\.STATUS\.FINISHED[\s\S]*?#sessionEndController\.show\(session\)/
    );
    assert.match(
        controller,
        /localPlayer === null \|\| nextStatus !== Constants\.STATUS\.FINISHED[\s\S]*?#sessionEndController\.hide\(\)/
    );
    assert.match(
        sessionEndController,
        /hide\(\)\s*\{[\s\S]*?#players = \[\];[\s\S]*?#statsBody\.replaceChildren\(\);[\s\S]*?#selectedPlayerCards\.replaceChildren\(\);[\s\S]*?super\.hide\(\)/
    );
});

test("the shared table stylesheet owns foundational row states", () => {
    const baseCss = readFileSync(new URL("../web/shared/styles/base.css", import.meta.url), "utf8");
    const landingCss = readFileSync(new URL("../web/shared/styles/pick2-index.css", import.meta.url), "utf8");
    const sessionCss = readFileSync(new URL("../web/shared/styles/session-index.css", import.meta.url), "utf8");
    const overlaysCss = readFileSync(new URL("../web/shared/styles/overlays.css", import.meta.url), "utf8");
    const tableCss = readFileSync(new URL("../web/shared/styles/table.css", import.meta.url), "utf8");

    assert.doesNotMatch(baseCss, /^(?:table|th|td|tbody tr|\.table-container)\b/m);
    for (const componentCss of [landingCss, sessionCss, overlaysCss]) {
        assert.doesNotMatch(componentCss, /\b(?:th|td)\s*\{[^}]*\bborder(?:-\w+)?:/);
        assert.doesNotMatch(componentCss, /tbody tr(?::is\([^)]*\)|:(?:hover|focus-visible)|\[data-is-selected="true"\])\s*\{/);
    }
    assert.match(tableCss, /table:has\(> tbody:empty\)::after\s*\{/);
    assert.match(tableCss, /tr\s*\{[\s\S]*?border-bottom:\s*1px solid rgba\(255, 255, 255, \.08\)/);
    assert.match(tableCss, /tbody tr:is\(:hover, :focus-visible\)\s*\{[\s\S]*?background:\s*rgb\(0 255 255 \/ \.12\)/);
    assert.match(tableCss, /tbody tr:focus-visible\s*\{[\s\S]*?outline-offset:\s*-3px/);
    assert.match(tableCss, /tbody tr\[data-is-selected="true"\]\s*\{\s*color:\s*cyan;\s*\}/);
    assert.match(tableCss, /th\s*\{[\s\S]*?font-size:\s*9px;[\s\S]*?font-weight:\s*800;[\s\S]*?letter-spacing:\s*\.1em;/);
    assert.doesNotMatch(landingCss + sessionCss + overlaysCss, /--table-heading-(?:color|font-size|font-weight|letter-spacing)/);
});

test("responsive styles are mobile-first with one tablet and desktop stage", () => {
    const styleNames = [
        "base.css",
        "pick2-index.css",
        "session-index.css"
    ];

    for (const styleName of styleNames) {
        const css = readFileSync(new URL(`../web/shared/styles/${styleName}`, import.meta.url), "utf8");
        assert.doesNotMatch(css, /@media\s*\(max-width:/);
        assert.equal(css.match(/@media\s*\(min-width:\s*721px\)/g)?.length, 1);
    }

    const html = ["../index.html", "../session/index.html"]
        .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
        .join("\n");
    const baseCss = readFileSync(new URL("../web/shared/styles/base.css", import.meta.url), "utf8");

    assert.doesNotMatch(html, /styles\/(?:tokens|app-footer|app-header)\.css/);
    assert.match(baseCss, /:root\s*\{[\s\S]*?--container-spacing:/);
    assert.match(baseCss, /#app-header\s*\{/);
    assert.match(baseCss, /#app-footer\s*\{/);
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
    assert.match(gameController, /for \(const input of \[this\.#localModeInput, this\.#networkModeInput\]\)/);
    assert.match(gameController, /this\.#modeHandler\?\.\(input\.value\)/);
    assert.match(gameController, /registrationMode === "join" && !isSessionListed/);
    assert.match(gameController, /title: "Session not found"/);
    assert.match(sessionController, /this\.#session === null && !this\.#isLeaving/);
});

test("the landing page keeps canonical search metadata", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
    const canonicalUrl = "https://danieltongu.github.io/pick-2/";

    assert.match(html, /<title>Play Pick 2 \| Match cards\. Make moves<\/title>/);
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
    assert.match(sessionCss, /\[data-is-player-view="false"\] > #player-area/);
    assert.match(gameCss, /\.toggle-switch > label:has\(input:checked\) > span/);
    assert.match(controller, /setBooleanState\(this\.#playArea, "isPlayerView", true\)/);
    assert.match(controller, /setBooleanState\(this\.#playArea, "isPlayerView", false\)/);
    assert.doesNotMatch(controller, /#local-player|isTurnBound/);
});
