"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { createPlayingRoom, stopIdleMonitoring } from "../helpers/room.js";
import { Card } from "../../core/Card.js";
import { Constants } from "../../core/Constants.js";
import { Player } from "../../core/Player.js";
import { Room } from "../../core/Room.js";
import { UserNotification } from "../../core/UserNotification.js";
import { StateMapper } from "../../core/StateMapper.js";

test("room perform dispatches card commands through the serialized actions", async (t) => {
    const room = new Room("Command Gateway", 2);
    t.after(() => stopIdleMonitoring(room));
    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    const drawn = await room.perform(Constants.COMMANDS.DRAW, "Alice");
    assert.equal(drawn.length, 1);
    await assert.rejects(room.perform("unknown", "Alice"), /Unknown match command/);
});

test("room lifecycle predicate describes active state", () => {
    const room = new Room("Lifecycle Game", 2);

    assert.equal(room.isMatchActive(), false);

    for (const state of [Constants.ROOM_STATE.ACTIVE]) {
        room.match.state = state;
        assert.equal(room.isMatchActive(), true);
    }

    room.match.state = Constants.ROOM_STATE.FINISHED;
    assert.equal(room.isMatchActive(), false);
});

test("a completed match resumes waiting without resetting its cards", async (t) => {
    const room = new Room("Completed Game", 2);

    t.after(() => stopIdleMonitoring(room));
    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    await room.startMatch();
    const collections = JSON.stringify(room.match.collections);
    const hands = JSON.stringify(Array.from(room.match.turnOrder.players.values(), function mapHand(player) {
        return player.collection;
    }));
    room.match.state = Constants.ROOM_STATE.FINISHED;

    assert.equal(await room.resumeWaiting(), undefined);
    assert.equal(room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.match.turnOrder.ownerKey, null);
    assert.equal(room.match.turnOrder.players.size, 2);
    assert.equal(JSON.stringify(room.match.collections), collections);
    assert.equal(
        JSON.stringify(Array.from(room.match.turnOrder.players.values(), function mapHand(player) {
            return player.collection;
        })),
        hands
    );
});

test("game membership enforces uniqueness and player limit", async (t) => {
    const room = new Room("Test Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");

    assert.equal(room.isFull(), true);
    assert.equal(room.hasPlayer("alice"), true);
    await assert.rejects(room.joinPlayer("Casey"), /Room is full/);
});

test("a viewer can join the room as a player", async (t) => {
    const room = new Room("Viewed Game", 2);
    t.after(() => stopIdleMonitoring(room));

    room.view("tab-1");
    assert.equal(room.viewers.has("tab-1"), true);
    const player = await room.joinPlayer("Alice", false, "tab-1");

    assert.equal(player.name, "Alice");
    assert.equal(room.viewers.has("tab-1"), false);
    assert.equal(room.hasPlayer("Alice"), true);
    await assert.rejects(room.joinPlayer("Bob", false, "missing"), /Viewer not found/);
});

test("player activity belongs to the player and room, not the turnOrder", async (t) => {
    const room = new Room("Activity Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    room.match.state = Constants.ROOM_STATE.ACTIVE;
    room.match.turnOrder.setOwner(alice.key);
    alice.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS));
    room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)];
    room.lastActiveAt = 0;

    await room.playItem("Alice", Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS);

    assert.equal(room.lastActiveAt > 0, true);
    assert.equal(Object.hasOwn(room.match.turnOrder.toJSON(), "lastActiveAt"), false);
    assert.equal(Object.hasOwn(room.match.turnOrder.toJSON(), "createdAt"), false);
});

test("rooms support viewing, idle-player removal, and leaving", async (t) => {
    const room = new Room("Transitions", 3);
    t.after(() => stopIdleMonitoring(room));

    assert.equal(room.view("viewer-1"), undefined);
    assert.equal(room.viewers.has("viewer-1"), true);
    room.view("viewer-1");
    assert.equal(room.viewers.size, 1);
    assert.equal(room.leaveViewer("viewer-1"), undefined);
    assert.equal(room.viewers.has("viewer-1"), false);
    room.leaveViewer("viewer-1");
    assert.equal(room.viewers.size, 0);

    const alice = await room.joinPlayer("Alice");
    alice.collection.add(new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS));
    assert.equal((await room.movePlayerToView("Alice", "alice-tab")).name, "Alice");
    assert.equal(room.viewers.has("alice-tab"), true);
    assert.equal(room.hasPlayer("Alice"), false);
    await assert.rejects(room.movePlayerToView("missing", "tab"), /Player does not exist/);

    await room.joinPlayer("Bob");
    assert.equal((await room.removePlayer("Bob")).name, "Bob");
    await assert.rejects(room.removePlayer("Bob"), /Player does not exist/);
    assert.equal(room.isEmpty(), true);
});

