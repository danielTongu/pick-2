"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../core/Card.js";
import { Constants } from "../core/Constants.js";
import { Game } from "../core/Game.js";
import { Actor as Player } from "../core/Actor.js";
import { BotActor } from "../core/BotActor.js";
import { TurnOrder } from "../core/TurnOrder.js";
import { Room } from "../core/Room.js";
import { StateMapper } from "../core/StateMapper.js";
import { TurnUtils } from "../core/TurnUtils.js";

function stopIdleMonitoring(room) {
    for (const player of room.turnOrder.actors.values()) {
        player.stopIdleMonitoring();
    }
}

test("waiting players can return a discard without changing turn or draw allowance", async (t) => {
    const room = new Room("Return Cards", 2);
    t.after(() => stopIdleMonitoring(room));
    const alice = await room.joinActor("Alice");
    await room.drawItems("Alice");
    const card = alice.collection.items[0];
    const score = alice.collection.score;
    await room.playItem("Alice", card.value, card.suit);
    const allowance = alice.drawAllowance;
    const turnOwner = room.turnOrder.ownerKey;
    let changes = 0;
    room.onAnyChange = () => {
        changes += 1;
    };
    const returned = await room.returnItem("Alice", card.value, card.suit);
    assert.deepEqual(returned.toJSON(), card.toJSON());
    assert.equal(alice.collection.score, score);
    assert.equal(alice.collection.has(card), true);
    assert.equal(
        room.collections.play.items.some((entry) => entry.id === card.id),
        false
    );
    assert.equal(alice.drawAllowance, allowance);
    assert.equal(room.turnOrder.ownerKey, turnOwner);
    assert.equal(room.state, Constants.ROOM_STATE.WAITING);
    assert.equal(changes, 1);
    await assert.rejects(room.returnItem("Alice", card.value, card.suit), /no longer in the play collection/);
    assert.equal(alice.collection.score, score);
});

test("discard returns reject every non-waiting state and nonmembers without mutations", async (t) => {
    const room = new Room("Guarded Returns", 2);
    t.after(() => stopIdleMonitoring(room));
    const alice = await room.joinActor("Alice");
    const card = new Card("2", "clubs", 17);
    room.collections.play.items = [card];
    for (const state of [Constants.ROOM_STATE.ACTIVE, Constants.ROOM_STATE.FINISHED]) {
        room.state = state;
        await assert.rejects(room.returnItem("Alice", card.value, card.suit), /only be returned while/);
        assert.equal(room.state, state);
        assert.deepEqual(room.collections.play.items, [card]);
        assert.equal(alice.collection.items.length, 0);
    }
    room.state = Constants.ROOM_STATE.WAITING;
    await assert.rejects(room.returnItem("Visitor", card.value, card.suit), /Actor/);
    await assert.rejects(room.returnItem("Alice", card.value, card.suit, "invalid"), /Invalid card sort/);
    assert.deepEqual(room.collections.play.items, [card]);
    assert.equal(alice.collection.items.length, 0);
});

test("concurrent returns award a discard once and preserve the other cards' order", async (t) => {
    const room = new Room("Concurrent Returns", 2);
    t.after(() => stopIdleMonitoring(room));
    const alice = await room.joinActor("Alice");
    const bob = await room.joinActor("Bob");
    const cards = [new Card("3", "hearts", 10), new Card("a", "spades", 20), new Card("5", "clubs", 30)];
    room.collections.play.items = [...cards];
    alice.collection.add(new Card("k", "clubs", 0));
    alice.collection.add(new Card("2", "clubs", 0));
    const outcomes = await Promise.allSettled([
        room.returnItem("Alice", "a", "spades", "rank"),
        room.returnItem("Bob", "a", "spades")
    ]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.deepEqual(room.collections.play.items, [cards[0], cards[2]]);
    assert.deepEqual(
        alice.collection.items.map((card) => card.value),
        ["2", "k", "a"]
    );
    assert.equal(alice.collection.score, 83);
    assert.equal(bob.collection.items.length, 0);
});

test("a queued round start prevents a subsequent discard return", async (t) => {
    const room = new Room("Starting Returns", 2);
    t.after(() => stopIdleMonitoring(room));
    await room.joinActor("Alice");
    await room.joinActor("Bob");
    room.collections.play.items = [new Card("a", "spades", 0)];
    const outcomes = await Promise.allSettled([room.startRound(), room.returnItem("Alice", "a", "spades")]);
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, "rejected");
    assert.match(outcomes[1].reason.message, /only be returned while/);
    assert.equal(room.state, Constants.ROOM_STATE.ACTIVE);
});

