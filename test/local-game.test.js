import { Game } from "../core/Game.js";
("use strict");

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { Constants } from "../core/Constants.js";
import { Client } from "../runtime/Client.js";
import { ClientEvents } from "../runtime/Client.js";
import { Host, HostChannel, HostConfig } from "../runtime/Host.js";

function createPeer(host, tabId = "test-tab") {
    const responses = [];
    const connection = host.open(
        new HostChannel(
            (response) => responses.push(response),
            () => {}
        )
    );
    return {
        connection,
        responses,
        async request(action, data = {}) {
            const firstResponse = responses.length;
            await connection.request({
                action,
                data: { tabId, sortKey: "none", ...data }
            });
            return responses.slice(firstResponse);
        }
    };
}

function latestGame(responses) {
    return responses.findLast((response) => response.view === Constants.VIEWS.ROOM)?.data;
}

for (const mode of ["direct", "hosted"]) {
    test(`${mode} returns use authenticated membership and broadcast the updated hand`, async (t) => {
        const host = new Host(new HostConfig(mode, 0, false, false, false, null), new Game());
        t.after(() => host.shutdown());
        const owner = createPeer(host, "owner");
        const viewer = createPeer(host, "viewer");
        await owner.request(Constants.ACTIONS.CREATE, { roomName: "Return Flow", playerName: "Alice", playerLimit: 2 });
        await viewer.request(Constants.ACTIONS.VIEW, { roomName: "Return Flow" });
        const drawn = latestGame(await owner.request(Constants.ACTIONS.DRAW));
        const card = drawn.turnOrder.actors.find((player) => player.name === "Alice").collection.items[0];
        await owner.request(Constants.ACTIONS.DISCARD, { card });

        const rejected = await viewer.request(Constants.ACTIONS.RETURN, { card, playerName: "Alice" });
        assert.match(rejected.findLast((response) => response.message)?.message.message ?? "", /Join the room/);
        const spectatorStart = viewer.responses.length;
        const result = latestGame(await owner.request(Constants.ACTIONS.RETURN, { card, playerName: "Someone Else" }));
        const player = result.turnOrder.actors.find((entry) => entry.name === "Alice");
        assert.equal(player.collection.items.length, 1);
        assert.deepEqual(player.collection.items[0], card);
        assert.equal(player.collection.score, card.score);
        assert.equal(
            result.collections.play.items.some((entry) => entry.value === card.value && entry.suit === card.suit),
            false
        );
        const spectator = latestGame(viewer.responses.slice(spectatorStart));
        assert.ok(spectator);
        assert.equal(spectator.localActorName, null);
        assert.equal(spectator.turnOrder.actors.find((entry) => entry.name === "Alice").collection.items.length, 1);
        assert.deepEqual(spectator.collections.play.items, result.collections.play.items);
    });
}

function readJavaScriptSources(directory) {
    const sources = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
    const host = new Host(new HostConfig("direct", 0, false, false, true, null), new Game());
    const peer = createPeer(host);
    const home = (await peer.request(Constants.ACTIONS.LIST)).findLast(
        (response) => response.view === Constants.VIEWS.HOME
    ).data;

    assert.deepEqual(
        home.rooms.map((room) => ({
            name: room.name,
            actorLimit: room.actorLimit,
            actorCount: room.turnOrder.actorCount
        })),
        Constants.DEFAULT_ROOMS.map(({ roomName, playerLimit, botCount }) => ({
            name: roomName,
            actorLimit: playerLimit,
            actorCount: botCount
        }))
    );
    assert.equal(home.mode, "direct");
    assert.equal(home.capabilities.botFill, true);
    await peer.connection.close();
    await host.shutdown();
});

test("a custom local game fills its open seats with bots immediately", async () => {
    const host = new Host(new HostConfig("direct", "fill", false, false, true, null), new Game());
    const peer = createPeer(host);
    const responses = await peer.request(Constants.ACTIONS.CREATE, {
        roomName: "Local Game",
        playerName: "Daniel",
        playerLimit: 4
    });
    const game = latestGame(responses);

    assert.equal(game.turnOrder.actorCount, 4);
    assert.equal(game.localActorName, "Daniel");
    assert.deepEqual(
        game.turnOrder.actors.map((player) => player.name),
        ["Daniel", ...Constants.DIRECT_OPPONENT_NAMES]
    );
    await peer.connection.close();
    await host.shutdown();
});

