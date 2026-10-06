"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../core/Card.js";
import { Constants } from "../core/Constants.js";
import { Host } from "../host/Host.js";
import { Actor } from "../core/Actor.js";
import { BotActor } from "../core/BotActor.js";
import { TurnOrder } from "../core/TurnOrder.js";
import { Room } from "../core/Room.js";
import { StateMapper } from "../core/StateMapper.js";

function stopIdleMonitoring(room) {
    for (const actor of room.match.turnOrder.actors.values()) {
        actor.stopIdleMonitoring();
    }
}

test("room perform dispatches card commands through the serialized actions", async (t) => {
    const room = new Room("Command Gateway", 2);
    t.after(() => stopIdleMonitoring(room));
    await room.joinActor("Alice");
    await room.joinActor("Bob");
    const drawn = await room.perform(Constants.COMMANDS.DRAW, "Alice");
    assert.equal(drawn.length, 1);
    await assert.rejects(room.perform("unknown", "Alice"), /Unknown match command/);
});

async function createPlayingSession(t, actorNames = ["Alice", "Bob", "Casey"]) {
    const room = new Room(`Rules ${Math.floor(Math.random() * 1000000)}`, actorNames.length);
    t.after(() => stopIdleMonitoring(room));

    for (const name of actorNames) {
        await room.joinActor(name);
    }

    room.match.state = Constants.ROOM_STATE.ACTIVE;
    room.match.turnOrder.setOwner(actorNames[0]);
    room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)];

    for (const actor of room.match.turnOrder.actors.values()) {
        actor.collection.clear();
        actor.drawAllowance = 1;
    }

    return room;
}

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
    await room.joinActor("Alice");
    await room.joinActor("Bob");
    await room.startMatch();
    const collections = JSON.stringify(room.match.collections);
    const hands = JSON.stringify(Array.from(room.match.turnOrder.actors.values(), function mapHand(actor) {
        return actor.collection;
    }));
    room.match.state = Constants.ROOM_STATE.FINISHED;

    assert.equal(await room.resumeWaiting(), undefined);
    assert.equal(room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.match.turnOrder.ownerKey, null);
    assert.equal(room.match.turnOrder.actors.size, 2);
    assert.equal(JSON.stringify(room.match.collections), collections);
    assert.equal(
        JSON.stringify(Array.from(room.match.turnOrder.actors.values(), function mapHand(actor) {
            return actor.collection;
        })),
        hands
    );
});

test("game membership enforces uniqueness and actor limit", async (t) => {
    const room = new Room("Test Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");

    assert.equal(room.isFull(), true);
    assert.equal(room.hasActor("alice"), true);
    await assert.rejects(room.joinActor("Casey"), /Room is full/);
});

test("a viewer can join the room as an actor", async (t) => {
    const room = new Room("Viewed Game", 2);
    t.after(() => stopIdleMonitoring(room));

    room.view("tab-1");
    assert.equal(room.viewers.has("tab-1"), true);
    const actor = await room.joinActor("Alice", false, "tab-1");

    assert.equal(actor.name, "Alice");
    assert.equal(room.viewers.has("tab-1"), false);
    assert.equal(room.hasActor("Alice"), true);
    await assert.rejects(room.joinActor("Bob", false, "missing"), /Viewer not found/);
});

