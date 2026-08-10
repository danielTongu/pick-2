"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Constants } from "../src/core/Constants.js";
import { AIPlayer } from "../src/core/Player.js";
import { LocalGameEngine } from "../src/static/LocalGameEngine.js";

test("a fresh static table uses the configured opponent names", async () => {
    const engine = new LocalGameEngine();
    const room = await engine.reset();

    assert.equal(room.status, Constants.STATUS.WAITING);
    assert.equal(room.playerCount, Constants.STATIC_OPPONENT_NAMES.length);
    assert.equal(room.capacity, 4);
    assert.equal(room.session.playerName, null);
    assert.deepEqual(room.circle.players.map((player) => player.name), Constants.STATIC_OPPONENT_NAMES);
});

test("the browser user occupies the fourth and final seat", async () => {
    const engine = new LocalGameEngine();
    await engine.reset();
    const room = await engine.join("Daniel");

    assert.equal(room.playerCount, 4);
    assert.equal(room.session.playerName, "Daniel");
    assert.equal(room.circle.players.at(-1).name, "Daniel");
    await assert.rejects(engine.join("Another Player"), /already occupied/i);
});

test("leaving a waiting table removes only the browser user", async () => {
    const engine = new LocalGameEngine();
    await engine.reset();
    await engine.join("Daniel");
    const room = await engine.leave();

    assert.equal(room.status, Constants.STATUS.WAITING);
    assert.equal(room.playerCount, Constants.STATIC_OPPONENT_NAMES.length);
    assert.equal(room.session.playerName, null);
    assert.deepEqual(room.circle.players.map((player) => player.name), Constants.STATIC_OPPONENT_NAMES);
});

test("leaving an active game starts autonomous play that can be stopped", async () => {
    const originalRandom = Math.random;
    const originalSetTimeout = globalThis.setTimeout;
    let releaseAiTurn;

    Math.random = () => 0.99;
    globalThis.setTimeout = (callback) => {
        releaseAiTurn = callback;
        return 1;
    };

    try {
        const engine = new LocalGameEngine();
        const snapshots = [];

        engine.onStateChange = (room) => snapshots.push(room);
        await engine.reset();
        await engine.join("Daniel");
        await engine.act(Constants.ACTIONS.START_GAME);

        void engine.leave();
        await new Promise((resolve) => setImmediate(resolve));

        const continuingRoom = snapshots.at(-1);
        assert.equal(continuingRoom.status, Constants.STATUS.PLAYING);
        assert.equal(continuingRoom.playerCount, 3);
        assert.equal(continuingRoom.session.playerName, null);
        assert.equal(continuingRoom.isBusy, true);

        const stoppedRoom = await engine.stop();
        assert.equal(stoppedRoom.status, Constants.STATUS.WAITING);
        assert.equal(stoppedRoom.playerCount, 4);
        assert.equal(stoppedRoom.session.playerName, "Daniel");
        assert.equal(stoppedRoom.isBusy, false);
        assert.equal(stoppedRoom.discardPile.length, 1);
        assert.equal(
            stoppedRoom.circle.players
                .filter((player) => player.name !== "Daniel")
                .every((player) => player.hand.cards.length === Constants.PLAYER_INITIAL_CARD_COUNT),
            true
        );
        assert.equal(
            stoppedRoom.circle.players.find((player) => player.name === "Daniel").hand.cards.length,
            0
        );

        releaseAiTurn?.();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(engine.snapshot().status, Constants.STATUS.WAITING);

        const restartedRoom = await engine.act(Constants.ACTIONS.START_GAME);
        assert.equal(restartedRoom.status, Constants.STATUS.PLAYING);
        assert.equal(
            restartedRoom.circle.players.every(
                (player) => player.hand.cards.length === Constants.PLAYER_INITIAL_CARD_COUNT
            ),
            true
        );
    } finally {
        Math.random = originalRandom;
        globalThis.setTimeout = originalSetTimeout;
    }
});