async function createPlayingSession(t, playerNames = ["Alice", "Bob", "Casey"]) {
    const room = new Room(`Rules ${Math.floor(Math.random() * 1000000)}`, playerNames.length);
    t.after(() => stopIdleMonitoring(room));

    for (const name of playerNames) {
        await room.joinActor(name);
    }

    room.state = Constants.ROOM_STATE.ACTIVE;
    room.turnOrder.setOwner(playerNames[0]);
    room.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)];

    for (const player of room.turnOrder.actors.values()) {
        player.collection.clear();
        player.drawAllowance = 1;
    }

    return room;
}

test("room lifecycle predicates describe active and membership-locked states", () => {
    const room = new Room("Lifecycle Game", 2);

    assert.equal(room.isRoundActive(), false);
    assert.equal(room.isMembershipLocked(), false);

    for (const state of [Constants.ROOM_STATE.ACTIVE]) {
        room.state = state;
        assert.equal(room.isRoundActive(), true);
        assert.equal(room.isMembershipLocked(), true);
    }

    room.state = Constants.ROOM_STATE.FINISHED;
    assert.equal(room.isRoundActive(), false);
    assert.equal(room.isMembershipLocked(), false);
});

test("a completed round resumes waiting without resetting its cards", async (t) => {
    const room = new Room("Completed Game", 2);

    t.after(() => stopIdleMonitoring(room));
    await room.joinActor("Alice");
    await room.joinActor("Bob");
    await room.startRound();
    const collections = JSON.stringify(room.collections);
    const hands = JSON.stringify(Array.from(room.turnOrder.actors.values(), function mapHand(actor) {
        return actor.collection;
    }));
    room.state = Constants.ROOM_STATE.FINISHED;

    assert.equal(await room.resumeWaiting(), true);
    assert.equal(room.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.turnOrder.ownerKey, null);
    assert.equal(room.turnOrder.actors.size, 2);
    assert.equal(JSON.stringify(room.collections), collections);
    assert.equal(
        JSON.stringify(Array.from(room.turnOrder.actors.values(), function mapHand(actor) {
            return actor.collection;
        })),
        hands
    );
});

test("game membership enforces uniqueness and player limit", async (t) => {
    const room = new Room("Test Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");

    assert.equal(room.isFull(), true);
    assert.equal(room.hasActor("alice"), true);
    await assert.rejects(room.joinActor("Casey"), /Room is full/);
});

test("a viewer can join the room as a player", async (t) => {
    const room = new Room("Viewed Game", 2);
    t.after(() => stopIdleMonitoring(room));

    assert.equal(room.view("tab-1"), true);
    const player = await room.joinActor("Alice", false, "tab-1");

    assert.equal(player.name, "Alice");
    assert.equal(room.viewers.has("tab-1"), false);
    assert.equal(room.hasActor("Alice"), true);
    await assert.rejects(room.joinActor("Bob", false, "missing"), /Viewer not found/);
});

test("player activity belongs to the player and room, not the turnOrder", async (t) => {
    const room = new Room("Activity Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.joinActor("Alice");
    await room.joinActor("Bob");
    room.state = Constants.ROOM_STATE.ACTIVE;
    room.turnOrder.setOwner(alice.key);
    alice.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS));
    room.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)];
    alice.lastActiveAt = 0;
    room.lastActiveAt = 0;

    await room.playItem("Alice", Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS);

    assert.equal(alice.lastActiveAt > 0, true);
    assert.equal(room.lastActiveAt > 0, true);
    assert.equal(Object.hasOwn(room.turnOrder.toJSON(), "lastActiveAt"), false);
    assert.equal(Object.hasOwn(room.turnOrder.toJSON(), "createdAt"), false);
});

test("rooms support viewing, idle-player removal, and leaving", async (t) => {
    const room = new Room("Transitions", 3);
    t.after(() => stopIdleMonitoring(room));

    assert.equal(room.view("viewer-1"), true);
    assert.equal(room.view("viewer-1"), false);
    assert.equal(room.leaveViewer("viewer-1"), true);
    assert.equal(room.leaveViewer("viewer-1"), false);

    const alice = await room.joinActor("Alice");
    alice.collection.add(new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS));
    assert.equal((await room.moveActorToView("Alice", "alice-tab")).name, "Alice");
    assert.equal(room.viewers.has("alice-tab"), true);
    assert.equal(room.hasActor("Alice"), false);
    await assert.rejects(room.moveActorToView("missing", "tab"), /Actor does not exist/);

    await room.joinActor("Bob");
    assert.equal((await room.removeActor("Bob")).name, "Bob");
    await assert.rejects(room.removeActor("Bob"), /Actor does not exist/);
    assert.equal(room.isEmpty(), true);
});

