"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Card } from "../../model/Card.js";
import { Constants } from "../../shared/Constants.js";
import { Knockout } from "../../model/Knockout.js";
import { RoomService } from "../../service/RoomService.js";
import { Host } from "../../host/Host.js";

test("host retains knockout results until Play removes nonqualifiers and demotes losers", async (t) => {
    class CapturingHost extends Host {
        createRoomService(name, limit) {
            this.createdRoomService = super.createRoomService(name, limit);
            return this.createdRoomService;
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
    await alice.request(Constants.COMMANDS.CREATE, { roomName: "Knockout Host", playerName: "Alice", playerLimit: 3 });
    await bob.request(Constants.COMMANDS.JOIN, { roomName: "Knockout Host", playerName: "Bob" });
    await casey.request(Constants.COMMANDS.JOIN, { roomName: "Knockout Host", playerName: "Casey" });
    await alice.request(Constants.COMMANDS.START, { knockout: true });
    const service = host.createdRoomService;
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    for (const player of service.room.match.turnOrder.players.values()) player.collection.clear();
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    service.room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await alice.request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(service.room.match.nextMatchAvailable, true);
    assert.equal(service.room.hasPlayer("Bob"), true);
    assert.equal(service.room.viewers.has("bob-tab"), false);
    assert.equal(bob.responses.findLast(function isRoom(response) { return response.view === "room"; }).data.localPlayerName, "Bob");
    assert.equal(service.room.match.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(Object.hasOwn(service.room.match.turnOrder.get("Alice"), "onIdle"), false);
    await delay(1010);
    await bob.request(Constants.COMMANDS.START);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.ok(service.room.match instanceof Knockout);
    assert.equal(service.room.hasPlayer("Bob"), false);
    assert.equal(service.room.viewers.has("bob-tab"), true);
    assert.equal(bob.responses.findLast(function isRoom(response) { return response.view === "room"; }).data.localPlayerName, null);
});

test("a bot-only qualified field starts on the timer after the human is eliminated", async (t) => {
    class CapturingHost extends Host {
        createRoomService(name, limit) {
            this.createdRoomService = super.createRoomService(name, limit);
            return this.createdRoomService;
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
    await request(Constants.COMMANDS.CREATE, { roomName: "Bot Knockout", playerName: "Alice", playerLimit: 3 });
    await request(Constants.COMMANDS.START, { knockout: true });
    const service = host.createdRoomService;
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    for (const player of service.room.match.turnOrder.players.values()) player.collection.clear();
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Alice").collection.add(new Card("q", "clubs"));
    service.room.match.turnOrder.get("CM").collection.add(new Card("3", "clubs"));
    service.room.match.turnOrder.get("XC").collection.add(new Card("4", "clubs"));
    await request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(service.room.hasPlayer("Alice"), true);
    assert.equal(service.room.match.nextMatchAvailable, true);
    await delay(100);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(service.room.hasPlayer("Alice"), false);
    assert.deepEqual([...service.room.match.turnOrder.players.values()].map(function nameOf(player) { return player.name; }), ["CM", "XC"]);
    assert.ok(responses.some(function sawResult(response) {
        return response.data?.match?.state === Constants.ROOM_STATE.FINISHED &&
            response.data?.match?.turnOrder?.players?.length === 3;
    }));
});

test("an eliminated bot is recreated by name after the final knockout result", async (t) => {
    class CapturingHost extends Host {
        createRoomService(name, limit) {
            this.createdRoomService = super.createRoomService(name, limit);
            return this.createdRoomService;
        }

        async runAutomatedTurn() {}
    }
    const previousDelay = Constants.ROOM_WAIT_MS;
    Constants.ROOM_WAIT_MS = 40;
    t.after(function restoreDelay() { Constants.ROOM_WAIT_MS = previousDelay; });
    const previousCountdown = Constants.TRANSITION_DELAY_SECONDS;
    Constants.TRANSITION_DELAY_SECONDS = 0.04;
    t.after(function restoreCountdown() { Constants.TRANSITION_DELAY_SECONDS = previousCountdown; });
    const host = new CapturingHost("direct", "fill", false);
    t.after(function cleanup() { return host.shutdown(); });
    const connection = host.accept(function receive() {}, function disconnect() {});
    async function request(command, data = {}) {
        await connection.receive({ command, data: { tabId: "alice-tab", sortKey: "none", ...data } });
    }
    await request(Constants.COMMANDS.CREATE, { roomName: "Bot Return", playerName: "Alice", playerLimit: 3 });
    await request(Constants.COMMANDS.START, { knockout: true });
    const service = host.createdRoomService;
    const eliminatedBot = service.room.match.turnOrder.get("CM");
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    for (const player of service.room.match.turnOrder.players.values()) player.collection.clear();
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("CM").collection.add(new Card("q", "clubs"));
    service.room.match.turnOrder.get("XC").collection.add(new Card("3", "clubs"));
    await request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(service.room.hasPlayer("CM"), true);
    await delay(100);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(service.room.hasPlayer("CM"), false);
    assert.deepEqual(service.room.match.lostBotNames, ["CM"]);
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    for (const player of service.room.match.turnOrder.players.values()) player.collection.clear();
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("XC").collection.add(new Card("3", "clubs"));
    await delay(260);
    await request(Constants.COMMANDS.DISCARD, { card: { value: "7", suit: "hearts" } });
    assert.equal(service.room.match.isKnockoutComplete, true);
    await delay(100);
    const returningBot = service.room.match.turnOrder.get("CM");
    assert.notEqual(returningBot, eliminatedBot);
    assert.equal(returningBot.name, eliminatedBot.name);
    assert.deepEqual(service.room.match.lostBotNames, []);
    assert.equal(returningBot.state, Constants.PLAYER_STATE.LOST);
    assert.equal(returningBot.collection.items.length, 0);
    assert.equal(service.room.toJSON().match.turnOrder.players.find(player => player.key === eliminatedBot.key).state,
        Constants.PLAYER_STATE.LOST);
    await service.startMatch(false);
    assert.equal(service.room.match.lostBotNames, null);
    assert.ok([Constants.PLAYER_STATE.READY, Constants.PLAYER_STATE.ACTIVE].includes(returningBot.state));
});