test("players and viewers can leave while a room is active", async (t) => {
    const room = await createPlayingRoom(t);

    room.view("active-viewer");
    assert.equal(room.viewers.has("active-viewer"), true);
    assert.equal((await room.removePlayer("Alice")).name, "Alice");
    room.leaveViewer("active-viewer");
    assert.equal(room.viewers.has("active-viewer"), false);
    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.hasPlayer("Alice"), false);
    assert.equal(room.viewers.has("active-viewer"), false);
});

test("room data uses one player shape and localPlayerName identifies the local player", async (t) => {
    const room = new Room("Data Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");

    const localPayload = StateMapper.toRoomData(room, "Alice");
    const viewerPayload = StateMapper.toRoomData(room, null);
    const expectedKeys = ["collection", "drawAllowance", "key", "name", "state"];

    assert.equal(localPayload.localPlayerName, "Alice");
    assert.equal(viewerPayload.localPlayerName, null);
    assert.equal(localPayload.match.turnOrder.ownerKey, null);
    assert.deepEqual(Object.keys(localPayload.match.turnOrder.players[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.match.turnOrder.players[1]).sort(), expectedKeys);
});

test("a room requires two players", async (t) => {
    const room = new Room("Small Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinPlayer("Alice");
    await assert.rejects(room.startMatch(), /Need at least two players/);
});

test("waiting rooms have no turn owner and allow every player to draw or discard", async (t) => {
    const room = new Room("Waiting Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.joinPlayer("Alice");
    const bob = await room.joinPlayer("Bob");
    alice.collection.add({ value: "5", suit: "clubs" });
    bob.collection.add({ value: "k", suit: "hearts" });

    await room.playItem("Alice", "5", "clubs");
    await room.playItem("Bob", "k", "hearts");

    assert.equal(room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.match.turnOrder.owner, null);
    assert.equal(room.match.turnOrder.ownerKey, null);
    assert.notEqual(room.match.turnOrder.ownerKey, alice.key);
    assert.throws(() => room.match.turnOrder.requireOwner(), /Turn owner is not assigned/);
    assert.equal(alice.collection.items.length, 0);
    assert.equal(bob.collection.items.length, 0);
    assert.equal(alice.drawAllowance, 1);
    assert.equal(bob.drawAllowance, 1);
    assert.equal(room.match.declaredSuit, null);
    assert.equal([...room.match.turnOrder.players.values()].some(function won(player) {
        return player.state === Constants.PLAYER_STATE.WON;
    }), false);
    assert.equal(room.match.getTopItem().id, "k-hearts");

    assert.equal((await room.drawItems("Alice")).length, 1);
    assert.equal((await room.drawItems("Bob")).length, 1);
    assert.equal(room.match.turnOrder.owner, null);
});

test("a null turn owner bypasses playing turn and card-legality checks", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.match.turnOrder.get("Alice");
    const bob = room.match.turnOrder.get("Bob");

    room.match.turnOrder.setOwner(null);
    bob.collection.addMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);

    await room.playItem(bob.name, Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS);

    alice.drawAllowance = 0;
    const drawn = await room.drawItems(alice.name);

    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.match.turnOrder.owner, null);
    assert.equal(room.match.getTopItem().id, "k-clubs");
    assert.equal(drawn.length, 1);
});

test("starting a match deals seven cards and selects an ordinary discard", async (t) => {
    const room = new Room("Started Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    assert.deepEqual(await room.startMatch(), []);

    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.match.collections.play.items.length, 1);
    assert.equal(room.match.getTopItem().isSpecial(), false);
    assert.equal(room.match.turnOrder.owner === null, false);
    assert.equal(room.match.turnOrder.ownerKey, room.match.turnOrder.requireOwner().key);

    for (const player of room.match.turnOrder.players.values()) {
        assert.equal(player.collection.items.length, Room.INITIAL_ITEM_COUNT);
    }

    assert.equal(room.match.collections.draw.items.length, 39);
});