test("the browser user can leave while an AI turn is resolving", async () => {
    const originalRandom = Math.random;
    const originalSetTimeout = globalThis.setTimeout;
    const aiTurnCallbacks = [];

    Math.random = () => 0;
    globalThis.setTimeout = (callback, delay) => {
        if (delay < Constants.MAX_IDLE_MS) {
            aiTurnCallbacks.push(callback);
        }

        return aiTurnCallbacks.length + 1;
    };

    try {
        const engine = new LocalGameEngine();

        await engine.reset();
        await engine.join("Daniel");
        const startPromise = engine.act(Constants.ACTIONS.START_GAME);

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(engine.snapshot().isBusy, true);

        const leavePromise = engine.leave();

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(engine.snapshot().session.playerName, null);
        assert.equal(engine.snapshot().playerCount, Constants.STATIC_OPPONENT_NAMES.length);

        const stoppedRoom = await engine.stop();

        assert.equal(stoppedRoom.status, Constants.STATUS.WAITING);
        assert.equal(stoppedRoom.session.playerName, "Daniel");

        for (const callback of aiTurnCallbacks) {
            callback();
        }

        await Promise.all([startPromise, leavePromise]);
    } finally {
        Math.random = originalRandom;
        globalThis.setTimeout = originalSetTimeout;
    }
});

test("an autonomous finish restores the local seat without exposing stop", async () => {
    const originalRandom = Math.random;
    const originalTakeTurn = AIPlayer.prototype.takeTurn;

    Math.random = () => 0.99;
    AIPlayer.prototype.takeTurn = async function (room) {
        room.status = Constants.STATUS.FINISHED;
        room.circle.setTurnOwner(null);
    };

    try {
        const engine = new LocalGameEngine();

        await engine.reset();
        await engine.join("Daniel");
        await engine.act(Constants.ACTIONS.START_GAME);
        const room = await engine.leave();

        assert.equal(room.status, Constants.STATUS.WAITING);
        assert.equal(room.session.playerName, "Daniel");
        assert.equal(room.playerCount, Constants.ROOM_MAX_CAPACITY);
        assert.equal(room.canStop, false);
    } finally {
        Math.random = originalRandom;
        AIPlayer.prototype.takeTurn = originalTakeTurn;
    }
});

test("starting deals seven cards and can hand the first turn to the human", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.99;

    try {
        const engine = new LocalGameEngine();
        await engine.reset();
        await engine.join("Daniel");
        const room = await engine.act(Constants.ACTIONS.START_GAME);
        const localPlayer = room.circle.players.find((player) => player.name === "Daniel");

        assert.equal(room.status, Constants.STATUS.PLAYING);
        assert.equal(room.circle.turnOwnerKey, localPlayer.key);
        assert.equal(localPlayer.hand.cards.length, Constants.PLAYER_INITIAL_CARD_COUNT);
        assert.equal(room.circle.players.every((player) => player.hand.cards.length === 7), true);
    } finally {
        Math.random = originalRandom;
    }
});

test("the deployment entry point contains no lobby or network client", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/static/main.js", import.meta.url), "utf8");

    assert.doesNotMatch(html, /lobby/i);
    assert.doesNotMatch(main, /WebSocket|ConnectionService|LobbyController/);
    assert.match(html, /id="room-info-table-body"/);
    assert.match(html, /id="post-join-form-actions-button"/);
    assert.doesNotMatch(html, /id="turn-status"/);
    assert.doesNotMatch(html, /<th scope="col">Visitors<\/th>/);
    assert.match(html, /\.\/src\/static\/main\.js/);
    assert.match(html, /\.\/web\/shared\/styles\/app\.css/);
});

