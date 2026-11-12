"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { createPlayingRoomService, stopIdleMonitoring } from "../helpers/room-service.js";
import { Card } from "../../model/Card.js";
import { Constants } from "../../shared/Constants.js";
import { Player } from "../../model/Player.js";
import { RoomService } from "../../service/RoomService.js";
import { UserNotification } from "../../shared/UserNotification.js";
import { StateMapper } from "../../host/StateMapper.js";

test("room perform dispatches card commands through the serialized actions", async (t) => {
    const service = new RoomService("Command Gateway", 2);
    t.after(() => stopIdleMonitoring(service));
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    const drawn = await service.perform(Constants.COMMANDS.DRAW, "Alice");
    assert.equal(drawn.length, 1);
    await assert.rejects(service.perform("unknown", "Alice"), /Unknown match command/);
});

test("room lifecycle predicate describes active state", () => {
    const service = new RoomService("Lifecycle Game", 2);

    assert.equal(service.room.isMatchActive(), false);

    for (const state of [Constants.ROOM_STATE.ACTIVE]) {
        service.room.match.state = state;
        assert.equal(service.room.isMatchActive(), true);
    }

    service.room.match.state = Constants.ROOM_STATE.FINISHED;
    assert.equal(service.room.isMatchActive(), false);
});

test("a completed match resumes waiting without resetting its cards", async (t) => {
    const service = new RoomService("Completed Game", 2);

    t.after(() => stopIdleMonitoring(service));
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.startMatch();
    const collections = JSON.stringify(service.room.match.collections);
    const hands = JSON.stringify(Array.from(service.room.match.turnOrder.players.values(), function mapHand(player) {
        return player.collection;
    }));
    service.room.match.state = Constants.ROOM_STATE.FINISHED;

    assert.equal(await service.resumeWaiting(), undefined);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(service.room.match.turnOrder.ownerKey, null);
    assert.equal(service.room.match.turnOrder.players.size, 2);
    assert.equal(JSON.stringify(service.room.match.collections), collections);
    assert.equal(
        JSON.stringify(Array.from(service.room.match.turnOrder.players.values(), function mapHand(player) {
            return player.collection;
        })),
        hands
    );
});

test("game membership enforces uniqueness and player limit", async (t) => {
    const service = new RoomService("Test Game", 2);
    t.after(() => stopIdleMonitoring(service));

    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");

    assert.equal(service.room.isFull(), true);
    assert.equal(service.room.hasPlayer("alice"), true);
    await assert.rejects(service.joinPlayer("Casey"), /Room is full/);
});

test("a viewer can join the room as a player", async (t) => {
    const service = new RoomService("Viewed Game", 2);
    t.after(() => stopIdleMonitoring(service));

    service.view("tab-1");
    assert.equal(service.room.viewers.has("tab-1"), true);
    const player = await service.joinPlayer("Alice", false, "tab-1");

    assert.equal(player.name, "Alice");
    assert.equal(service.room.viewers.has("tab-1"), false);
    assert.equal(service.room.hasPlayer("Alice"), true);
    await assert.rejects(service.joinPlayer("Bob", false, "missing"), /Viewer not found/);
});

test("room activity belongs to the model rather than the turn order", async (t) => {
    const service = new RoomService("Activity Game", 2);
    t.after(() => stopIdleMonitoring(service));

    const alice = await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    service.room.match.state = Constants.ROOM_STATE.ACTIVE;
    service.room.match.turnOrder.setOwner(alice.key);
    alice.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS));
    service.room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)];
    service.room.lastActiveAt = 0;

    await service.playItem("Alice", Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS);

    assert.equal(service.room.lastActiveAt > 0, true);
    assert.equal(Object.hasOwn(service.room.match.turnOrder.toJSON(), "lastActiveAt"), false);
    assert.equal(Object.hasOwn(service.room.match.turnOrder.toJSON(), "createdAt"), false);
});