test("the shared Host rejects every join while a room is playing", async () => {
    const host = new Host(new HostConfig("hosted", 0, false, false, false, null), new Game());
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

test("a player can leave a hosted room while it is playing", async () => {
    const host = new Host(new HostConfig("hosted", 0, false, false, false, null), new Game());
    const owner = createPeer(host, "owner");
    const guest = createPeer(host, "guest");

    await owner.request(Constants.ACTIONS.CREATE, {
        roomName: "Active Room",
        playerName: "Daniel",
        playerLimit: 3
    });
    await guest.request(Constants.ACTIONS.JOIN, {
        roomName: "Active Room",
        playerName: "Casey"
    });
    await owner.request(Constants.ACTIONS.START);

    const homeResponses = await guest.request(Constants.ACTIONS.LEAVE);
    const home = homeResponses.findLast((response) => response.view === Constants.VIEWS.HOME);

    assert.ok(home);
    const activeRoom = home.data.rooms.find((room) => room.name === "Active Room");

    assert.ok(activeRoom);
    assert.equal(activeRoom.turnOrder.actorCount, 1);
    await owner.connection.close();
    await guest.connection.close();
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
    const host = new Host(new HostConfig("direct", "fill", false, false, true, store), new Game());
    const peer = createPeer(host, "owner");

    await peer.request(Constants.ACTIONS.CREATE, {
        roomName: "Saved Game",
        playerName: "Daniel",
        playerLimit: 3
    });
    const home = (await peer.request(Constants.ACTIONS.LEAVE)).findLast(
        (response) => response.view === Constants.VIEWS.HOME
    ).data;
    await peer.connection.close();

    assert.equal(
        home.rooms.some((room) => room.name === "Saved Game"),
        false
    );
    assert.deepEqual(calls[0], ["load"]);
    assert.deepEqual(calls.find(([type]) => type === "save")?.[1], {
        roomName: "Saved Game",
        playerLimit: 3,
        botCount: 2
    });
    assert.deepEqual(
        calls.find(([type]) => type === "remove"),
        ["remove", "saved-game"]
    );
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
    client.open(
        new ClientEvents(
            { handleData() {} },
            (status) => statuses.push(status),
            (view, data) => dataEvents.push({ view, data })
        )
    );

    assert.equal(client.request(Constants.ACTIONS.CREATE, { roomName: "Test" }), true);
    assert.equal(request.action, Constants.ACTIONS.CREATE);
    assert.equal(request.data.roomName, "Test");
    assert.equal(request.data.sortKey, "rank");
    assert.equal(typeof request.data.tabId, "string");

    callbacks.status("reconnecting", "Reconnecting…");
    callbacks.receive({ view: Constants.VIEWS.ROOM, message: null, data: { version: 2 } });
    assert.deepEqual(statuses, ["reconnecting"]);
    assert.deepEqual(dataEvents, [{ view: Constants.VIEWS.ROOM, data: { version: 2 } }]);
});

test("browser and Node runtime import graphs stay separate", () => {
    const host = readFileSync(new URL("../runtime/Host.js", import.meta.url), "utf8");
    const browser = readFileSync(new URL("../runtime/Browser.js", import.meta.url), "utf8");
    const networkClient = readFileSync(new URL("../runtime/NetworkClient.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../runtime/Network.js", import.meta.url), "utf8");

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
    const source = [
        readFileSync(new URL("../index.js", import.meta.url), "utf8"),
        readJavaScriptSources(new URL("../core/", import.meta.url)).join("\n"),
        readJavaScriptSources(new URL("../runtime/", import.meta.url)).join("\n"),
        readJavaScriptSources(new URL("../ui/", import.meta.url)).join("\n")
    ].join("\n");

    assert.doesNotMatch(source, /=>/);
    assert.doesNotMatch(source, /\boptions\s*=\s*\{\}/);
});

test("Direct and Hosted modes share one Home page and one Room page", () => {
    const homeHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const homeTemplate = homeHtml;
    const homeMarkup = homeHtml;
    const gameHtml = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const roomPageHtml = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const main =
        readFileSync(new URL("../index.js", import.meta.url), "utf8") +
        readFileSync(new URL("../ui/GameApplication.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../runtime/Network.js", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8");

    assert.match(homeHtml, /<body data-game="pick2" data-page="home">/);
    assert.doesNotMatch(homeHtml, /pick-2-shared-root/);
    assert.match(homeHtml, /<main class="site-shell">/);
    assert.match(homeTemplate, /id="registration-form"/);
    assert.match(homeTemplate, /id="list-table-body"/);
    const homeDecoration = readFileSync(new URL("../ui/controllers/HomeController.js", import.meta.url), "utf8");
    const sharedHeaderPattern =
        /<header id="app-header">\s*<h1>\s*<a id="app-home-link"[\s\S]*?<span class="brand-mark"[\s\S]*?<span class="brand-copy"[^>]*>[\s\S]*?<\/h1>\s*<aside\s+[^>]*data-status="connecting"/;

    assert.match(homeTemplate, sharedHeaderPattern);
    assert.match(gameHtml, sharedHeaderPattern);
    assert.equal(homeTemplate.match(/id="app-header"/g)?.length, 1);
    assert.equal(homeTemplate.match(/id="app-footer"/g)?.length, 1);
    assert.equal(gameHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(gameHtml.match(/id="app-footer"/g)?.length, 1);
    assert.match(homeTemplate, /<aside[^>]+class="toggle-switch"[^>]+data-status="connecting"/);
    assert.match(homeTemplate, /<aside[^>]+data-status="connecting"[^>]*>\s*<label>\s*<input id="direct-mode-input"/);
    assert.match(homeTemplate, /id="direct-mode-input"[^>]+value="direct"/);
    assert.match(homeTemplate, /id="hosted-mode-input"[^>]+value="hosted"/);
    assert.doesNotMatch(homeTemplate, /id="connection-status-indicator"/);
    assert.doesNotMatch(homeTemplate, /id="play-mode-group"|id="local-room-note"|id="connection-status-label"/);
    assert.match(homeTemplate, /id="request-mode-control"[^>]+class="toggle-switch"[^>]+role="radiogroup"/);
    assert.doesNotMatch(homeTemplate, /<fieldset|id="mode-group"/);
    assert.match(homeTemplate, /id="list-panel"/);
    assert.doesNotMatch(homeTemplate, /id="(?:request-mode-control|list-panel)" hidden/);
    assert.match(homeTemplate, /<tbody id="list-table-body">[\s\S]*?class="empty-row"/);
    assert.doesNotMatch(homeMarkup, /id="game-guide"/);
    assert.match(gameHtml, /data-game-region="view"/);
    assert.doesNotMatch(gameHtml, /pick-2-shared-root/);
    assert.match(homeTemplate, /<article\s+[^>]*id="network-connection-view"[^>]*hidden\s*>/);
    assert.match(gameHtml, /data-game-region="view"[^>]+data-mode="direct"[^>]+data-state="waiting"/);
    assert.match(gameHtml, /data-is-turn-owner="false"[^>]+data-is-winner="false"/);
    assert.match(
        gameHtml,
        /id="player-summary"[\s\S]*?<span data-actor-name="" id="player-status"><\/span>[\s\S]*?<span data-item-count="0"><\/span>/
    );
    assert.match(gameHtml, /id="player-hand"/);
    assert.match(gameHtml, /id="table-play-area"[\s\S]*?data-is-drag-over="false"/);
    assert.match(gameHtml, /id="player-hand"[\s\S]*?data-is-drag-over="false"/);
    assert.match(
        gameHtml,
        /id="player-hand"[\s\S]*?<span class="playing-card-area" data-is-drag-over="false"><\/span>/
    );
    assert.doesNotMatch(gameHtml, /id="local-player-region"/);
    assert.match(gameHtml, /<details id="game-guide" open>/);
    assert.match(gameHtml, /id="room-guide-link" href="#game-guide"/);
    assert.doesNotMatch(gameHtml, /data-game-region="guide"|id="guide-section"/);
    assert.match(gameHtml, /<tr class="placeholder-row"[^>]*>[\s\S]*?<td>--<\/td>/);
    assert.doesNotMatch(gameHtml, /id="room-mode-label"|id="connection-status-indicator"/);
    assert.match(homeHtml, /src="index\.js"/);
    assert.doesNotMatch(homeMarkup, /network-connection\.js/);
    assert.match(homeTemplate, /<aside>\s*<span data-game-preview aria-hidden="true"><\/span>\s*<\/aside>/);
    assert.match(
        homeTemplate,
        /<header class="hero">\s*<section class="eyebrow">[\s\S]*?<section>\s*<aside>[\s\S]*?<aside>\s*<span data-game-preview/
    );
    assert.match(homeCss, /\.hero > section:last-child\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/);
    const cardCss =
        readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8") +
        readFileSync(new URL("../ui/styles/preview-fan.css", import.meta.url), "utf8");
    assert.match(cardCss, /\[data-game-preview\]\s*\{[\s\S]*?position:\s*relative;/);
    assert.match(cardCss, /\[data-game-preview\]\s*\{[\s\S]*?display:\s*block;/);
    assert.match(cardCss, /\[data-game-preview\] > playing-card\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(cardCss, /--card-rotation:\s*-24deg;/);
    assert.match(homeCss, /data-game-preview/);
    assert.match(homeDecoration, /new Card\(VALUE\.TWO\.id, SUIT\.CLUBS, 0\)/);
    assert.match(homeDecoration, /new Card\(VALUE\.EIGHT\.id, SUIT\.DIAMONDS, 0\)/);
    assert.match(homeDecoration, /new Card\(VALUE\.JACK\.id, SUIT\.SPADES, 0\)/);
    assert.match(homeDecoration, /new Card\(VALUE\.ACE\.id, SUIT\.HEARTS, 0\)/);
    assert.match(homeDecoration, /\.sort\(compareCardScores\)/);
    assert.match(homeDecoration, /PlayingCard\.create\(card\)/);
    assert.match(homeDecoration, /element\.rotation = null/);
    assert.match(roomPageHtml, /src="index\.js"/);
    assert.match(homeHtml, /href="ui\/styles\/home\.css"/);
    assert.match(roomPageHtml, /href="\.\/ui\/styles\/room\.css"/);
    assert.doesNotMatch(main, /pick2\/ui\/styles\/room\.css/);
    assert.match(homeHtml, /href="ui\/styles\/base\.css"/);
    assert.match(roomPageHtml, /href="\.\/ui\/styles\/base\.css"/);
    assert.match(homeHtml, /href="ui\/styles\/table\.css"/);
    assert.match(roomPageHtml, /href="\.\/ui\/styles\/table\.css"/);
    assert.ok(homeHtml.indexOf("styles/table.css") < homeHtml.indexOf("styles/preview-fan.css"));
    assert.ok(roomPageHtml.indexOf("styles/table.css") < roomPageHtml.indexOf("styles/room.css"));
    assert.doesNotMatch(homeHtml, /table-data\.css/);
    assert.doesNotMatch(gameHtml, /table-data\.css/);
    assert.doesNotMatch(homeMarkup + gameHtml, /<caption\b/);
    assert.match(homeTemplate, /<button id="enter-button">Enter room<\/button>/);
    assert.match(homeTemplate, /<button id="alert-ok-button">OK<\/button>/);
    assert.match(gameHtml, /<button id="room-play-button" type="button">Play<\/button>/);
    assert.match(gameHtml, /<button id="room-invite-button" type="button" hidden>Invite<\/button>/);
    assert.match(gameHtml, /<button id="countdown-ok-button">OK<\/button>/);
    assert.match(gameHtml, /<button id="suit-selection-timeout-button">timeout<\/button>/);
    assert.match(gameHtml, /<button id="suit-selection-submit-button">Submit<\/button>/);
    assert.match(gameHtml, /<button id="results-dismiss-button">dismiss<\/button>/);
    assert.doesNotMatch(homeHtml + gameHtml, /id="(?:quick-start|core-rules|special-cards)"/);
    assert.match(main, /new Browser\(new this\.GameType\(\)\)/);
    assert.match(main, /new NetworkClient/);
    assert.match(main, /new GameApplicationConfig\(Game, Client, HomeController, RoomController, GuideController\)/);
    assert.match(network, /app\.use\(express\.static\(repositoryPath\)\)/);
    assert.match(network, /path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\)/);
    assert.doesNotMatch(network, /"\.\.\/\.\."/);
    assert.doesNotMatch(network, /network\/index\.html/);
    assert.doesNotMatch(network, /\["\/network", "\/network\/", "\/network\/index\.html"\]/);
    assert.doesNotMatch(network, /response\.redirect\([^)]*\/(?:room|game)/);
    assert.doesNotMatch(network, /web\/network/);
});

test("the finished dialog opens once per finish and clears for a new game", () => {
    const controller = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const resultsController = readFileSync(new URL("../ui/controllers/ResultsController.js", import.meta.url), "utf8");

    assert.match(
        controller,
        /previousState !== Constants\.ROOM_STATE\.FINISHED[\s\S]*?nextState === Constants\.ROOM_STATE\.FINISHED[\s\S]*?#resultsController\.show\(room\)/
    );
    assert.match(
        controller,
        /localPlayer === null \|\| nextState !== Constants\.ROOM_STATE\.FINISHED[\s\S]*?#resultsController\.hide\(\)/
    );
    assert.match(
        resultsController,
        /hide\(\)\s*\{[\s\S]*?#actors = \[\];[\s\S]*?#statsBody\.replaceChildren\(\);[\s\S]*?#selectedActorItems\.replaceChildren\(\);[\s\S]*?super\.hide\(\)/
    );
});

test("the shared table stylesheet owns foundational row states", () => {
    const baseCss = readFileSync(new URL("../ui/styles/base.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../ui/styles/room.css", import.meta.url), "utf8");
    const overlaysCss =
        readFileSync(new URL("../ui/styles/dialogs.css", import.meta.url), "utf8") +
        readFileSync(new URL("../ui/styles/overlays.css", import.meta.url), "utf8");
    const tableCss = readFileSync(new URL("../ui/styles/table.css", import.meta.url), "utf8");

    assert.doesNotMatch(baseCss, /^(?:table|th|td|tbody tr|\.table-container)\b/m);
    for (const componentCss of [homeCss, gameCss, overlaysCss]) {
        assert.doesNotMatch(componentCss, /\b(?:th|td)\s*\{[^}]*\bborder(?:-\w+)?:/);
        assert.doesNotMatch(
            componentCss,
            /tbody tr(?::is\([^)]*\)|:(?:hover|focus-visible)|\[data-is-selected="true"\])\s*\{/
        );
    }
    assert.match(tableCss, /table:has\(> tbody:empty\)::after\s*\{/);
    assert.match(
        tableCss,
        /tr\s*\{[\s\S]*?border-bottom:\s*1px solid color-mix\(in srgb, var\(--white\) 8%, transparent\)/
    );
    assert.match(
        tableCss,
        /tbody tr:is\(:hover, :focus-visible\)\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--cyan\) 12%, transparent\)/
    );
    assert.match(tableCss, /tbody tr:focus-visible\s*\{[\s\S]*?outline-offset:\s*-3px/);
    assert.match(tableCss, /tbody tr\[data-is-selected="true"\]\s*\{\s*color:\s*var\(--cyan\);\s*\}/);
    assert.match(
        tableCss,
        /th\s*\{[\s\S]*?font-size:\s*9px;[\s\S]*?font-weight:\s*800;[\s\S]*?letter-spacing:\s*0\.1em;/
    );
    assert.doesNotMatch(
        homeCss + gameCss + overlaysCss,
        /--table-heading-(?:color|font-size|font-weight|letter-spacing)/
    );
});

test("responsive styles are mobile-first with one tablet and desktop stage", () => {
    const styleNames = ["../ui/styles/base.css", "../ui/styles/home.css", "../ui/styles/room.css"];

    for (const styleName of styleNames) {
        const css = readFileSync(new URL(styleName, import.meta.url), "utf8");
        assert.doesNotMatch(css, /@media\s*\(max-width:/);
        assert.equal(css.match(/@media\s*\(min-width:\s*721px\)/g)?.length, 1);
    }

    const html = ["../room.html"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    const baseCss = readFileSync(new URL("../ui/styles/base.css", import.meta.url), "utf8");

    assert.doesNotMatch(html, /styles\/(?:tokens|app-footer|app-header)\.css/);
    assert.match(baseCss, /:root\s*\{[\s\S]*?--container-spacing:/);
    assert.match(baseCss, /#app-header\s*\{/);
    assert.match(baseCss, /#app-footer\s*\{/);
});

test("page controllers depend on Client vocabulary rather than runtime services", () => {
    const homeController = readFileSync(new URL("../ui/controllers/HomeController.js", import.meta.url), "utf8");
    const gameController = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");

    for (const source of [homeController, gameController]) {
        assert.doesNotMatch(source, /Static|ConnectionService|LocalGameService|ServerSessionController/);
        assert.match(source, /this\.client/);
    }

    assert.match(homeController, /row\.addEventListener\("click"/);
    assert.match(homeController, /row\.addEventListener\("keydown"/);
    assert.match(homeController, /row\.tabIndex = 0/);
    assert.match(homeController, /Constants\.ACTIONS\.VIEW, \{\s*roomName\s*\}/);
    assert.doesNotMatch(homeController, /this\.#capabilities\.viewers === true/);
    assert.match(homeController, /cell\.textContent = "No rooms available\."/);
    assert.match(homeController, /for \(const input of \[this\.#directModeInput, this\.#hostedModeInput\]\)/);
    assert.match(homeController, /input\.value/);
    assert.match(homeController, /registrationMode === "join" && !isGameListed/);
    assert.match(homeController, /title: "Room not found"/);
    assert.match(gameController, /this\.room === null && !this\.#isLeaving/);
});

test("the landing page keeps canonical search metadata", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
    const canonicalUrl = "https://danieltongu.github.io/pick-2/";

    assert.match(html, /<title>Play Pick 2 Online \| Card Game<\/title>/);
    assert.match(html, /<meta\s+name="description"\s+content="[^"]+"\s*\/>/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}" \\/>`));
    assert.match(sitemap, new RegExp(`<loc>${canonicalUrl}<\\/loc>`));
});

test("the shared game preserves touch-friendly card presentation", () => {
    const html = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const cardCss =
        readFileSync(new URL("../ui/styles/playing-card.css", import.meta.url), "utf8") +
        readFileSync(new URL("../ui/styles/room.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../ui/styles/room.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../ui/controllers/LocalPlayerController.js", import.meta.url), "utf8");
    assert.match(controller, /"#player-hand > \[data-is-drag-over\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-actor-name\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-item-count\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-draw-allowance\]", HTMLSpanElement/);
    assert.match(controller, /querySelector\("\[data-idle-seconds\]"\)/);
    assert.doesNotMatch(controller, /"#player-status"|"#draw-button > span"|"#player-idle-warning > em"/);

    assert.doesNotMatch(html, /id="card-size-range"/);
    assert.match(cardCss, /--card-height:\s*max\(100cqh, var\(--card-height-min\)\)/);
    assert.match(cardCss, /\.playing-card-drag-handle\s*\{[\s\S]*?width:\s*100%/);
    assert.match(gameCss, /@keyframes turn-owner-border-strobe/);
    assert.match(homeCss, /\.toggle-switch > label:has\(input:checked\) > span/);
    assert.match(controller, /this\.#gameRegion\.dataset\.gameRegion = "act"/);
    assert.match(controller, /this\.#gameRegion\.dataset\.gameRegion = "view"/);
    assert.match(controller, /this\.#playerStatus\.dataset\.actorName = actor\.name \?\? ""/);
    assert.match(controller, /this\.#playerStatus\.dataset\.actorName = ""/);
    assert.doesNotMatch(html + controller + gameCss, /data-is-player-view|isPlayerView/);
    assert.match(html, /id="opponent-list"[\s\S]*?id="table-play-area"[\s\S]*?id="actor-region"/);
    assert.match(html, /<ul id="opponent-list" aria-label="Other players"><\/ul>/);
    assert.doesNotMatch(html, /id="opponent-list"[^>]*role=/);
    assert.match(
        readFileSync(new URL("../ui/templates/opponent.html", import.meta.url), "utf8"),
        /<li data-actor-name=/
    );
    assert.doesNotMatch(
        readFileSync(new URL("../ui/templates/opponent.html", import.meta.url), "utf8"),
        /role="listitem"/
    );
    assert.match(gameCss, /\[data-game-region="view"\]\s*\{[\s\S]*?--play-area-rows:/);
    assert.match(gameCss, /\[data-game-region="view"\] #actor-region\s*\{[\s\S]*?display:\s*none/);
    assert.doesNotMatch(gameCss, /\[data-game-region="view"\][^{]*#table-play-area[^{]*\{[^}]*--card-height/);
    assert.match(gameCss, /\[data-game-region="act"\]\[data-mode="direct"\] #player-idle-warning/);
    assert.match(
        readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8"),
        /playRegion\.dataset\.mode = room\.mode/
    );
    assert.doesNotMatch(
        readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8"),
        /idleWarning\.hidden/
    );
    assert.doesNotMatch(controller, /#local-player|isTurnBound/);
});
