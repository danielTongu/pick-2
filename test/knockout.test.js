"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Card } from "../core/Card.js";
import { Constants } from "../core/Constants.js";
import { Knockout, Match, Room } from "../core/Room.js";
import { Host } from "../host/Host.js";

function stopActors(room) {
    for (const actor of room.match.turnOrder.actors.values()) actor.stopIdleMonitoring();
}

async function playingRoom(t, names, knockout) {
    const room = new Room("Knockout Test", names.length);
    t.after(function cleanup() { stopActors(room); });
    for (const name of names) await room.joinActor(name);
    await room.startMatch(knockout);
    room.match.turnOrder.setOwner(names[0]);
    room.match.collections.play.items = [new Card("5", "hearts")];
    for (const actor of room.match.turnOrder.actors.values()) actor.collection.clear();
    return room;
}

test("knockout eliminates every tied high penalty and waits for Play", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey", "Dana"], true);
    assert.ok(room.match instanceof Knockout);
    assert.equal(Object.hasOwn(room, "turnOrder"), false);
    assert.equal("turnOrder" in room, false);
    assert.equal(Object.hasOwn(room.toJSON(), "match"), true);
    assert.equal(Object.hasOwn(room.toJSON(), "turnOrder"), false);
    assert.equal(Object.hasOwn(room, "mode"), false);
    assert.equal(Object.hasOwn(room.toJSON(), "mode"), false);
    assert.equal(room.match.nextMatchAvailable, false);
    assert.equal(room.match.isKnockoutComplete, false);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("q", "diamonds"));
    room.match.turnOrder.get("Dana").collection.add(new Card("3", "clubs"));

    await room.playItem("Alice", "7", "hearts");
    assert.equal(Object.hasOwn(room, "winners"), false);
    assert.deepEqual([...room.match.turnOrder.actors.values()].filter(function eliminated(actor) {
        return actor.state === Constants.ACTOR_STATE.ELIMINATED;
    }).map(function nameOf(actor) { return actor.name; }), ["Bob", "Casey"]);
    assert.deepEqual([...room.match.turnOrder.actors.values()].map(function stateOf(actor) { return actor.state; }),
        ["qualified", "eliminated", "eliminated", "qualified"]);
    assert.equal(room.match.turnOrder.get("Bob").collection.penalty, 12);
    await room.moveActorToView("Bob", "bob-tab");
    await room.moveActorToView("Casey", "casey-tab");
    assert.equal(room.match.nextMatchAvailable, true);
    assert.deepEqual(room.match.turnOrder.order, ["alice", "dana"]);
    const currentOrder = room.match.turnOrder;
    await room.startMatch();
    assert.strictEqual(room.match.turnOrder, currentOrder);
    assert.deepEqual(room.match.turnOrder.order, ["alice", "dana"]);
    assert.equal(room.match.isKnockoutComplete, false);
    assert.ok(room.match instanceof Knockout);
    assert.equal(room.match.nextMatchAvailable, false);
});

test("knockout final match can tie and a one-on-one departure awards the remaining actor", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob"], true);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Alice").collection.add(new Card("5", "clubs"));
    room.match.turnOrder.get("Bob").collection.add(new Card("5", "diamonds"));
    await room.playItem("Alice", "7", "hearts");
    assert.deepEqual([...room.match.turnOrder.actors.values()].map(function stateOf(actor) { return actor.state; }),
        [Constants.ACTOR_STATE.WON, Constants.ACTOR_STATE.WON]);
    assert.equal(room.match.isKnockoutComplete, true);
    assert.equal(room.match.nextMatchAvailable, false);

    const forfeit = await playingRoom(t, ["Alice", "Bob"], true);
    await forfeit.removeActor("Bob");
    assert.equal(forfeit.match.turnOrder.get("Alice").state, Constants.ACTOR_STATE.WON);
    assert.equal(forfeit.match.isKnockoutComplete, true);
    assert.equal(forfeit.match.state, Constants.ROOM_STATE.FINISHED);
});