test("rooms support viewing, idle-player removal, and leaving", async (t) => {
    const service = new RoomService("Transitions", 3);
    t.after(() => stopIdleMonitoring(service));

    assert.equal(service.view("viewer-1"), undefined);
    assert.equal(service.room.viewers.has("viewer-1"), true);
    service.view("viewer-1");
    assert.equal(service.room.viewers.size, 1);
    assert.equal(service.leaveViewer("viewer-1"), undefined);
    assert.equal(service.room.viewers.has("viewer-1"), false);
    service.leaveViewer("viewer-1");
    assert.equal(service.room.viewers.size, 0);

    const alice = await service.joinPlayer("Alice");
    alice.collection.add(new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS));
    assert.equal((await service.movePlayerToView("Alice", "alice-tab")).name, "Alice");
    assert.equal(service.room.viewers.has("alice-tab"), true);
    assert.equal(service.room.hasPlayer("Alice"), false);
    await assert.rejects(service.movePlayerToView("missing", "tab"), /Player does not exist/);

    await service.joinPlayer("Bob");
    assert.equal((await service.removePlayer("Bob")).name, "Bob");
    await assert.rejects(service.removePlayer("Bob"), /Player does not exist/);
    assert.equal(service.room.isEmpty(), true);
});

test("players and viewers can leave while a room is active", async (t) => {
    const service = await createPlayingRoomService(t);

    service.view("active-viewer");
    assert.equal(service.room.viewers.has("active-viewer"), true);
    assert.equal((await service.removePlayer("Alice")).name, "Alice");
    service.leaveViewer("active-viewer");
    assert.equal(service.room.viewers.has("active-viewer"), false);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(service.room.hasPlayer("Alice"), false);
    assert.equal(service.room.viewers.has("active-viewer"), false);
});