test("players and viewers can leave while a room is active", async (t) => {
    const room = await createPlayingSession(t);

    assert.equal(room.view("active-viewer"), true);
    assert.equal((await room.removeActor("Alice")).name, "Alice");
    assert.equal(room.leaveViewer("active-viewer"), true);
    assert.equal(room.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.hasActor("Alice"), false);
    assert.equal(room.viewers.has("active-viewer"), false);
});

test("room data uses one player shape and localActorName identifies the local player", async (t) => {
    const room = new Room("Data Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");

    const localPayload = StateMapper.toRoomData(room, "Alice");
    const viewerPayload = StateMapper.toRoomData(room, null);
    const expectedKeys = ["collection", "drawAllowance", "key", "name", "state"];

    assert.equal(localPayload.localActorName, "Alice");
    assert.equal(viewerPayload.localActorName, null);
    assert.equal(localPayload.turnOrder.ownerKey, null);
    assert.deepEqual(Object.keys(localPayload.turnOrder.actors[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.turnOrder.actors[1]).sort(), expectedKeys);
});

test("a room requires two actors", async (t) => {
    const room = new Room("Small Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await assert.rejects(room.startRound(), /Need at least two actors/);
});

test("waiting rooms have no turn owner and allow every player to draw or discard", async (t) => {
    const room = new Room("Waiting Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.joinActor("Alice");
    const bob = await room.joinActor("Bob");
    alice.collection.add({ value: "5", suit: "clubs" });
    bob.collection.add({ value: "k", suit: "hearts" });

    await room.playItem("Alice", "5", "clubs");
    await room.playItem("Bob", "k", "hearts");

    assert.equal(room.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.turnOrder.owner, null);
    assert.equal(room.turnOrder.ownerKey, null);
    assert.equal(TurnUtils.hasTurnOwner(room.turnOrder.ownerKey), false);
    assert.equal(TurnUtils.isTurnOwner(room.turnOrder.ownerKey, alice.key), false);
    assert.throws(() => room.turnOrder.requireOwner(), /Turn owner is not assigned/);
    assert.equal(alice.collection.items.length, 0);
    assert.equal(bob.collection.items.length, 0);
    assert.equal(alice.drawAllowance, 1);
    assert.equal(bob.drawAllowance, 1);
    assert.equal(room.declaredSuit, null);
    assert.deepEqual(room.winners, []);
    assert.equal(room.getTopItem().id, "k-hearts");

    assert.equal((await room.drawItems("Alice")).length, 1);
    assert.equal((await room.drawItems("Bob")).length, 1);
    assert.equal(room.turnOrder.owner, null);
});

test("a null turn owner bypasses playing turn and card-legality checks", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = room.turnOrder.get("Alice");
    const bob = room.turnOrder.get("Bob");

    room.turnOrder.setOwner(null);
    bob.collection.addMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);

    await room.playItem(bob.name, Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS);

    alice.drawAllowance = 0;
    const drawn = await room.drawItems(alice.name);

    assert.equal(room.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.turnOrder.owner, null);
    assert.equal(room.getTopItem().id, "k-clubs");
    assert.equal(drawn.length, 1);
});

test("starting a round deals seven cards and selects an ordinary discard", async (t) => {
    const room = new Room("Started Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");
    await room.startRound();

    assert.equal(room.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.collections.play.items.length, 1);
    assert.equal(room.getTopItem().isSpecial(), false);
    assert.equal(room.turnOrder.owner === null, false);
    assert.equal(TurnUtils.hasTurnOwner(room.turnOrder.ownerKey), true);
    assert.equal(TurnUtils.isTurnOwner(room.turnOrder.ownerKey, room.turnOrder.requireOwner().key), true);

    for (const player of room.turnOrder.actors.values()) {
        assert.equal(player.collection.items.length, Constants.INITIAL_ITEM_COUNT);
    }

    assert.equal(room.collections.draw.items.length, 39);
});

test("the next actor command resumes a finished room before its waiting transaction", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const game = new Game();
    const alice = room.turnOrder.get("Alice");
    const bob = room.turnOrder.get("Bob");

    alice.collection.add(new Card("3", "clubs", 0));
    bob.collection.addMany([new Card("4", "diamonds", 0), new Card("6", "hearts", 0)]);
    room.state = Constants.ROOM_STATE.FINISHED;

    const finishedHands = [alice, bob].map((actor) => actor.collection.items.map((card) => card.id));

    await game.execute(room, "Alice", Constants.COMMANDS.DRAW, { sortKey: "none" });

    assert.equal(room.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.turnOrder.ownerKey, null);
    assert.equal(alice.collection.size, finishedHands[0].length + 1);
    assert.deepEqual(alice.collection.items.slice(0, finishedHands[0].length).map((card) => card.id), finishedHands[0]);
    assert.deepEqual(bob.collection.items.map((card) => card.id), finishedHands[1]);

    await room.startRound();

    assert.equal(room.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(alice.collection.size, Constants.INITIAL_ITEM_COUNT);
    assert.equal(bob.collection.size, Constants.INITIAL_ITEM_COUNT);
    assert.equal(room.collections.play.size, 1);
    assert.equal(room.collections.draw.size, 39);
});

test("only the turn owner can act and passing advances the turn", async (t) => {
    const room = new Room("Turn Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");
    await room.startRound();

    const current = room.turnOrder.owner;
    const other = [...room.turnOrder.actors.values()].find((player) => player.key !== current.key);
    const initialCount = current.collection.items.length;

    await assert.rejects(room.passTurn(other.name), /Not your turn/);
    const drawn = await room.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.collection.items.length, initialCount + 1);
    assert.equal(room.turnOrder.owner.key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = room.turnOrder.get("Alice");
    alice.drawAllowance = 2;

    const cards = await room.drawItems("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(room.turnOrder.owner.name, "Bob");

    room.turnOrder.setOwner("Alice");
    await assert.rejects(room.drawItems("Alice"), /No draw allowance remaining/);
    await assert.rejects(room.drawItems("Missing"), /Actor does not exist/);
});

test("drawing recycles every discard except the top card exactly once", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = room.turnOrder.get("Alice");
    const existingDrawCard = new Card("2", "clubs", 0);
    const recycledCards = [new Card("3", "diamonds", 0), new Card("4", "hearts", 0)];
    const topDiscard = new Card("5", "spades", 0);

    room.collections.draw.items = [existingDrawCard];
    room.collections.play.items = [...recycledCards, topDiscard];
    alice.drawAllowance = 3;

    const drawnCards = await room.drawItems("Alice");
    const drawnIds = drawnCards.map((card) => card.id);

    assert.deepEqual(room.collections.play.items.map((card) => card.id), [topDiscard.id]);
    assert.equal(room.collections.draw.size, 0);
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
        const room = await createPlayingSession(t);
        const alice = room.turnOrder.get("Alice");
        alice.collection.addMany([
            new Card(scenario.value, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);

        await room.playItem("Alice", scenario.value, Constants.CARD.SUIT.HEARTS);

        assert.equal(room.turnOrder.owner.name, scenario.expectedPlayer);
        assert.equal(room.turnOrder.owner.drawAllowance, scenario.expectedAllowance);
    }

    const suitSession = await createPlayingSession(t, ["Alice", "Bob"]);
    suitSession.turnOrder
        .get("Alice")
        .collection.addMany([
            new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);
    await suitSession.playItem("Alice", Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(suitSession.state, Constants.ROOM_STATE.ACTIVE);
    assert.deepEqual(suitSession.pending, {
        command: Constants.COMMANDS.DECLARE,
        actorKey: "alice"
    });
    assert.equal(await suitSession.declareSuit(Constants.CARD.SUIT.CLUBS), true);
    assert.equal(suitSession.declaredSuit, Constants.CARD.SUIT.CLUBS);
    assert.equal(suitSession.turnOrder.owner.name, "Bob");

    const finishSession = await createPlayingSession(t, ["Alice", "Bob"]);
    finishSession.turnOrder
        .get("Alice")
        .collection.add(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    finishSession.turnOrder
        .get("Bob")
        .collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS));
    await finishSession.playItem("Alice", Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(finishSession.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(finishSession.winners.includes("Alice"), true);
    assert.equal(finishSession.turnOrder.get("Bob").collection.score, 13);
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

    const player = await room.joinActor("Alice");
    player.collection.addMany([
        { value: "k", suit: "clubs" },
        { value: "3", suit: "hearts" },
        { value: "8", suit: "spades" }
    ]);

    await room.passTurn("Alice", "value");

    assert.deepEqual(player.collection.toArray().map(String), ["3-hearts", "8-spades", "k-clubs"]);
});

test("AI preserves the ace of spades when no draw attack is active", async (t) => {
    const ai = new BotActor("Bot");
    const originalSetTimeout = globalThis.setTimeout;
    let isCardDrawn = false;
    let isCardDiscarded = false;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.add(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES));
    ai.drawAllowance = 1;
    const turnOrder = new TurnOrder();

    turnOrder.add(ai);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card("5", Constants.CARD.SUIT.SPADES),
        drawItems: async () => {
            isCardDrawn = true;
        },
        playItem: async () => {
            isCardDiscarded = true;
        }
    };

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, true);
    assert.equal(isCardDiscarded, false);
    assert.equal(ai.collection.items.length, 1);
});

test("AI preserves an ace when another legal card is available", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    const discardedCardIds = [];

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)
    ]);
    turnOrder.add(ai);
    turnOrder.add(opponent);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).id);
        }
    };

    await ai.takeTurn(room);
    assert.deepEqual(discardedCardIds, ["5-clubs"]);

    ai.collection.clear();
    ai.collection.add(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(room);

    assert.deepEqual(discardedCardIds, ["5-clubs", "a-hearts"]);
});