test("actor activity belongs to the actor and room, not the turnOrder", async (t) => {
    const room = new Room("Activity Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.joinActor("Alice");
    await room.joinActor("Bob");
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

test("rooms support viewing, idle-actor removal, and leaving", async (t) => {
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

test("actors and viewers can leave while a room is active", async (t) => {
    const room = await createPlayingSession(t);

    room.view("active-viewer");
    assert.equal(room.viewers.has("active-viewer"), true);
    assert.equal((await room.removeActor("Alice")).name, "Alice");
    room.leaveViewer("active-viewer");
    assert.equal(room.viewers.has("active-viewer"), false);
    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.hasActor("Alice"), false);
    assert.equal(room.viewers.has("active-viewer"), false);
});

test("room data uses one actor shape and localActorName identifies the local actor", async (t) => {
    const room = new Room("Data Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");

    const localPayload = StateMapper.toRoomData(room, "Alice");
    const viewerPayload = StateMapper.toRoomData(room, null);
    const expectedKeys = ["collection", "drawAllowance", "key", "name", "state"];

    assert.equal(localPayload.localActorName, "Alice");
    assert.equal(viewerPayload.localActorName, null);
    assert.equal(localPayload.match.turnOrder.ownerKey, null);
    assert.deepEqual(Object.keys(localPayload.match.turnOrder.actors[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.match.turnOrder.actors[1]).sort(), expectedKeys);
});

test("a room requires two actors", async (t) => {
    const room = new Room("Small Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await assert.rejects(room.startMatch(), /Need at least two actors/);
});

test("waiting rooms have no turn owner and allow every actor to draw or discard", async (t) => {
    const room = new Room("Waiting Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.joinActor("Alice");
    const bob = await room.joinActor("Bob");
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
    assert.equal([...room.match.turnOrder.actors.values()].some(function won(actor) {
        return actor.state === Constants.ACTOR_STATE.WON;
    }), false);
    assert.equal(room.match.getTopItem().id, "k-hearts");

    assert.equal((await room.drawItems("Alice")).length, 1);
    assert.equal((await room.drawItems("Bob")).length, 1);
    assert.equal(room.match.turnOrder.owner, null);
});

test("a null turn owner bypasses playing turn and card-legality checks", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
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

    await room.joinActor("Alice");
    await room.joinActor("Bob");
    assert.deepEqual(await room.startMatch(), []);

    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(room.match.collections.play.items.length, 1);
    assert.equal(room.match.getTopItem().isSpecial(), false);
    assert.equal(room.match.turnOrder.owner === null, false);
    assert.equal(room.match.turnOrder.ownerKey, room.match.turnOrder.requireOwner().key);

    for (const actor of room.match.turnOrder.actors.values()) {
        assert.equal(actor.collection.items.length, Constants.INITIAL_ITEM_COUNT);
    }

    assert.equal(room.match.collections.draw.items.length, 39);
});

test("the next actor command resumes a finished room before its waiting transaction", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const host = new Host("direct", 0, false);
    t.after(() => host.shutdown());
    const alice = room.match.turnOrder.get("Alice");
    const bob = room.match.turnOrder.get("Bob");

    alice.collection.add(new Card("3", "clubs", 0));
    bob.collection.addMany([new Card("4", "diamonds", 0), new Card("6", "hearts", 0)]);
    room.match.state = Constants.ROOM_STATE.FINISHED;

    const finishedHands = [alice, bob].map((actor) => actor.collection.items.map((card) => card.id));

    await host.executeMatchCommand(room, "Alice", Constants.COMMANDS.DRAW, { sortKey: "none" });

    assert.equal(room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.match.turnOrder.ownerKey, null);
    assert.equal(alice.collection.size, finishedHands[0].length + 1);
    assert.deepEqual(alice.collection.items.slice(0, finishedHands[0].length).map((card) => card.id), finishedHands[0]);
    assert.deepEqual(bob.collection.items.map((card) => card.id), finishedHands[1]);

    await room.startMatch();

    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(alice.collection.size, Constants.INITIAL_ITEM_COUNT);
    assert.equal(bob.collection.size, Constants.INITIAL_ITEM_COUNT);
    assert.equal(room.match.collections.play.size, 1);
    assert.equal(room.match.collections.draw.size, 39);
});

test("only the turn owner can act and passing advances the turn", async (t) => {
    const room = new Room("Turn Game", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.joinActor("Alice");
    await room.joinActor("Bob");
    await room.startMatch();

    const current = room.match.turnOrder.owner;
    const other = [...room.match.turnOrder.actors.values()].find((actor) => actor.key !== current.key);
    const initialCount = current.collection.items.length;

    await assert.rejects(room.passTurn(other.name), /Not your turn/);
    const drawn = await room.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.collection.items.length, initialCount + 1);
    assert.equal(room.match.turnOrder.owner.key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = room.match.turnOrder.get("Alice");
    alice.drawAllowance = 2;

    const cards = await room.drawItems("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(room.match.turnOrder.owner.name, "Bob");

    room.match.turnOrder.setOwner("Alice");
    await assert.rejects(room.drawItems("Alice"), /No draw allowance remaining/);
    await assert.rejects(room.drawItems("Missing"), /Actor does not exist/);
});

test("drawing recycles every discard except the top card exactly once", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
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
        { value: Constants.CARD.VALUE.EIGHT.id, expectedActor: "Casey", expectedAllowance: 1 },
        { value: Constants.CARD.VALUE.JACK.id, expectedActor: "Casey", expectedAllowance: 1 },
        { value: Constants.CARD.VALUE.TWO.id, expectedActor: "Bob", expectedAllowance: 2 }
    ];

    for (const scenario of scenarios) {
        const room = await createPlayingSession(t);
        const alice = room.match.turnOrder.get("Alice");
        alice.collection.addMany([
            new Card(scenario.value, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);

        await room.playItem("Alice", scenario.value, Constants.CARD.SUIT.HEARTS);

        assert.equal(room.match.turnOrder.owner.name, scenario.expectedActor);
        assert.equal(room.match.turnOrder.owner.drawAllowance, scenario.expectedAllowance);
    }

    const suitSession = await createPlayingSession(t, ["Alice", "Bob"]);
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
        actorKey: "alice"
    });
    assert.equal(await suitSession.declareSuit(Constants.CARD.SUIT.CLUBS), undefined);
    assert.equal(suitSession.match.declaredSuit, Constants.CARD.SUIT.CLUBS);
    assert.equal(suitSession.match.turnOrder.owner.name, "Bob");

    const finishSession = await createPlayingSession(t, ["Alice", "Bob"]);
    finishSession.match.turnOrder
        .get("Alice")
        .collection.add(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    finishSession.match.turnOrder
        .get("Bob")
        .collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS));
    await finishSession.playItem("Alice", Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(finishSession.match.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(finishSession.match.turnOrder.get("Alice").state, Constants.ACTOR_STATE.WON);
    assert.equal(finishSession.match.turnOrder.get("Bob").collection.penalty, 13);
});

test("game input validation rejects invalid actor limit and suit", async (t) => {
    assert.throws(() => new Room("Invalid", 1), /Limit must be between/);
    assert.throws(() => Room.normalizeSuit("purple"), /Invalid suit/);

    const room = new Room("Suit Game", 2);
    t.after(() => stopIdleMonitoring(room));
    await assert.rejects(room.declareSuit("hearts"), /No suit pending declaration/);
});

test("a room commits the selected card order when the actor moves", async (t) => {
    const room = new Room("Sort Game", 2);
    t.after(() => stopIdleMonitoring(room));

    const actor = await room.joinActor("Alice");
    actor.collection.addMany([
        { value: "k", suit: "clubs" },
        { value: "3", suit: "hearts" },
        { value: "8", suit: "spades" }
    ]);

    await room.passTurn("Alice", "rank");

    assert.deepEqual(actor.collection.items.map(String), ["3-hearts", "8-spades", "k-clubs"]);
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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, true);
    assert.equal(isCardDiscarded, false);
    assert.equal(ai.collection.items.length, 1);
});

test("AI preserves an ace when another legal card is available", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Actor("Alice", { drawAllowance: 1 });
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
        playItem: async (actorName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).id);
        }
    };
    room.match = room;

    await ai.takeTurn(room);
    assert.deepEqual(discardedCardIds, ["5-clubs"]);

    ai.collection.clear();
    ai.collection.add(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(room);

    assert.deepEqual(discardedCardIds, ["5-clubs", "a-hearts"]);
});

test("hard-mode AI uses its ace of spades against draw two", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
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
    nextActor.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS));
    turnOrder.add(ai);
    turnOrder.add(nextActor);
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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, false);
    assert.equal(isCardDiscarded, true);
});