test("ordinary match keeps its existing winner and departure behavior", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey"], false);
    assert.ok(room.match instanceof Match);
    assert.equal(room.match instanceof Knockout, false);
    assert.equal("prepareNextMatch" in room.match, false);
    assert.equal("afterActorRemoved" in room.match, false);
    assert.equal("nextMatchAvailable" in room.match, false);
    assert.equal("isKnockoutComplete" in room.match, false);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await room.playItem("Alice", "7", "hearts");
    assert.equal(room.match.turnOrder.get("Alice").state, Constants.ACTOR_STATE.WON);
    assert.equal(Object.hasOwn(room.match, "nextMatchAvailable"), false);
    assert.equal(room.match instanceof Knockout, false);
});

test("a qualified actor wins if the other actor leaves before the next Play", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey"], true);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await room.playItem("Alice", "7", "hearts");
    await room.moveActorToView("Bob", "bob-tab");
    assert.equal(room.match.nextMatchAvailable, true);
    await room.removeActor("Casey");
    assert.equal(room.match.turnOrder.get("Alice").state, Constants.ACTOR_STATE.WON);
    assert.equal(room.match.isKnockoutComplete, true);
    assert.equal(room.match.nextMatchAvailable, false);
    assert.equal(room.match.turnOrder.get("Alice").state, Constants.ACTOR_STATE.WON);
});

test("a full high-penalty tie eliminates everyone and ends the knockout in a tie", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey"], true);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Alice").collection.add(new Card("5", "clubs"));
    room.match.turnOrder.get("Bob").collection.add(new Card("5", "diamonds"));
    room.match.turnOrder.get("Casey").collection.add(new Card("5", "spades"));
    await room.playItem("Alice", "7", "hearts");
    assert.deepEqual([...room.match.turnOrder.actors.values()].map(function stateOf(actor) { return actor.state; }),
        [Constants.ACTOR_STATE.ELIMINATED, Constants.ACTOR_STATE.ELIMINATED, Constants.ACTOR_STATE.ELIMINATED]);
    for (const name of ["Alice", "Bob", "Casey"]) await room.removeActor(name);
    assert.equal([...room.match.turnOrder.actors.values()].some(function won(actor) {
        return actor.state === Constants.ACTOR_STATE.WON;
    }), false);
    assert.equal(room.match.isKnockoutComplete, true);
});

test("host retains knockout results until Play removes nonqualifiers and demotes losers", async (t) => {
    class CapturingHost extends Host {
        createRoom(name, limit) {
            this.createdRoom = super.createRoom(name, limit);
            return this.createdRoom;
        }
    }
    const host = new CapturingHost("hosted", 0, false);
    t.after(function cleanup() { return host.shutdown(); });
    function connection(tabId) {
        const responses = [];
        const connection = host.accept(function receive(response) {
            responses.push(response);
        }, function disconnect() {});
        return {
            responses,
            request(command, data = {}) {
                return connection.receive({ command, data: { tabId, sortKey: "none", ...data } });
            }
        };
    }
    const alice = connection("alice-tab");
    const bob = connection("bob-tab");
    const casey = connection("casey-tab");
    await alice.request(Constants.COMMANDS.CREATE, { roomName: "Knockout Host", actorName: "Alice", actorLimit: 3 });
    await bob.request(Constants.COMMANDS.JOIN, { roomName: "Knockout Host", actorName: "Bob" });
    await casey.request(Constants.COMMANDS.JOIN, { roomName: "Knockout Host", actorName: "Casey" });
    await alice.request(Constants.COMMANDS.START, { knockout: true });
    const room = host.createdRoom;
    room.match.turnOrder.setOwner("Alice");
    room.match.collections.play.items = [new Card("5", "hearts")];
    for (const actor of room.match.turnOrder.actors.values()) actor.collection.clear();
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await alice.request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(room.match.nextMatchAvailable, true);
    assert.equal(room.hasActor("Bob"), true);
    assert.equal(room.viewers.has("bob-tab"), false);
    assert.equal(bob.responses.findLast(function isRoom(response) { return response.view === "room"; }).data.localActorName, "Bob");
    assert.equal(room.match.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(typeof room.match.turnOrder.get("Alice").onIdle, "function");
    await delay(1010);
    await bob.request(Constants.COMMANDS.START);
    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.ok(room.match instanceof Knockout);
    assert.equal(room.hasActor("Bob"), false);
    assert.equal(room.viewers.has("bob-tab"), true);
    assert.equal(bob.responses.findLast(function isRoom(response) { return response.view === "room"; }).data.localActorName, null);
});

test("a bot-only qualified field starts on the timer after the human is eliminated", async (t) => {
    class CapturingHost extends Host {
        createRoom(name, limit) {
            this.createdRoom = super.createRoom(name, limit);
            return this.createdRoom;
        }

        async runAutomatedTurn() {}
    }
    const previousDelay = Constants.ROOM_WAIT_MS;
    Constants.ROOM_WAIT_MS = 40;
    t.after(function restoreDelay() { Constants.ROOM_WAIT_MS = previousDelay; });
    const host = new CapturingHost("direct", "fill", false);
    t.after(function cleanup() { return host.shutdown(); });
    const responses = [];
    const connection = host.accept(function receive(response) { responses.push(response); },
        function disconnect() {});
    async function request(command, data = {}) {
        await connection.receive({ command, data: { tabId: "alice-tab", sortKey: "none", ...data } });
    }
    await request(Constants.COMMANDS.CREATE, { roomName: "Bot Knockout", actorName: "Alice", actorLimit: 3 });
    await request(Constants.COMMANDS.START, { knockout: true });
    const room = host.createdRoom;
    room.match.turnOrder.setOwner("Alice");
    room.match.collections.play.items = [new Card("5", "hearts")];
    for (const actor of room.match.turnOrder.actors.values()) actor.collection.clear();
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Alice").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("CM").collection.add(new Card("3", "clubs"));
    room.match.turnOrder.get("XC").collection.add(new Card("4", "clubs"));
    await request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(room.hasActor("Alice"), true);
    assert.equal(room.match.nextMatchAvailable, true);
    await delay(100);
    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.hasActor("Alice"), false);
    assert.deepEqual([...room.match.turnOrder.actors.values()].map(function nameOf(actor) { return actor.name; }), ["CM", "XC"]);
    assert.ok(responses.some(function sawResult(response) {
        return response.data?.match?.state === Constants.ROOM_STATE.FINISHED &&
            response.data?.match?.turnOrder?.actors?.length === 3;
    }));
});