test("AI uses its ace of spades against draw two without inspecting the next player's card", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let isCardDrawn = false;
    let isCardDiscarded = false;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.add(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES));
    ai.drawAllowance = 2;
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS));
    nextPlayer.collection.items = new Proxy(nextPlayer.collection.items, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {
            isCardDrawn = true;
        },
        playItem: async () => {
            isCardDiscarded = true;
        }
    };

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, false);
    assert.equal(isCardDiscarded, true);
});

test("AI treats a visible one-card count as a threat without reading the hidden card", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    nextPlayer.collection.items = new Proxy(nextPlayer.collection.items, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    Object.defineProperty(nextPlayer.collection, "score", {
        configurable: true,
        get() {
            throw new Error("AI inspected a hidden opponent score.");
        }
    });
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "5-clubs");
});

test("AI uses discard-pile card counting to reduce a one-card opponent's response chance", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS));
    nextPlayer.collection.items = new Proxy(nextPlayer.collection.items, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.setOwner(ai.name);

    const discardedHearts = [
        Constants.CARD.VALUE.TWO.id,
        Constants.CARD.VALUE.FOUR.id,
        Constants.CARD.VALUE.SIX.id,
        Constants.CARD.VALUE.SEVEN.id,
        Constants.CARD.VALUE.EIGHT.id,
        Constants.CARD.VALUE.NINE.id,
        Constants.CARD.VALUE.TEN.id,
        Constants.CARD.VALUE.JACK.id,
        Constants.CARD.VALUE.QUEEN.id,
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.VALUE.ACE.id
    ].map((value) => new Card(value, Constants.CARD.SUIT.HEARTS));
    const room = {
        turnOrder,
        declaredSuit: null,
        collections: {
            play: {
                items: [
                    ...discardedHearts,
                    new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS),
                    new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
                    new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.SPADES),
                    new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)
                ]
            }
        },
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("room remembers which player made the latest gameplay discard", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = room.turnOrder.get("Alice");

    room.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS)];
    alice.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);

    assert.equal(room.getLastDiscardActor(), null);

    await room.playItem(alice.name, Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS);

    assert.equal(room.getLastDiscardActor(), alice);
});