test("hard-mode AI avoids matching the next actor's final card", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
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
    nextActor.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    Object.defineProperty(nextActor.collection, "penalty", {
        configurable: true,
        get() {
            throw new Error("AI inspected a hidden opponent penalty.");
        }
    });
    turnOrder.add(ai);
    turnOrder.add(nextActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("hard-mode AI sheds more penalty when neither choice matches the final opponent card", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
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
    nextActor.collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(nextActor);
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
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "5-clubs");
});

test("room remembers which actor made the latest gameplay discard", async (t) => {
    const room = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = room.match.turnOrder.get("Alice");

    room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS)];
    alice.collection.addMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);

    assert.equal(room.match.getLastDiscardActor(), null);

    await room.playItem(alice.name, Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS);

    assert.equal(room.match.getLastDiscardActor(), alice);
});

test("AI presses the suit after an opponent discards its lowest ordinary card", async (t) => {
    const ai = new BotActor("Bot");
    const previousActor = new Actor("Alice", { drawAllowance: 1 });
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
    previousActor.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(previousActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getLastDiscardActor: () => previousActor,
        getTopItem: () => new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-diamonds");
});

test("AI ignores a low-discard suit inference when that opponent will not act next", async (t) => {
    const ai = new BotActor("Bot");
    const projectedActor = new Actor("Alice", { drawAllowance: 1 });
    const previousActor = new Actor("Casey", { drawAllowance: 1 });
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
    projectedActor.collection.addMany([
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES),
        new Card(Constants.CARD.VALUE.NINE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(projectedActor);
    turnOrder.add(previousActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getLastDiscardActor: () => previousActor,
        getTopItem: () => new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("AI uses a skip to bypass an immediate one-card opponent", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
    const followingActor = new Actor("Casey", { drawAllowance: 1 });
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
    nextActor.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    followingActor.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(nextActor);
    turnOrder.add(followingActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "8-hearts");
});

test("AI uses a two-actor skip to prepare an immediate final discard", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Actor("Alice", { drawAllowance: 1 });
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
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "8-clubs");
});

test("AI uses the visible card count of the actor reached by a skip", async (t) => {
    const ai = new BotActor("Bot");
    const skippedActor = new Actor("Alice", { drawAllowance: 1 });
    const projectedActor = new Actor("Casey", { drawAllowance: 1 });
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
    skippedActor.collection.addMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    projectedActor.collection.add(new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(skippedActor);
    turnOrder.add(projectedActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "5-clubs");
});

test("AI uses the visible card count of the actor reached by a reverse", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
    const reversedNextActor = new Actor("Casey", { drawAllowance: 1 });
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
    nextActor.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.CLUBS)
    ]);
    reversedNextActor.collection.add(new Card(Constants.CARD.VALUE.JACK.id, Constants.CARD.SUIT.CLUBS));
    turnOrder.add(ai);
    turnOrder.add(nextActor);
    turnOrder.add(reversedNextActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("AI uses a suit-changing ace to take control against a visible one-card threat", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
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
    nextActor.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(nextActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "a-hearts");
});

test("AI breaks equal suit strength toward the scarcest publicly unseen suit", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Actor("Alice", { drawAllowance: 1 });
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
    room.match = room;

    await ai.chooseSuit(room);

    assert.equal(declaredSuit, Constants.CARD.SUIT.CLUBS);
});

test("AI forces a visible one-card opponent to draw when legally possible", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
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
    nextActor.collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS));
    turnOrder.add(ai);
    turnOrder.add(nextActor);
    turnOrder.setOwner(ai.name);

    const room = {
        turnOrder,
        declaredSuit: null,
        getTopItem: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawItems: async () => {},
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-hearts");
});

test("AI starts pressuring an opponent before they reach one card", async (t) => {
    const ai = new BotActor("Bot");
    const nextActor = new Actor("Alice", { drawAllowance: 1 });
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
    nextActor.collection.addMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
    turnOrder.add(ai);
    turnOrder.add(nextActor);
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
        playItem: async (actorName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-hearts");
});

test("hard-mode AI releases seven of hearts only when remaining penalties are favorable", async (t) => {
    const ai = new BotActor("Bot");
    const opponent = new Actor("Alice", { drawAllowance: 1 });
    const otherOpponent = new Actor("Casey", { drawAllowance: 1 });
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
        Object.defineProperty(hiddenOpponent.collection, "penalty", {
            configurable: true,
            get() {
                throw new Error("AI inspected a hidden opponent penalty.");
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
        playItem: async (actorName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).id);
        }
    };
    room.match = room;

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