test("an eliminated bot is reseated after the final knockout result", async (t) => {
    class CapturingHost extends Host {
        createRoom(name, limit) {
            this.createdRoom = super.createRoom(name, limit);
            return this.createdRoom;
        }

        async runAutomatedTurn() {}
    }
    const previousDelay = Constants.ROOM_WAIT_MS;
    Constants.ROOM_WAIT_MS = 40;
    t.after(function restoreDelay() { Constants.ROOM_WAIT_MS = previousDelay; });
    const previousCountdown = Constants.COUNTDOWN_SECONDS;
    Constants.COUNTDOWN_SECONDS = 0.04;
    t.after(function restoreCountdown() { Constants.COUNTDOWN_SECONDS = previousCountdown; });
    const host = new CapturingHost("direct", "fill", false);
    t.after(function cleanup() { return host.shutdown(); });
    const connection = host.accept(function receive() {}, function disconnect() {});
    async function request(command, data = {}) {
        await connection.receive({ command, data: { tabId: "alice-tab", sortKey: "none", ...data } });
    }
    await request(Constants.COMMANDS.CREATE, { roomName: "Bot Return", actorName: "Alice", actorLimit: 3 });
    await request(Constants.COMMANDS.START, { knockout: true });
    const room = host.createdRoom;
    const eliminatedBot = room.match.turnOrder.get("CM");
    room.match.turnOrder.setOwner("Alice");
    room.match.collections.play.items = [new Card("5", "hearts")];
    for (const actor of room.match.turnOrder.actors.values()) actor.collection.clear();
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("CM").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("XC").collection.add(new Card("3", "clubs"));
    await request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(room.hasActor("CM"), true);
    await delay(100);
    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.hasActor("CM"), false);
    room.match.turnOrder.setOwner("Alice");
    room.match.collections.play.items = [new Card("5", "hearts")];
    for (const actor of room.match.turnOrder.actors.values()) actor.collection.clear();
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("XC").collection.add(new Card("3", "clubs"));
    await delay(260);
    await request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(room.match.isKnockoutComplete, true);
    await delay(100);
    assert.equal(room.match.turnOrder.get("CM"), eliminatedBot);
});