test("static controls cycle through join, leave, and stop without a new-table action", () => {
    const appController = readFileSync(new URL("../src/static/StaticAppController.js", import.meta.url), "utf8");
    const gameService = readFileSync(new URL("../src/static/LocalGameService.js", import.meta.url), "utf8");
    const playerController = readFileSync(new URL("../src/ui/LocalPlayerController.js", import.meta.url), "utf8");
    const staticCss = readFileSync(new URL("../web/static/static.css", import.meta.url), "utf8");

    assert.match(appController, /room\?\.canStop === true/);
    assert.match(appController, /const action = canStop \? "stop" : "leave"/);
    assert.match(appController, /actionButton\.disabled = false/);
    assert.doesNotMatch(appController, /dataset\.action === "new"|#gameService\.reset/);
    assert.doesNotMatch(gameService, /async reset\(\)/);
    assert.doesNotMatch(staticCss, /data-action="new"/);
    assert.match(
        playerController,
        /data\.status === Constants\.STATUS\.WAITING \|\|[\s\S]*?#canRestartFinishedGame && data\.status === Constants\.STATUS\.FINISHED/
    );
    assert.match(playerController, /#startButton\.disabled = data\.isBusy \|\| !canStartGame/);
    assert.match(playerController, /#sortControl\.disabled = false/);
    assert.doesNotMatch(playerController, /#sortControl\.disabled = data\.isBusy/);
    assert.match(
        readFileSync(new URL("../src/static/StaticRoomController.js", import.meta.url), "utf8"),
        /canRestartFinishedGame: true/
    );
});

test("static and server room headers group metadata and controls", () => {
    const staticHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const serverHtml = readFileSync(new URL("../web/server/index.html", import.meta.url), "utf8");
    const roomHeaderPattern = /<header id="room-header">\s*<div class="table-container">\s*<table id="room-info-table">/;

    assert.match(staticHtml, roomHeaderPattern);
    assert.match(serverHtml, roomHeaderPattern);
    assert.match(
        staticHtml,
        /<\/div>\s*<form id="join-form">[\s\S]*?<button id="post-join-form-actions-button"[\s\S]*?<\/header>/
    );
    assert.match(serverHtml, /<\/div>\s*<nav id="room-actions"[\s\S]*?<\/nav>\s*<\/header>/);
});

test("the static page publishes consistent search discovery metadata", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
    const canonicalUrl = "https://danieltongu.github.io/pick-2/";

    assert.match(html, /<title>Play Pick 2 Online \| Free AI Card Game<\/title>/);
    assert.match(html, /<meta name="description"\s+content="[^"]+">/);
    assert.match(html, /<meta name="robots" content="index, follow/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}">`));
    assert.match(html, new RegExp(`<meta property="og:url" content="${canonicalUrl}">`));
    assert.match(html, /<script type="application\/ld\+json">/);
    assert.match(sitemap, new RegExp(`<loc>${canonicalUrl}<\\/loc>`));
});

test("the local hand keeps cards large and drag handles touch friendly", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const serverHtml = readFileSync(new URL("../web/server/index.html", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../src/ui/LocalPlayerController.js", import.meta.url), "utf8");
    const cardCss = readFileSync(new URL("../web/shared/styles/playing-card.css", import.meta.url), "utf8");
    const appCss = readFileSync(new URL("../web/shared/styles/app.css", import.meta.url), "utf8");

    for (const page of [html, serverHtml]) {
        assert.doesNotMatch(page, /id="card-size-range"/);
        assert.doesNotMatch(page, /id="card-size-output"/);
    }

    assert.doesNotMatch(controller, /cardSizeControl|applyCardSize/);
    assert.doesNotMatch(cardCss, /--local-player-card-height/);
    assert.match(cardCss, /--card-max-height:\s*200px/);
    assert.match(
        cardCss,
        /#local-player-hand > playing-card,[\s\S]*?height:\s*var\(--card-max-height\)/
    );
    assert.match(
        cardCss,
        /\.playing-card-drag-handle\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*calc\(var\(--card-height\) \/ 3\)/
    );
    assert.match(
        cardCss,
        /\.playing-card-drag-handle::before\s*\{[\s\S]*?width:\s*calc\(100% \/ 3\);[\s\S]*?margin-top:\s*\.35rem/
    );
    assert.match(cardCss, /playing-card\s*\{[\s\S]*?box-shadow:\s*none/);
    assert.match(
        cardCss,
        /#discard-pile > playing-card:last-child\s*\{[\s\S]*?box-shadow:/
    );
    assert.match(
        appCss,
        /#local-player-hand\s*\{[\s\S]*?height:\s*var\(--card-max-height\)/
    );
    assert.match(appCss, /#local-player-hand[\s\S]*overflow-x:\s*auto/);
    assert.match(appCss, /#local-player-hand[\s\S]*scrollbar-width:\s*none/);
    assert.match(appCss, /#local-player-hand::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/);
    assert.match(appCss, /#local-player-hand > playing-card\s*\{[\s\S]*?position:\s*relative/);
    assert.match(appCss, /#draw-card-button\s*\{[\s\S]*?position:\s*relative/);
    assert.match(
        appCss,
        /\[data-is-turn-owner="true"\]\s*\{[\s\S]*?animation:\s*turn-owner-border-strobe 1\.2s ease-in-out infinite/
    );
    assert.match(appCss, /@keyframes turn-owner-border-strobe/);
    assert.match(
        appCss,
        /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\[data-is-turn-owner="true"\][\s\S]*?animation:\s*none/
    );
    assert.match(
        cardCss,
        /#draw-card-button\s*\{[\s\S]*?background:\s*rgba\(255, 255, 255, \.08\);[\s\S]*?color:\s*#fff/
    );
    assert.match(
        cardCss,
        /#draw-card-button:disabled\s*\{[\s\S]*?color:\s*#fff;[\s\S]*?opacity:\s*1/
    );
    assert.doesNotMatch(cardCss, /#draw-card-button:hover\s*\{[^}]*box-shadow/);
    assert.doesNotMatch(appCss, /button:hover\s*\{[^}]*box-shadow/);
});
