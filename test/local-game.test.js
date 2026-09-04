"use strict";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { Constants } from "../core/Constants.js";
import { Client, ClientEvents } from "../runtime/Client.js";
import { Host, HostChannel, HostConfig } from "../runtime/Host.js";

function createPeer(host, tabId = "test-tab") {
    const responses = [];
    const connection = host.open(new HostChannel(
        (response) => responses.push(response),
        () => {}
    ));
    return {
        connection,
        responses,
        async request(action, data = {}) {
            const firstResponse = responses.length;
            await connection.request({
                action,
                data: {tabId, sortKey: "none", ...data}
            });
            return responses.slice(firstResponse);
        }
    };
}

function latestGame(responses) {
    return responses.findLast((response) => response.view === Constants.VIEWS.ROOM)?.data;
}

function readJavaScriptSources(directory) {
    const sources = [];

    for (const entry of readdirSync(directory, {withFileTypes: true})) {
        const entryUrl = new URL(entry.name, directory);

        if (entry.isDirectory()) {
            sources.push(...readJavaScriptSources(new URL(`${entry.name}/`, directory)));
        } else if (entry.name.endsWith(".js")) {
            sources.push(readFileSync(entryUrl, "utf8"));
        }
    }

    return sources;
}

test("Host seeds configured bot players and leaves every remaining seat open", async () => {
    const host = new Host(new HostConfig("local", 0, false, false, true, null));
    const peer = createPeer(host);
    const home = (await peer.request(Constants.ACTIONS.LIST))
        .findLast((response) => response.view === Constants.VIEWS.HOME).data;

    assert.deepEqual(
        home.rooms.map(({roomName, playerLimit, playerCount}) => ({roomName, playerLimit, playerCount})),
        Constants.DEFAULT_ROOMS.map(({roomName, playerLimit, botCount}) => ({
            roomName,
            playerLimit,
            playerCount: botCount
        }))
    );
    assert.equal(home.mode, "local");
    assert.equal(home.capabilities.botFill, true);
    await peer.connection.close();
    await host.shutdown();
});

test("a custom local game fills its open seats with bots immediately", async () => {
    const host = new Host(new HostConfig("local", "fill", false, false, true, null));
    const peer = createPeer(host);
    const responses = await peer.request(Constants.ACTIONS.CREATE, {
        roomName: "Local Game",
        playerName: "Daniel",
        playerLimit: 4
    });
    const game = latestGame(responses);

    assert.equal(game.playerCount, 4);
    assert.equal(game.localPlayerName, "Daniel");
    assert.deepEqual(
        game.circle.players.map((player) => player.name),
        ["Daniel", ...Constants.LOCAL_OPPONENT_NAMES]
    );
    await peer.connection.close();
    await host.shutdown();
});

test("the shared Host rejects every join while a room is playing", async () => {
    const host = new Host(new HostConfig("network", 0, false, false, false, null));
    const owner = createPeer(host, "owner");
    const guest = createPeer(host, "guest");
    const lateGuest = createPeer(host, "late");

    await owner.request(Constants.ACTIONS.CREATE, {
        roomName: "Network Game",
        playerName: "Daniel",
        playerLimit: 3
    });
    await guest.request(Constants.ACTIONS.JOIN, {
        roomName: "Network Game",
        playerName: "Casey"
    });
    await owner.request(Constants.ACTIONS.START);
    const rejected = await lateGuest.request(Constants.ACTIONS.JOIN, {
        roomName: "Network Game",
        playerName: "Jordan"
    });

    assert.match(rejected.findLast((response) => response.message)?.message?.message ?? "", /in progress/i);
    await owner.connection.close();
    await guest.connection.close();
    await lateGuest.connection.close();
    await host.shutdown();
});

test("Host persistence stores only custom definitions through one small API", async () => {
    const calls = [];
    const store = {
        async load() {
            calls.push(["load"]);
            return [];
        },
        async save(definition) {
            calls.push(["save", definition]);
        },
        async remove(key) {
            calls.push(["remove", key]);
        }
    };
    const host = new Host(new HostConfig("local", "fill", false, false, true, store));
    const peer = createPeer(host, "owner");

    await peer.request(Constants.ACTIONS.CREATE, {
        roomName: "Saved Game",
        playerName: "Daniel",
        playerLimit: 3
    });
    const home = (await peer.request(Constants.ACTIONS.LEAVE))
        .findLast((response) => response.view === Constants.VIEWS.HOME).data;
    await peer.connection.close();

    assert.equal(home.rooms.some((room) => room.roomName === "Saved Game"), false);
    assert.deepEqual(calls[0], ["load"]);
    assert.deepEqual(calls.find(([type]) => type === "save")?.[1], {
        roomName: "Saved Game",
        playerLimit: 3,
        botCount: 2
    });
    assert.deepEqual(calls.find(([type]) => type === "remove"), ["remove", "saved-game"]);
    await host.shutdown();
});