test("AI presses the suit after an opponent discards its lowest ordinary card", async (t) => {
    const ai = new BotActor("Bot");
    const previousPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    previousPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(previousPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getLastDiscardActor: () => previousPlayer,
        getTopItem: () => new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-diamonds");
});

test("AI ignores a low-discard suit inference when that opponent will not act next", async (t) => {
    const ai = new BotActor("Bot");
    const projectedPlayer = new Player("Alice", { drawAllowance: 1 });
    const previousPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    projectedPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES),
        new Card(Constants.CARD.VALUE.NINE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(projectedPlayer);
    turnOrder.add(previousPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getLastDiscardActor: () => previousPlayer,
        getTopItem: () => new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("AI uses a skip to bypass an immediate one-card opponent", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const followingPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    followingPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.add(followingPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "8-hearts");
});

test("AI uses a two-player skip to prepare an immediate final discard", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)
    ]);
    opponent.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.SPADES),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.HEARTS)
    ]);
    turnOrder.add(ai);
    turnOrder.add(opponent);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "8-clubs");
});

test("AI uses the visible card count of the player reached by a skip", async (t) => {
    const ai = new BotActor("Bot");
    const skippedPlayer = new Player("Alice", { drawAllowance: 1 });
    const projectedPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.HEARTS)
    ]);
    skippedPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    projectedPlayer.collection.add(new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(skippedPlayer);
    turnOrder.add(projectedPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "5-clubs");
});

