("use strict");

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { Constants } from "../core/Constants.js";
import { Session } from "../ui/Session.js";
import { Host } from "../host/Host.js";
import { HostConnection } from "../host/HostConnection.js";

function createConnection(host, tabId = "test-tab") {
    const responses = [];
    const connection = host.accept((response) => responses.push(response), () => {});
    return {
        connection,
        responses,
        async request(command, data = {}) {
            const firstResponse = responses.length;
            await connection.receive({
                command,
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
    test(`${mode} rejects the removed discard-to-hand command`, async (t) => {
        const host = new Host(mode, 0, false);
        t.after(() => host.shutdown());
        const owner = createConnection(host, "owner");
        await owner.request(Constants.COMMANDS.CREATE, { roomName: "Discard Flow", actorName: "Alice", actorLimit: 2 });
        const drawn = latestGame(await owner.request(Constants.COMMANDS.DRAW));
        const card = drawn.match.turnOrder.actors.find((actor) => actor.name === "Alice").collection.items[0];
        const discarded = latestGame(await owner.request(Constants.COMMANDS.DISCARD, { card }));
        assert.equal(discarded.match.collections.play.items.length, 1);

        const rejected = await owner.request("return", { card });
        assert.match(rejected.findLast((response) => response.message)?.message.message ?? "", /Unknown command/);
        const current = latestGame(await owner.request(Constants.COMMANDS.LIST)) ?? discarded;
        assert.equal(current.match.turnOrder.actors.find((actor) => actor.name === "Alice").collection.items.length, 0);
        assert.deepEqual(current.match.collections.play.items[0], card);
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

test("Host seeds configured bot actors and leaves every remaining seat open", async () => {
    const host = new Host("direct", 0, false);
    const connection = createConnection(host);
    const home = (await connection.request(Constants.COMMANDS.LIST)).findLast(
        (response) => response.view === Constants.VIEWS.HOME
    ).data;

    assert.deepEqual(
        home.rooms.map((room) => ({
            name: room.name,
            actorLimit: room.actorLimit,
            actorCount: room.match.turnOrder.actorCount
        })),
        Constants.DEFAULT_ROOMS.map(({ roomName, actorLimit, botCount }) => ({
            name: roomName,
            actorLimit: actorLimit,
            actorCount: botCount
        }))
    );
    assert.equal(home.connectionMode, "direct");
    assert.equal(home.capabilities.botFill, false);
    await connection.connection.close();
    await host.shutdown();
});

test("a custom local game fills its open seats with bots immediately", async () => {
    const host = new Host("direct", "fill", false);
    const connection = createConnection(host);
    const responses = await connection.request(Constants.COMMANDS.CREATE, {
        roomName: "Local Game",
        actorName: "Daniel",
        actorLimit: 4
    });
    const game = latestGame(responses);

    assert.equal(game.match.turnOrder.actorCount, 4);
    assert.equal(game.localActorName, "Daniel");
    assert.deepEqual(
        game.match.turnOrder.actors.map((actor) => actor.name),
        ["Daniel", ...Constants.DIRECT_OPPONENT_NAMES]
    );
    await connection.connection.close();
    await host.shutdown();
});

test("the shared Host rejects every join while a room is playing", async () => {
    const host = new Host("hosted", 0, false);
    const owner = createConnection(host, "owner");
    const guest = createConnection(host, "guest");
    const lateGuest = createConnection(host, "late");

    await owner.request(Constants.COMMANDS.CREATE, {
        roomName: "Network Game",
        actorName: "Daniel",
        actorLimit: 3
    });
    await guest.request(Constants.COMMANDS.JOIN, {
        roomName: "Network Game",
        actorName: "Casey"
    });
    await owner.request(Constants.COMMANDS.START);
    const rejected = await lateGuest.request(Constants.COMMANDS.JOIN, {
        roomName: "Network Game",
        actorName: "Jordan"
    });

    assert.match(rejected.findLast((response) => response.message)?.message?.message ?? "", /in progress/i);
    await owner.connection.close();
    await guest.connection.close();
    await lateGuest.connection.close();
    await host.shutdown();
});

test("Host returns one connection and rejects another connection claiming its tab", async (t) => {
    const host = new Host("hosted", 0, false);
    t.after(function stopHost() { return host.shutdown(); });
    const owner = createConnection(host, "shared-tab");
    const other = createConnection(host, "shared-tab");

    assert.equal(owner.connection instanceof HostConnection, true);
    await owner.request(Constants.COMMANDS.CREATE, {
        roomName: "Owned Room", actorName: "Alice", actorLimit: 2
    });
    const rejected = await other.request(Constants.COMMANDS.VIEW, { roomName: "Owned Room" });

    assert.match(rejected.findLast(function findError(response) {
        return response.message?.status === Constants.STATUS.ERROR;
    })?.message?.message ?? "", /connection expired/i);
    assert.equal(owner.connection.isOpen, true);

    await owner.connection.close();
    assert.equal(owner.connection.isOpen, false);
    await other.connection.close();
});

test("an actor can leave a hosted room while it is playing", async () => {
    const host = new Host("hosted", 0, false);
    const owner = createConnection(host, "owner");
    const guest = createConnection(host, "guest");

    await owner.request(Constants.COMMANDS.CREATE, {
        roomName: "Active Room",
        actorName: "Daniel",
        actorLimit: 3
    });
    await guest.request(Constants.COMMANDS.JOIN, {
        roomName: "Active Room",
        actorName: "Casey"
    });
    await owner.request(Constants.COMMANDS.START);

    const homeResponses = await guest.request(Constants.COMMANDS.LEAVE);
    const home = homeResponses.findLast((response) => response.view === Constants.VIEWS.HOME);

    assert.ok(home);
    const activeRoom = home.data.rooms.find((room) => room.name === "Active Room");

    assert.ok(activeRoom);
    assert.equal(activeRoom.match.turnOrder.actorCount, 1);
    await owner.connection.close();
    await guest.connection.close();
    await host.shutdown();
});

test("Host retains a custom room in memory after its creator leaves", async () => {
    const host = new Host("direct", "fill", false);
    const connection = createConnection(host, "owner");

    await connection.request(Constants.COMMANDS.CREATE, {
        roomName: "Saved Game",
        actorName: "Daniel",
        actorLimit: 3
    });
    const home = (await connection.request(Constants.COMMANDS.LEAVE)).findLast(
        (response) => response.view === Constants.VIEWS.HOME
    ).data;
    await connection.connection.close();

    assert.equal(
        home.rooms.some((room) => room.name === "Saved Game"),
        true
    );
    await host.shutdown();
});

test("Session adds shared fields to every local Host request", async () => {
    let publish;
    let request;
    const host = {
        accept(send) {
            publish = send;
            return {
                receive(nextRequest) { request = nextRequest; },
                close() {}
            };
        }
    };
    const view = new Session(new URL("https://example.test/room.html"));
    const statuses = [];
    const dataEvents = [];
    view.sortKey = "rank";
    assert.throws(() => {
        view.sortKey = "value";
    }, /Invalid card sort key/);
    view.connect(host, {
        handleConnectionStatus(status) { statuses.push(status); },
        handleData(name, data) { dataEvents.push({ view: name, data }); }
    });

    assert.equal(view.request(Constants.COMMANDS.CREATE, { roomName: "Test" }), true);
    await Promise.resolve();
    assert.equal(request.command, Constants.COMMANDS.CREATE);
    assert.equal(request.data.roomName, "Test");
    assert.equal(request.data.sortKey, "rank");
    assert.equal(typeof request.data.tabId, "string");

    publish({ view: Constants.VIEWS.ROOM, message: null, data: { version: 2 } });
    await Promise.resolve();
    assert.deepEqual(statuses, ["connecting", "connected"]);
    assert.deepEqual(dataEvents, [{ view: Constants.VIEWS.ROOM, data: { version: 2 } }]);
});

test("Session switches local and hosted connections without replaying old local work", async (t) => {
    const originalWebSocket = globalThis.WebSocket;
    const sent = [];
    class FakeWebSocket {
        static OPEN = 1;
        constructor() { this.readyState = FakeWebSocket.OPEN; }
        addEventListener() {}
        send(message) { sent.push(JSON.parse(message)); }
        close() { this.readyState = 3; }
    }
    globalThis.WebSocket = FakeWebSocket;
    t.after(() => {
        if (originalWebSocket === undefined) delete globalThis.WebSocket;
        else globalThis.WebSocket = originalWebSocket;
    });

    const localRequests = [];
    let oldHostShutdowns = 0;
    let publishOld;
    let disconnectOld;
    const oldHost = { accept(send, disconnect) {
        publishOld = send;
        disconnectOld = disconnect;
        return { receive(request) { localRequests.push(["old", request]); }, close() {} };
    }, shutdown() { oldHostShutdowns += 1; } };
    const newHost = { accept() {
        return { receive(request) { localRequests.push(["new", request]); }, close() {} };
    } };
    const received = [];
    const view = new Session(new URL("https://example.test/room.html"));
    view.sortKey = "rank";
    view.connect(oldHost, { handleData(_name, data) { received.push(data); } });
    view.request("list", {});
    view.connect("ws://example.test", null);
    assert.equal(oldHostShutdowns, 1);
    publishOld({ view: Constants.VIEWS.ROOM, data: { stale: true } });
    disconnectOld();
    await Promise.resolve();
    assert.deepEqual(localRequests, []);
    assert.deepEqual(received, []);

    assert.equal(view.request("list", {}), true);
    assert.equal(sent[0].data.sortKey, "rank");
    view.connect(newHost, null);
    view.request("list", {});
    await Promise.resolve();
    assert.deepEqual(localRequests.map(([source]) => source), ["new"]);
    view.disconnect();
});

test("browser and Node runtime import graphs stay separate", () => {
    const host = readFileSync(new URL("../host/Host.js", import.meta.url), "utf8");
    const transport = readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8");
    const view = readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8");
    const hostedServer = readFileSync(new URL("../server.js", import.meta.url), "utf8");

    assert.doesNotMatch(host, /from ["'](?:node:|express|ws)/);
    assert.doesNotMatch(host, /\b(?:document|localStorage|sessionStorage|WebSocket)\b/);
    assert.doesNotMatch(transport, /from ["'](?:node:|express|ws)/);
    assert.match(view, /from "\.\.\/host\/Host\.js"/);
    assert.match(hostedServer, /from "\.\/host\/Host\.js"/);
    assert.match(hostedServer, /from "node:/);
    assert.match(hostedServer, /from "ws"/);
    assert.doesNotMatch(hostedServer, /class HostedServer/);
    assert.match(hostedServer, /function startServer\(port\)/);
    assert.match(hostedServer, /async function stopServer\(\)/);
    assert.doesNotMatch(hostedServer, /ConnectionChannel/);
});

test("application source uses explicit, named control flow", () => {
    const source = [
        readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8"),
        readFileSync(new URL("../main.js", import.meta.url), "utf8"),
        readJavaScriptSources(new URL("../core/", import.meta.url)).join("\n"),
        readJavaScriptSources(new URL("../host/", import.meta.url)).join("\n"),
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
        readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8") +
        readFileSync(new URL("../main.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../server.js", import.meta.url), "utf8");
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
    assert.doesNotMatch(homeMarkup, /id="room-faq"/);
    assert.match(gameHtml, /data-has-local-actor="false"/);
    assert.doesNotMatch(gameHtml, /pick-2-shared-root/);
    assert.doesNotMatch(homeTemplate, /id="connection-view"/);
    assert.match(readFileSync(new URL("../connection.html", import.meta.url), "utf8"), /id="connection-view"/);
    assert.match(gameHtml, /data-has-local-actor="false"[^>]+data-connection-mode="direct"[^>]+data-match-state="waiting"/);
    assert.match(gameHtml, /data-actor-state="ready"/);
    assert.match(
        gameHtml,
        /id="actor-summary"[\s\S]*?<span data-actor-name="" id="actor-status"><\/span>[\s\S]*?<span data-item-count="0"><\/span>/
    );
    assert.match(gameHtml, /id="actor-hand"/);
    assert.match(gameHtml, /id="table-play-area"[\s\S]*?data-is-drag-over="false"/);
    assert.match(
        gameHtml,
        /id="actor-hand"[\s\S]*?<span class="playing-card-area"><\/span>/
    );
    assert.doesNotMatch(gameHtml, /<span class="playing-card-area" data-is-drag-over="false"><\/span>/);
    assert.doesNotMatch(gameHtml, /id="actor-region"/);
    assert.match(gameHtml, /<details id="room-faq" class="faq" aria-labelledby="room-faq-title">/);
    assert.doesNotMatch(gameHtml, /<details id="room-faq" open>/);
    assert.match(gameHtml, /<b id="room-faq-title">FAQ<\/b>/);
    assert.match(gameHtml, /<b>Which card can I play\?<\/b>/);
    assert.match(gameHtml, /<b>Who wins one match\?<\/b>/);
    assert.match(gameHtml, /How is my penalty calculated\?/);
    assert.match(gameHtml, /two \(20\) and a king \(13\) score 33/);
    assert.match(gameHtml, /id="room-faq-link" href="#room-faq">FAQ<\/a>/);
    assert.doesNotMatch(gameHtml, /data-match-region|id="faq-section"/);
    assert.match(gameHtml, /<tr class="placeholder-row"[^>]*>[\s\S]*?<td>--<\/td>/);
    assert.doesNotMatch(gameHtml, /id="room-mode-label"|id="connection-status-indicator"/);
    assert.match(homeHtml, /src="main\.js"/);
    assert.doesNotMatch(homeMarkup, /connection\.js/);
    assert.match(homeTemplate, /<aside>\s*<span data-game-preview aria-hidden="true"><\/span>\s*<\/aside>/);
    assert.match(
        homeTemplate,
        /<header class="hero">\s*<div class="eyebrow">[\s\S]*?<div>\s*<aside>[\s\S]*?<aside>\s*<span data-game-preview/
    );
    assert.match(homeCss, /\.hero > :last-child\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/);
    const cardCss = readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8");
    assert.match(cardCss, /\[data-game-preview\]\s*\{[\s\S]*?position:\s*relative;/);
    assert.match(cardCss, /\[data-game-preview\]\s*\{[\s\S]*?display:\s*block;/);
    assert.match(cardCss, /\[data-game-preview\] > playing-card\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(cardCss, /--card-rotation:\s*-24deg;/);
    assert.match(homeCss, /data-game-preview/);
    assert.match(homeDecoration, /new Card\(VALUE\.TWO\.id, SUIT\.CLUBS, 0\)/);
    assert.match(homeDecoration, /new Card\(VALUE\.EIGHT\.id, SUIT\.DIAMONDS, 0\)/);
    assert.match(homeDecoration, /new Card\(VALUE\.JACK\.id, SUIT\.SPADES, 0\)/);
    assert.match(homeDecoration, /new Card\(VALUE\.ACE\.id, SUIT\.HEARTS, 0\)/);
    assert.match(homeDecoration, /\.sort\(compareCardRanks\)/);
    assert.match(homeDecoration, /PlayingCard\.create\(card\)/);
    assert.match(homeDecoration, /element\.rotation = null/);
    assert.match(roomPageHtml, /src="main\.js"/);
    assert.match(homeHtml, /href="ui\/styles\/home\.css"/);
    assert.match(roomPageHtml, /href="\.\/ui\/styles\/room\.css"/);
    assert.doesNotMatch(main, /pick2\/ui\/styles\/room\.css/);
    assert.match(homeHtml, /href="ui\/styles\/base\.css"/);
    assert.match(roomPageHtml, /href="\.\/ui\/styles\/base\.css"/);
    assert.match(homeHtml, /href="ui\/styles\/table\.css"/);
    assert.match(roomPageHtml, /href="\.\/ui\/styles\/table\.css"/);
    assert.ok(homeHtml.indexOf("styles/table.css") < homeHtml.indexOf("styles/home.css"));
    assert.ok(roomPageHtml.indexOf("styles/table.css") < roomPageHtml.indexOf("styles/room.css"));
    assert.doesNotMatch(homeHtml, /table-data\.css/);
    assert.doesNotMatch(gameHtml, /table-data\.css/);
    assert.doesNotMatch(homeMarkup + gameHtml, /<caption\b/);
    assert.match(homeTemplate, /<button id="enter-button">Enter room<\/button>/);
    assert.match(homeTemplate, /<button id="alert-ok-button">OK<\/button>/);
    assert.match(gameHtml, /<button id="room-play-button" type="button" data-mode="choose">Start<\/button>/);
    assert.match(gameHtml, /<button id="room-invite-button" type="button" hidden>Invite<\/button>/);
    assert.match(gameHtml, /<button id="countdown-ok-button">OK<\/button>/);
    assert.match(gameHtml, /<button id="suit-selection-timeout-button">timeout<\/button>/);
    assert.match(gameHtml, /<button id="suit-selection-submit-button">Submit<\/button>/);
    assert.match(gameHtml, /<button id="results-dismiss-button">dismiss<\/button>/);
    assert.match(homeHtml, /<details id="home-faq"[^>]*>\s*<summary>[\s\S]*?<\/details>\s*<article id="home-directory">/);
    assert.doesNotMatch(homeHtml, /<details[^>]*\bopen\b/);
    assert.doesNotMatch(gameHtml, /href="\.\/rules\.html"/);
    assert.match(main, /new Host\("direct", "fill", false\)/);
    assert.match(main, /this\.connect\(target, this\.#controller/);
    assert.match(main, /SessionState\.getHostedUrl\(\)/);
    assert.match(main, /new HomeSession\(roomUrl\)/);
    assert.match(main, /new RoomSession\(homeUrl\)/);
    assert.match(network, /app\.use\(express\.static\(repositoryPath\)\)/);
    assert.match(network, /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/);
    assert.doesNotMatch(network, /network\/index\.html/);
    assert.doesNotMatch(network, /\["\/network", "\/network\/", "\/network\/index\.html"\]/);
    assert.doesNotMatch(network, /response\.redirect\([^)]*\/(?:room|game)/);
    assert.doesNotMatch(network, /web\/network/);
});

test("the finished dialog opens once per finish and clears for a new game", () => {
    const controller = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const actorController = readFileSync(
        new URL("../ui/controllers/LocalActorController.js", import.meta.url),
        "utf8"
    );
    const resultsController = readFileSync(new URL("../ui/controllers/ResultsController.js", import.meta.url), "utf8");

    assert.match(
        controller,
        /previousState !== Constants\.ROOM_STATE\.FINISHED[\s\S]*?nextState === Constants\.ROOM_STATE\.FINISHED[\s\S]*?#resultsController\.show\(room\)/
    );
    assert.match(
        controller,
        /nextState !== Constants\.ROOM_STATE\.FINISHED[\s\S]*?#resultsController\.hide\(\)/
    );
    assert.match(
        resultsController,
        /hide\(\)\s*\{[\s\S]*?#actors = \[\];[\s\S]*?#statsBody\.replaceChildren\(\);[\s\S]*?#selectedActorItems\.replaceChildren\(\);[\s\S]*?super\.hide\(\)/
    );
    assert.match(
        controller,
        /ROOM_STATE\.WAITING \|\|[\s\S]*?ROOM_STATE\.FINISHED && !match\.isKnockout[\s\S]*?return true;/
    );
    assert.doesNotMatch(controller, /#handleCardReturn|COMMANDS\.RETURN/);
});

test("Start offers a knockout choice and room tables show the selected mode", () => {
    const roomHtml = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const homeHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const rowHtml = readFileSync(new URL("../ui/templates/room-row.html", import.meta.url), "utf8");
    const rowController = readFileSync(new URL("../ui/utilities/RoomRowUtils.js", import.meta.url), "utf8");

    assert.match(roomHtml, /<p>[Ss]elect mode<\/p>/);
    assert.match(roomHtml, /id="play-one-button" class="play-choice" type="button">\s*<span class="play-choice-title">One match<\/span>/);
    assert.match(roomHtml, /id="play-knockout-button" class="play-choice" type="button">\s*<span class="play-choice-title">Knockout<\/span>/);
    assert.ok(roomHtml.indexOf('id="play-one-button"') < roomHtml.indexOf('id="play-knockout-button"'));
    assert.match(roomHtml, /<th scope="col">Knockout<\/th>/);
    assert.match(homeHtml, /<th scope="col">Knockout<\/th>/);
    assert.match(rowHtml, /data-knockout="no"/);
    assert.match(rowController, /source\.match\.isKnockout === true \? Constants\.KNOCKOUT_VALUE\.YES : Constants\.KNOCKOUT_VALUE\.NO/);
    assert.match(rowController, /data\.knockout === Constants\.KNOCKOUT_VALUE\.YES \? "Yes" : "No"/);
});

test("the shared table stylesheet owns foundational row states", () => {
    const baseCss = readFileSync(new URL("../ui/styles/base.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../ui/styles/room.css", import.meta.url), "utf8");
    const overlaysCss = readFileSync(new URL("../ui/styles/dialogs.css", import.meta.url), "utf8");
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
        /tr\s*\{[\s\S]*?border-top:\s*var\(--table-data-border\)/
    );
    assert.match(
        tableCss,
        /tbody tr:is\(:hover, :focus-visible\)\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--cyan\) 12%, transparent\)/
    );
    assert.match(tableCss, /tbody tr:focus-visible\s*\{[\s\S]*?outline-offset:\s*-3px/);
    assert.match(tableCss, /tbody tr\[data-is-selected="true"\]\s*\{\s*color:\s*var\(--cyan\);\s*\}/);
    assert.match(
        tableCss,
        /th\s*\{[\s\S]*?color:\s*var\(--gray\);[\s\S]*?letter-spacing:\s*0\.1em;[\s\S]*?text-transform:\s*uppercase;/
    );
    assert.doesNotMatch(
        homeCss + gameCss + overlaysCss,
        /--table-heading-(?:color|font-size|font-weight|letter-spacing)/
    );
});

test("responsive styles are mobile-first with one tablet and desktop stage", () => {
    const styleNames = ["../ui/styles/base.css", "../ui/styles/home.css", "../ui/styles/faq.css"];

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

test("page controllers depend on Session rather than runtime services", () => {
    const homeController = readFileSync(new URL("../ui/controllers/HomeController.js", import.meta.url), "utf8");
    const gameController = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");

    for (const source of [homeController, gameController]) {
        assert.doesNotMatch(source, /Static|ConnectionService|LocalGameService|ServerSessionController/);
        assert.match(source, /this\.view/);
    }

    assert.match(homeController, /row\.addEventListener\("click"/);
    assert.match(homeController, /row\.addEventListener\("keydown"/);
    assert.match(homeController, /row\.tabIndex = 0/);
    assert.match(homeController, /Constants\.COMMANDS\.VIEW, \{\s*roomName\s*\}/);
    assert.doesNotMatch(homeController, /this\.#capabilities\.viewers === true/);
    assert.match(homeController, /cell\.textContent = "No rooms available\."/);
    assert.match(homeController, /for \(const input of \[this\.#directModeInput, this\.#hostedModeInput\]\)/);
    assert.match(homeController, /input\.value/);
    assert.match(homeController, /registrationMode === "join" && !isRoomListed/);
    assert.match(homeController, /Constants\.NOTIFICATIONS\.ROOM_NOT_FOUND/);
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
    const controller = readFileSync(new URL("../ui/controllers/LocalActorController.js", import.meta.url), "utf8");
    assert.match(controller, /"#actor-hand > \.playing-card-area", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-actor-name\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-item-count\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-draw-allowance\]", HTMLSpanElement/);
    assert.match(controller, /querySelector\("\[data-idle-seconds\]"\)/);
    assert.doesNotMatch(controller, /"#actor-status"|"#draw-button > span"|"#actor-idle-warning > em"/);

    assert.doesNotMatch(html, /id="card-size-range"/);
    assert.match(cardCss, /--card-height:\s*max\(100cqh, var\(--card-height-min\)\)/);
    assert.match(cardCss, /\.playing-card-drag-handle\s*\{[\s\S]*?width:\s*100%/);
    assert.match(gameCss, /@keyframes turn-owner-border-strobe/);
    assert.match(homeCss, /\.toggle-switch > label:has\(input:checked\) > span/);
    assert.match(controller, /this\.#playRegion\.dataset\.hasLocalActor = "true"/);
    assert.match(controller, /this\.#playRegion\.dataset\.hasLocalActor = "false"/);
    assert.match(controller, /this\.#actorStatus\.dataset\.actorName = actor\.name \?\? ""/);
    assert.match(controller, /this\.#actorStatus\.dataset\.actorName = ""/);
    assert.doesNotMatch(html + controller + gameCss, /data-is-actor-view|isActorView/);
    assert.match(html, /id="actors-list"[\s\S]*?id="table-play-area"[\s\S]*?id="local-actor-region"/);
    assert.match(html, /<ul id="actors-list" aria-label="Other actors"><\/ul>/);
    assert.doesNotMatch(html, /id="actors-list"[^>]*role=/);
    assert.match(
        readFileSync(new URL("../ui/templates/actor.html", import.meta.url), "utf8"),
        /<li[^>]* data-actor-name=/
    );
    assert.doesNotMatch(
        readFileSync(new URL("../ui/templates/actor.html", import.meta.url), "utf8"),
        /role="listitem"/
    );
    assert.match(gameCss, /\[data-has-local-actor="false"\]\s*\{[\s\S]*?--play-area-rows:/);
    assert.match(gameCss, /\[data-has-local-actor="false"\] > #local-actor-region,[\s\S]*?\{\s*display:\s*none/);
    assert.doesNotMatch(gameCss, /\[data-has-local-actor="false"\][^{]*#table-play-area[^{]*\{[^}]*--card-height/);
    assert.match(gameCss, /#game-region\[data-connection-mode="direct"\] > #local-actor-region #actor-idle-warning/);
    assert.match(
        readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8"),
        /playRegion\.dataset\.connectionMode = room\.connectionMode/
    );
    assert.doesNotMatch(
        readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8"),
        /idleWarning\.hidden/
    );
    assert.doesNotMatch(controller, /#local-actor|isTurnBound/);
});