test("Client adds shared fields to every endpoint request", () => {
    let callbacks;
    let request;
    const endpoint = {
        open(nextCallbacks) {
            callbacks = nextCallbacks;
            return {
                request(nextRequest) {
                    request = nextRequest;
                    return true;
                },
                close() {}
            };
        }
    };
    const client = new Client(endpoint);
    const statuses = [];
    const dataEvents = [];
    client.sortKey = "rank";
    client.open(new ClientEvents(
        {handleData() {}},
        (status) => statuses.push(status),
        (view, data) => dataEvents.push({view, data})
    ));

    assert.equal(client.request(Constants.ACTIONS.CREATE, {roomName: "Test"}), true);
    assert.equal(request.action, Constants.ACTIONS.CREATE);
    assert.equal(request.data.roomName, "Test");
    assert.equal(request.data.sortKey, "rank");
    assert.equal(typeof request.data.tabId, "string");

    callbacks.status("reconnecting", "Reconnecting…");
    callbacks.receive({view: Constants.VIEWS.ROOM, message: null, data: {version: 2}});
    assert.deepEqual(statuses, ["reconnecting"]);
    assert.deepEqual(dataEvents, [{view: Constants.VIEWS.ROOM, data: {version: 2}}]);
});

test("browser and Node runtime import graphs stay separate", () => {
    const host = readFileSync(new URL("../src/runtime/Host.js", import.meta.url), "utf8");
    const browser = readFileSync(new URL("../src/runtime/Browser.js", import.meta.url), "utf8");
    const networkClient = readFileSync(new URL("../src/runtime/NetworkClient.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../src/runtime/Network.js", import.meta.url), "utf8");

    assert.doesNotMatch(host, /from ["'](?:node:|express|ws)/);
    assert.doesNotMatch(host, /\b(?:document|localStorage|sessionStorage|WebSocket)\b/);
    assert.match(browser, /from "\.\/Host\.js"/);
    assert.doesNotMatch(browser, /from ["'](?:node:|express|ws)/);
    assert.doesNotMatch(networkClient, /from ["'](?:node:|express|ws)/);
    assert.match(network, /from "\.\/Host\.js"/);
    assert.match(network, /from "node:/);
    assert.match(network, /from "ws"/);
    assert.doesNotMatch(network, /\.\/Browser\.js|\.\/NetworkClient\.js/);
});

test("application source uses explicit, named control flow", () => {
    const source = readJavaScriptSources(new URL("../src/", import.meta.url)).join("\n");

    assert.doesNotMatch(source, /=>/);
    assert.doesNotMatch(source, /\boptions\s*=\s*\{\}/);
});

test("Local and Network modes share one Home page and one Room page", () => {
    const homeHtml = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const gameHtml = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../src/runtime/Network.js", import.meta.url), "utf8");
    const homeCss = readFileSync(
        new URL("../web/shared/styles/home.css", import.meta.url),
        "utf8"
    );

    assert.match(homeHtml, /<body data-page="home">/);
    assert.match(homeHtml, /id="registration-form"/);
    assert.match(homeHtml, /id="list-table-body"/);
    const sharedHeaderPattern = /<header id="app-header">\s*<h1>\s*<a id="app-home-link"[\s\S]*?<span class="brand-mark"[\s\S]*?<span class="brand-copy">[\s\S]*?<\/h1>\s*<aside id="connection-status"/;

    assert.match(homeHtml, sharedHeaderPattern);
    assert.match(gameHtml, sharedHeaderPattern);
    assert.equal(homeHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(homeHtml.match(/id="app-footer"/g)?.length, 1);
    assert.equal(gameHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(gameHtml.match(/id="app-footer"/g)?.length, 1);
    assert.match(homeHtml, /<aside[^>]+id="connection-status"[^>]+class="toggle-switch"[^>]+role="radiogroup"[^>]+data-status="connecting"/);
    assert.match(homeHtml, /<aside[^>]+id="connection-status"[^>]*>\s*<label>\s*<input id="local-mode-input"/);
    assert.match(homeHtml, /id="local-mode-input"[^>]+value="local"/);
    assert.match(homeHtml, /id="network-mode-input"[^>]+value="network"/);
    assert.doesNotMatch(homeHtml, /id="connection-status-indicator"/);
    assert.doesNotMatch(homeHtml, /id="play-mode-group"|id="local-room-note"|id="connection-status-label"/);
    assert.match(homeHtml, /id="request-mode-control"[^>]+class="toggle-switch"[^>]+role="radiogroup"/);
    assert.doesNotMatch(homeHtml, /<fieldset|id="mode-group"/);
    assert.match(homeHtml, /id="list-panel"/);
    assert.doesNotMatch(homeHtml, /id="(?:request-mode-control|list-panel)" hidden/);
    assert.match(homeHtml, /<tbody id="list-table-body">[\s\S]*?class="empty-row"/);
    assert.doesNotMatch(homeHtml, /id="guide-section"/);
    assert.match(gameHtml, /<body data-page="room">/);
    assert.match(homeHtml, /<article id="network-connection-view"[^>]+hidden>/);
    assert.match(gameHtml, /id="play-area"[^>]+data-status="waiting"[^>]+data-is-player-view="false"/);
    assert.match(gameHtml, /id="player-area"[^>]+data-is-turn-owner="false"[^>]+data-is-winner="false"/);
    assert.match(gameHtml, /id="player-summary"[\s\S]*?<span data-card-count="0"><\/span>/);
    assert.match(gameHtml, /class="playing-card-area" id="player-hand"/);
    assert.match(gameHtml, /class="playing-card-area" id="discard-pile"/);
    assert.doesNotMatch(gameHtml, /id="local-player-region"/);
    assert.match(gameHtml, /id="guide-section"/);
    assert.match(gameHtml, /<tr class="placeholder-row"[^>]*>[\s\S]*?<td>--<\/td>/);
    assert.doesNotMatch(gameHtml, /id="room-mode-label"|id="connection-status-indicator"/);
    assert.match(homeHtml, /\.\/src\/main\.js/);
    assert.doesNotMatch(homeHtml, /network-connection\.js/);
    assert.match(homeHtml, /<aside class="card-fan" aria-hidden="true"><\/aside>/);
    assert.match(
        homeHtml,
        /<header class="hero">\s*<section class="eyebrow">[\s\S]*?<section>\s*<aside>[\s\S]*?<aside class="card-fan"/
    );
    assert.match(
        homeCss,
        /\.hero > section:last-child\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/
    );
    assert.match(
        homeCss,
        /\.card-fan\s*\{[\s\S]*?position:\s*relative;/
    );
    assert.match(homeCss, /\.card-fan > playing-card\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(homeCss, /--card-rotation:\s*-24deg;/);
    assert.doesNotMatch(homeCss, /--fan-angle/);
    assert.match(main, /new Card\(VALUE\.TWO\.id, SUIT\.CLUBS, 0\)/);
    assert.match(main, /new Card\(VALUE\.EIGHT\.id, SUIT\.DIAMONDS, 0\)/);
    assert.match(main, /new Card\(VALUE\.JACK\.id, SUIT\.SPADES, 0\)/);
    assert.match(main, /new Card\(VALUE\.ACE\.id, SUIT\.HEARTS, 0\)/);
    assert.match(main, /\.sort\(compareCardScores\)/);
    assert.match(main, /PlayingCard\.create\(card, false\)/);
    assert.match(main, /element\.style\.removeProperty\("--card-rotation"\)/);
    assert.match(gameHtml, /\.\.\/src\/main\.js/);
    assert.match(homeHtml, /\.\/web\/shared\/styles\/home\.css/);
    assert.match(gameHtml, /\.\.\/web\/shared\/styles\/game\.css/);
    assert.match(homeHtml, /\.\/web\/shared\/styles\/base\.css/);
    assert.match(gameHtml, /\.\.\/web\/shared\/styles\/base\.css/);
    assert.match(homeHtml, /\.\/web\/shared\/styles\/table\.css/);
    assert.match(gameHtml, /\.\.\/web\/shared\/styles\/table\.css/);
    assert.ok(homeHtml.indexOf("styles/table.css") < homeHtml.indexOf("styles/home.css"));
    assert.ok(gameHtml.indexOf("styles/table.css") < gameHtml.indexOf("styles/room.css"));
    assert.doesNotMatch(homeHtml, /table-data\.css/);
    assert.doesNotMatch(gameHtml, /table-data\.css/);
    assert.doesNotMatch(homeHtml + gameHtml, /<caption\b/);
    assert.match(homeHtml, /<button id="enter-button">Enter game<\/button>/);
    assert.match(homeHtml, /<button id="alert-ok-button">OK<\/button>/);
    assert.match(gameHtml, /<button id="play-button">Play<\/button>/);
    assert.match(gameHtml, /<button id="invite-button" hidden>Invite<\/button>/);
    assert.match(gameHtml, /<button id="countdown-ok-button">OK<\/button>/);
    assert.match(gameHtml, /<button id="suit-selection-timeout-button">timeout<\/button>/);
    assert.match(gameHtml, /<button id="suit-selection-submit-button">Submit<\/button>/);
    assert.match(gameHtml, /<button id="results-dismiss-button">dismiss<\/button>/);
    assert.doesNotMatch(homeHtml + gameHtml, /id="(?:quick-start|core-rules|special-cards)"/);
    assert.match(main, /new Browser\(\)/);
    assert.match(main, /new NetworkClient/);
    assert.match(network, /game\/index\.html/);
    assert.match(network, /\["\/game", "\/game\/", "\/game\/index\.html"\]/);
    assert.doesNotMatch(network, /network\/index\.html/);
    assert.doesNotMatch(network, /\["\/network", "\/network\/", "\/network\/index\.html"\]/);
    assert.doesNotMatch(network, /response\.redirect\([^)]*\/(?:room|game)/);
    assert.doesNotMatch(network, /web\/network/);
});

test("the finished dialog opens once per finish and clears for a new game", () => {
    const controller = readFileSync(new URL("../src/ui/RoomController.js", import.meta.url), "utf8");
    const resultsController = readFileSync(new URL("../src/ui/ResultsController.js", import.meta.url), "utf8");

    assert.match(
        controller,
        /previousStatus !== Constants\.STATUS\.FINISHED[\s\S]*?nextStatus === Constants\.STATUS\.FINISHED[\s\S]*?#resultsController\.show\(room\)/
    );
    assert.match(
        controller,
        /localPlayer === null \|\| nextStatus !== Constants\.STATUS\.FINISHED[\s\S]*?#resultsController\.hide\(\)/
    );
    assert.match(
        resultsController,
        /hide\(\)\s*\{[\s\S]*?#players = \[\];[\s\S]*?#statsBody\.replaceChildren\(\);[\s\S]*?#selectedPlayerCards\.replaceChildren\(\);[\s\S]*?super\.hide\(\)/
    );
});

test("the shared table stylesheet owns foundational row states", () => {
    const baseCss = readFileSync(new URL("../web/shared/styles/base.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../web/shared/styles/home.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../web/shared/styles/room.css", import.meta.url), "utf8");
    const overlaysCss = readFileSync(new URL("../web/shared/styles/overlays.css", import.meta.url), "utf8");
    const tableCss = readFileSync(new URL("../web/shared/styles/table.css", import.meta.url), "utf8");

    assert.doesNotMatch(baseCss, /^(?:table|th|td|tbody tr|\.table-container)\b/m);
    for (const componentCss of [homeCss, gameCss, overlaysCss]) {
        assert.doesNotMatch(componentCss, /\b(?:th|td)\s*\{[^}]*\bborder(?:-\w+)?:/);
        assert.doesNotMatch(componentCss, /tbody tr(?::is\([^)]*\)|:(?:hover|focus-visible)|\[data-is-selected="true"\])\s*\{/);
    }
    assert.match(tableCss, /table:has\(> tbody:empty\)::after\s*\{/);
    assert.match(tableCss, /tr\s*\{[\s\S]*?border-bottom:\s*1px solid rgba\(255, 255, 255, \.08\)/);
    assert.match(tableCss, /tbody tr:is\(:hover, :focus-visible\)\s*\{[\s\S]*?background:\s*rgb\(0 255 255 \/ \.12\)/);
    assert.match(tableCss, /tbody tr:focus-visible\s*\{[\s\S]*?outline-offset:\s*-3px/);
    assert.match(tableCss, /tbody tr\[data-is-selected="true"\]\s*\{\s*color:\s*cyan;\s*\}/);
    assert.match(tableCss, /th\s*\{[\s\S]*?font-size:\s*9px;[\s\S]*?font-weight:\s*800;[\s\S]*?letter-spacing:\s*\.1em;/);
    assert.doesNotMatch(homeCss + gameCss + overlaysCss, /--table-heading-(?:color|font-size|font-weight|letter-spacing)/);
});

test("responsive styles are mobile-first with one tablet and desktop stage", () => {
    const styleNames = [
        "base.css",
        "home.css",
        "room.css"
    ];

    for (const styleName of styleNames) {
        const css = readFileSync(new URL(`../web/shared/styles/${styleName}`, import.meta.url), "utf8");
        assert.doesNotMatch(css, /@media\s*\(max-width:/);
        assert.equal(css.match(/@media\s*\(min-width:\s*721px\)/g)?.length, 1);
    }

    const html = ["../room.html"]
        .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
        .join("\n");
    const baseCss = readFileSync(new URL("../web/shared/styles/base.css", import.meta.url), "utf8");

    assert.doesNotMatch(html, /styles\/(?:tokens|app-footer|app-header)\.css/);
    assert.match(baseCss, /:root\s*\{[\s\S]*?--container-spacing:/);
    assert.match(baseCss, /#app-header\s*\{/);
    assert.match(baseCss, /#app-footer\s*\{/);
});

test("shared controllers depend on Client vocabulary rather than runtime services", () => {
    const homeController = readFileSync(new URL("../src/ui/HomeController.js", import.meta.url), "utf8");
    const gameController = readFileSync(new URL("../src/ui/RoomController.js", import.meta.url), "utf8");

    for (const source of [homeController, gameController]) {
        assert.doesNotMatch(source, /Static|ConnectionService|LocalGameService|ServerSessionController/);
        assert.match(source, /this\.client/);
    }

    assert.match(homeController, /row\.addEventListener\("click"/);
    assert.match(homeController, /row\.addEventListener\("keydown"/);
    assert.match(homeController, /row\.tabIndex = 0/);
    assert.match(homeController, /Constants\.ACTIONS\.VIEW, \{roomName\}/);
    assert.doesNotMatch(homeController, /this\.#capabilities\.viewers === true/);
    assert.match(homeController, /cell\.textContent = "No games available\."/);
    assert.match(homeController, /for \(const input of \[this\.#localModeInput, this\.#networkModeInput\]\)/);
    assert.match(homeController, /input\.value/);
    assert.match(homeController, /registrationMode === "join" && !isGameListed/);
    assert.match(homeController, /title: "Game not found"/);
    assert.match(gameController, /this\.#game === null && !this\.#isLeaving/);
});

test("the landing page keeps canonical search metadata", () => {
    const html = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
    const canonicalUrl = "https://danieltongu.github.io/pick-2/";

    assert.match(html, /<title>Play Pick 2 \| Match cards\. Make moves<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}">`));
    assert.match(sitemap, new RegExp(`<loc>${canonicalUrl}<\\/loc>`));
});

test("the shared game preserves touch-friendly card presentation", () => {
    const html = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const cardCss = readFileSync(new URL("../web/shared/styles/playing-card.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../web/shared/styles/room.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../web/shared/styles/home.css", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../src/ui/LocalPlayerController.js", import.meta.url), "utf8");

    assert.doesNotMatch(html, /id="card-size-range"/);
    assert.match(cardCss, /--card-size:\s*100cqh/);
    assert.match(cardCss, /\.playing-card-drag-handle\s*\{[\s\S]*?width:\s*100%/);
    assert.match(cardCss, /\.playing-card-area:not\(#discard-pile\)[\s\S]*overflow-x:\s*auto/);
    assert.match(gameCss, /@keyframes turn-owner-border-strobe/);
    assert.match(gameCss, /\[data-is-player-view="false"\] > #player-area/);
    assert.match(homeCss, /\.toggle-switch > label:has\(input:checked\) > span/);
    assert.match(controller, /setBooleanState\(this\.#playArea, "isPlayerView", true\)/);
    assert.match(controller, /setBooleanState\(this\.#playArea, "isPlayerView", false\)/);
    assert.doesNotMatch(controller, /#local-player|isTurnBound/);
});