test("only the turn owner can act and passing advances the turn", async (t) => {
    const room = new Room("Turn Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    await room.startMatch();

    const current = room.match.turnOrder.owner;
    const other = [...room.match.turnOrder.players.values()].find((player) => player.key !== current.key);
    const initialCount = current.collection.items.length;

    await assert.rejects(room.passTurn(other.name), /Not your turn/);
    const drawn = await room.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.collection.items.length, initialCount + 1);
    assert.equal(room.match.turnOrder.owner.key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.match.turnOrder.get("Alice");
    alice.drawAllowance = 2;

    const cards = await room.drawItems("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(room.match.turnOrder.owner.name, "Bob");

    room.match.turnOrder.setOwner("Alice");
    await assert.rejects(room.drawItems("Alice"), /No draw allowance remaining/);
    await assert.rejects(room.drawItems("Missing"), /Player does not exist/);
});

test("drawing recycles every discard except the top card exactly once", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.match.turnOrder.get("Alice");
    const existingDrawCard = new Card("2", "clubs", 0);
    const recycledCards = [new Card("3", "diamonds", 0), new Card("4", "hearts", 0)];
    const topDiscard = new Card("5", "spades", 0);

    room.match.collections.draw.items = [existingDrawCard];
    room.match.collections.play.items = [...recycledCards, topDiscard];
    alice.drawAllowance = 3;

    const drawnCards = await room.drawItems("Alice");
    const drawnIds = drawnCards.map((card) => card.id);

    assert.deepEqual(room.match.collections.play.items.map((card) => card.id), [topDiscard.id]);
    assert.equal(room.match.collections.draw.size, 0);
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
        const room = await createPlayingRoom(t);
        const alice = room.match.turnOrder.get("Alice");
        alice.collection.addMany([
            new Card(scenario.value, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);

        await room.playItem("Alice", scenario.value, Constants.CARD.SUIT.HEARTS);

        assert.equal(room.match.turnOrder.owner.name, scenario.expectedPlayer);
        assert.equal(room.match.turnOrder.owner.drawAllowance, scenario.expectedAllowance);
    }

    const suitSession = await createPlayingRoom(t, ["Alice", "Bob"]);
    suitSession.match.turnOrder
        .get("Alice")
        .collection.addMany([
            new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);
    await suitSession.playItem("Alice", Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(suitSession.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.deepEqual(suitSession.match.pending, {
        command: Constants.COMMANDS.DECLARE,
        playerKey: "alice"
    });
    assert.equal(await suitSession.declareSuit(Constants.CARD.SUIT.CLUBS), undefined);
    assert.equal(suitSession.match.declaredSuit, Constants.CARD.SUIT.CLUBS);
    assert.equal(suitSession.match.turnOrder.owner.name, "Bob");

    const finishSession = await createPlayingRoom(t, ["Alice", "Bob"]);
    finishSession.match.turnOrder
        .get("Alice")
        .collection.add(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    finishSession.match.turnOrder
        .get("Bob")
        .collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS));
    await finishSession.playItem("Alice", Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(finishSession.match.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(finishSession.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(finishSession.match.turnOrder.get("Bob").collection.penalty, 13);
});

test("game input validation rejects invalid player limit and suit", async (t) => {
    assert.throws(() => new Room("Invalid", 1), /Limit must be between/);
    assert.throws(() => Room.normalizeSuit("purple"), /Invalid suit/);

    const room = new Room("Suit Game", 2);
    t.after(() => stopIdleMonitoring(room));
    await assert.rejects(room.declareSuit("hearts"), /No suit pending declaration/);
});

test("a room commits the selected card order when the player moves", async (t) => {
    const room = new Room("Sort Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const player = await room.joinPlayer("Alice");
    player.collection.addMany([
        { value: "k", suit: "clubs" },
        { value: "3", suit: "hearts" },
        { value: "8", suit: "spades" }
    ]);

    await room.passTurn("Alice", "rank");

    assert.deepEqual(player.collection.items.map(String), ["3-hearts", "8-spades", "k-clubs"]);
});

test("room remembers which player made the latest gameplay discard", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.match.turnOrder.get("Alice");

    room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS)];
    alice.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);

    assert.equal(room.match.getLastDiscardPlayer(), null);

    await room.playItem(alice.name, Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS);

    assert.equal(room.match.getLastDiscardPlayer(), alice);
});


test("a suit declaration validates the requesting player inside the room queue", async t => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    room.match.turnOrder.get("Alice").collection.addMany([new Card("a", "hearts", 0), new Card("4", "clubs", 0)]);
    await room.playItem("Alice", "a", "hearts");
    await assert.rejects(room.perform("declare", "Bob", { suit: "clubs" }), /Not your turn/);
    assert.equal(room.match.pending.playerKey, "alice");
    assert.equal(room.match.declaredSuit, null);
    await assert.rejects(room.perform("declare", null, { suit: "clubs" }), /Player name must be a string/);
    await assert.rejects(room.perform("declare", "Alice", { suit: "purple" }), UserNotification);
    await assert.rejects(room.perform("declare", "Alice", { suit: null }), UserNotification);
    assert.equal(room.match.pending.playerKey, "alice");
    await room.perform("declare", "Alice", { suit: "clubs" });
    assert.equal(room.match.pending, null);
    assert.equal(room.match.declaredSuit, "clubs");
    assert.equal(room.match.turnOrder.ownerKey, "bob");
});
