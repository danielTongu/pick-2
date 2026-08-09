"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Constants } from "../src/core/Constants.js";
import { LocalGameEngine } from "../src/static/LocalGameEngine.js";

test("a fresh static table contains exactly three waiting AI seats", async () => {
    const engine = new LocalGameEngine();
    const room = await engine.reset();

    assert.equal(room.status, Constants.STATUS.WAITING);
    assert.equal(room.playerCount, 3);
    assert.equal(room.capacity, 4);
    assert.equal(room.session.playerName, null);
    assert.deepEqual(room.circle.players.map((player) => player.name), ["Maya", "Theo", "Zuri"]);
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
    assert.equal(room.playerCount, 3);
    assert.equal(room.session.playerName, null);
    assert.deepEqual(room.circle.players.map((player) => player.name), ["Maya", "Theo", "Zuri"]);
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

test("the deployment entry point contains no lobby, viewers, or network client", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/static/main.js", import.meta.url), "utf8");

    assert.doesNotMatch(html, /lobby|viewer|visitor/i);
    assert.doesNotMatch(main, /WebSocket|ConnectionService|LobbyController/);
    assert.match(html, /\.\/src\/static\/main\.js/);
    assert.match(html, /\.\/web\/shared\/styles\/app\.css/);
});

test("the static page publishes consistent search discovery metadata", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
    const canonicalUrl = "https://danieltongu.github.io/pick-2/";

    assert.match(html, /<title>Play Pick 2 Online \| Free AI Card Game<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<meta name="robots" content="index, follow/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}">`));
    assert.match(html, new RegExp(`<meta property="og:url" content="${canonicalUrl}">`));
    assert.match(html, /<script type="application\/ld\+json">/);
    assert.match(sitemap, new RegExp(`<loc>${canonicalUrl}<\\/loc>`));
});