test("AI uses the visible card count of the player reached by a reverse", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const reversedNextPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.JACK.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.CLUBS)
    ]);
    reversedNextPlayer.collection.add(new Card(Constants.CARD.VALUE.JACK.id, Constants.CARD.SUIT.CLUBS));
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.add(reversedNextPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("AI uses a suit-changing ace to take control against a visible one-card threat", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "a-hearts");
});

test("AI breaks equal suit strength toward the scarcest publicly unseen suit", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let declaredSuit = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);
    opponent.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(opponent);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        collections: {
            play: {
                items: [
                    Constants.CARD.VALUE.TWO.id,
                    Constants.CARD.VALUE.FIVE.id,
                    Constants.CARD.VALUE.SIX.id,
                    Constants.CARD.VALUE.SEVEN.id,
                    Constants.CARD.VALUE.EIGHT.id,
                    Constants.CARD.VALUE.NINE.id,
                    Constants.CARD.VALUE.TEN.id,
                    Constants.CARD.VALUE.JACK.id,
                    Constants.CARD.VALUE.QUEEN.id,
                    Constants.CARD.VALUE.KING.id
                ].map((value) => new Card(value, Constants.CARD.SUIT.CLUBS))
            }
        },
        declareSuit: async (suit) => {
            declaredSuit = suit;
        }
    };

    await ai.chooseSuit(room);

    assert.equal(declaredSuit, Constants.CARD.SUIT.CLUBS);
});

test("AI forces a visible one-card opponent to draw when legally possible", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-hearts");
});

test("AI starts pressuring an opponent before they reach one card", async (t) => {
    const ai = new BotActor("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
    nextPlayer.collection.items = new Proxy(nextPlayer.collection.items, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    turnOrder.add(ai);
    turnOrder.add(nextPlayer);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        collections: {
            play: {
                items: [
                    new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.CLUBS),
                    new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
                    new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.SPADES),
                    new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.BLACK),
                    new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.RED),
                    new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES),
                    new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)
                ]
            }
        },
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-hearts");
});

test("AI releases seven of hearts only when its public score estimate is favorable", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const otherOpponent = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const originalSetTimeout = globalThis.setTimeout;
    const discardedCardIds = [];
    let drawCount = 0;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);
    opponent.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.SPADES)
    ]);
    otherOpponent.collection.addMany([
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.SPADES)
    ]);

    for (const hiddenOpponent of [opponent, otherOpponent]) {
        hiddenOpponent.collection.items = new Proxy(hiddenOpponent.collection.items, {
            get(target, property, receiver) {
                if (property !== "length") {
                    throw new Error("AI inspected a hidden opponent card.");
                }

                return Reflect.get(target, property, receiver);
            }
        });
        Object.defineProperty(hiddenOpponent.collection, "score", {
            configurable: true,
            get() {
                throw new Error("AI inspected a hidden opponent score.");
            }
        });
    }

    turnOrder.add(ai);
    turnOrder.add(opponent);
    turnOrder.add(otherOpponent);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {
            drawCount += 1;
        },
        playItem: async (playerName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).id);
        }
    };

    await ai.takeTurn(room);

    assert.equal(drawCount, 0);
    assert.deepEqual(discardedCardIds, ["7-hearts"]);

    ai.collection.clear();
    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES)
    ]);
    await ai.takeTurn(room);

    assert.equal(drawCount, 1);
    assert.deepEqual(discardedCardIds, ["7-hearts"]);

    ai.collection.clear();
    ai.collection.add(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(room);

    assert.equal(drawCount, 1);
    assert.deepEqual(discardedCardIds, ["7-hearts", "7-hearts"]);
});