test("room data uses one player shape and localPlayerName identifies the local player", async (t) => {
    const service = new RoomService("Data Game", 2);
    t.after(() => stopIdleMonitoring(service));

    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");

    const localPayload = StateMapper.toRoomData(service.room, "Alice");
    const viewerPayload = StateMapper.toRoomData(service.room, null);
    const expectedKeys = ["collection", "drawAllowance", "key", "name", "state"];

    assert.equal(localPayload.localPlayerName, "Alice");
    assert.equal(viewerPayload.localPlayerName, null);
    assert.equal(localPayload.match.turnOrder.ownerKey, null);
    assert.deepEqual(Object.keys(localPayload.match.turnOrder.players[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.match.turnOrder.players[1]).sort(), expectedKeys);
});

test("a room requires two players", async (t) => {
    const service = new RoomService("Small Game", 2);
    t.after(() => stopIdleMonitoring(service));

    await service.joinPlayer("Alice");
    await assert.rejects(service.startMatch(), /Need at least two players/);
});

test("waiting rooms have no turn owner and allow every player to draw or discard", async (t) => {
    const service = new RoomService("Waiting Game", 2);
    t.after(() => stopIdleMonitoring(service));

    const alice = await service.joinPlayer("Alice");
    const bob = await service.joinPlayer("Bob");
    alice.collection.add({ value: "5", suit: "clubs" });
    bob.collection.add({ value: "k", suit: "hearts" });

    await service.playItem("Alice", "5", "clubs");
    await service.playItem("Bob", "k", "hearts");

    assert.equal(service.room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(service.room.match.turnOrder.owner, null);
    assert.equal(service.room.match.turnOrder.ownerKey, null);
    assert.notEqual(service.room.match.turnOrder.ownerKey, alice.key);
    assert.throws(() => service.room.match.turnOrder.requireOwner(), /Turn owner is not assigned/);
    assert.equal(alice.collection.items.length, 0);
    assert.equal(bob.collection.items.length, 0);
    assert.equal(alice.drawAllowance, 1);
    assert.equal(bob.drawAllowance, 1);
    assert.equal(service.room.match.declaredSuit, null);
    assert.equal([...service.room.match.turnOrder.players.values()].some(function won(player) {
        return player.state === Constants.PLAYER_STATE.WON;
    }), false);
    assert.equal(service.room.match.getTopItem().id, "k-hearts");

    assert.equal((await service.drawItems("Alice")).length, 1);
    assert.equal((await service.drawItems("Bob")).length, 1);
    assert.equal(service.room.match.turnOrder.owner, null);
});

test("a null turn owner bypasses playing turn and card-legality checks", async (t) => {
    const service = await createPlayingRoomService(t, ["Alice", "Bob"]);
    const alice = service.room.match.turnOrder.get("Alice");
    const bob = service.room.match.turnOrder.get("Bob");

    service.room.match.turnOrder.setOwner(null);
    bob.collection.addMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);

    await service.playItem(bob.name, Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS);

    alice.drawAllowance = 0;
    const drawn = await service.drawItems(alice.name);

    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(service.room.match.turnOrder.owner, null);
    assert.equal(service.room.match.getTopItem().id, "k-clubs");
    assert.equal(drawn.length, 1);
});

test("starting a match deals seven cards and selects an ordinary discard", async (t) => {
    const service = new RoomService("Started Game", 2);
    t.after(() => stopIdleMonitoring(service));

    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    assert.deepEqual(await service.startMatch(), []);

    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(service.room.match.collections.play.items.length, 1);
    assert.equal(service.room.match.getTopItem().isSpecial(), false);
    assert.equal(service.room.match.turnOrder.owner === null, false);
    assert.equal(service.room.match.turnOrder.ownerKey, service.room.match.turnOrder.requireOwner().key);

    for (const player of service.room.match.turnOrder.players.values()) {
        assert.equal(player.collection.items.length, RoomService.INITIAL_ITEM_COUNT);
    }

    assert.equal(service.room.match.collections.draw.items.length, 39);
});


test("only the turn owner can act and passing advances the turn", async (t) => {
    const service = new RoomService("Turn Game", 2);
    t.after(() => stopIdleMonitoring(service));

    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.startMatch();

    const current = service.room.match.turnOrder.owner;
    const other = [...service.room.match.turnOrder.players.values()].find((player) => player.key !== current.key);
    const initialCount = current.collection.items.length;

    await assert.rejects(service.passTurn(other.name), /Not your turn/);
    const drawn = await service.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.collection.items.length, initialCount + 1);
    assert.equal(service.room.match.turnOrder.owner.key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const service = await createPlayingRoomService(t, ["Alice", "Bob"]);
    const alice = service.room.match.turnOrder.get("Alice");
    alice.drawAllowance = 2;

    const cards = await service.drawItems("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(service.room.match.turnOrder.owner.name, "Bob");

    service.room.match.turnOrder.setOwner("Alice");
    await assert.rejects(service.drawItems("Alice"), /No draw allowance remaining/);
    await assert.rejects(service.drawItems("Missing"), /Player does not exist/);
});

test("drawing recycles every discard except the top card exactly once", async (t) => {
    const service = await createPlayingRoomService(t, ["Alice", "Bob"]);
    const alice = service.room.match.turnOrder.get("Alice");
    const existingDrawCard = new Card("2", "clubs", 0);
    const recycledCards = [new Card("3", "diamonds", 0), new Card("4", "hearts", 0)];
    const topDiscard = new Card("5", "spades", 0);

    service.room.match.collections.draw.items = [existingDrawCard];
    service.room.match.collections.play.items = [...recycledCards, topDiscard];
    alice.drawAllowance = 3;

    const drawnCards = await service.drawItems("Alice");
    const drawnIds = drawnCards.map((card) => card.id);

    assert.deepEqual(service.room.match.collections.play.items.map((card) => card.id), [topDiscard.id]);
    assert.equal(service.room.match.collections.draw.size, 0);
    assert.equal(new Set(drawnIds).size, 3);
    assert.deepEqual(drawnIds.toSorted(), [existingDrawCard, ...recycledCards].map((card) => card.id).toSorted());
});

test("special discards apply skip, reverse, draw, suit, and room-ending effects", async (t) => {
    const scenarios = [
        { value: Constants.CARD.VALUE.EIGHT.id, expectedPlayer: "Casey", expectedAllowance: 1 },
        { value: Constants.CARD.VALUE.JACK.id, expectedPlayer: "Casey", expectedAllowance: 1 },
        { value: Constants.CARD.VALUE.TWO.id, expectedPlayer: "Bob", expectedAllowance: 2 }
    ];

    for (const scenario of scenarios) {
        const service = await createPlayingRoomService(t);
        const alice = service.room.match.turnOrder.get("Alice");
        alice.collection.addMany([
            new Card(scenario.value, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);

        await service.playItem("Alice", scenario.value, Constants.CARD.SUIT.HEARTS);

        assert.equal(service.room.match.turnOrder.owner.name, scenario.expectedPlayer);
        assert.equal(service.room.match.turnOrder.owner.drawAllowance, scenario.expectedAllowance);
    }

    const declarationService = await createPlayingRoomService(t, ["Alice", "Bob"]);
    declarationService.room.match.turnOrder
        .get("Alice")
        .collection.addMany([
            new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);
    await declarationService.playItem("Alice", Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(declarationService.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.deepEqual(declarationService.room.match.pending, {
        command: Constants.COMMANDS.DECLARE,
        playerKey: "alice"
    });
    assert.equal(await declarationService.declareSuit(Constants.CARD.SUIT.CLUBS), undefined);
    assert.equal(declarationService.room.match.declaredSuit, Constants.CARD.SUIT.CLUBS);
    assert.equal(declarationService.room.match.turnOrder.owner.name, "Bob");

    const finishedService = await createPlayingRoomService(t, ["Alice", "Bob"]);
    finishedService.room.match.turnOrder
        .get("Alice")
        .collection.add(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    finishedService.room.match.turnOrder
        .get("Bob")
        .collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS));
    await finishedService.playItem("Alice", Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(finishedService.room.match.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(finishedService.room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(finishedService.room.match.turnOrder.get("Bob").collection.penalty, 13);
});

test("game input validation rejects invalid player limit and suit", async (t) => {
    assert.throws(() => new RoomService("Invalid", 1), /Limit must be between/);
    assert.throws(() => RoomService.normalizeSuit("purple"), /Invalid suit/);

    const service = new RoomService("Suit Game", 2);
    t.after(() => stopIdleMonitoring(service));
    await assert.rejects(service.declareSuit("hearts"), /No suit pending declaration/);
});

test("a room commits the selected card order when the player moves", async (t) => {
    const service = new RoomService("Sort Game", 2);
    t.after(() => stopIdleMonitoring(service));

    const player = await service.joinPlayer("Alice");
    player.collection.addMany([
        { value: "k", suit: "clubs" },
        { value: "3", suit: "hearts" },
        { value: "8", suit: "spades" }
    ]);

    await service.passTurn("Alice", "rank");

    assert.deepEqual(player.collection.items.map(String), ["3-hearts", "8-spades", "k-clubs"]);
});

test("room remembers which player made the latest gameplay discard", async (t) => {
    const service = await createPlayingRoomService(t, ["Alice", "Bob"]);
    const alice = service.room.match.turnOrder.get("Alice");

    service.room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS)];
    alice.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);

    assert.equal(service.room.match.getLastDiscardPlayer(), null);

    await service.playItem(alice.name, Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS);

    assert.equal(service.room.match.getLastDiscardPlayer(), alice);
});


test("a suit declaration validates the requesting player inside the room queue", async t => {
    const service = await createPlayingRoomService(t, ["Alice", "Bob"]);
    service.room.match.turnOrder.get("Alice").collection.addMany([new Card("a", "hearts", 0), new Card("4", "clubs", 0)]);
    await service.playItem("Alice", "a", "hearts");
    await assert.rejects(service.perform("declare", "Bob", { suit: "clubs" }), /Not your turn/);
    assert.equal(service.room.match.pending.playerKey, "alice");
    assert.equal(service.room.match.declaredSuit, null);
    await assert.rejects(service.perform("declare", null, { suit: "clubs" }), /Player name must be a string/);
    await assert.rejects(service.perform("declare", "Alice", { suit: "purple" }), UserNotification);
    await assert.rejects(service.perform("declare", "Alice", { suit: null }), UserNotification);
    assert.equal(service.room.match.pending.playerKey, "alice");
    await service.perform("declare", "Alice", { suit: "clubs" });
    assert.equal(service.room.match.pending, null);
    assert.equal(service.room.match.declaredSuit, "clubs");
    assert.equal(service.room.match.turnOrder.ownerKey, "bob");
});
