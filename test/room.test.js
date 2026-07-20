"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../public/scripts/Constants.js";
import { Card } from "../server/Card.js";
import { AIPlayer, Player } from "../server/Player.js";
import { PlayerCircle } from "../server/PlayerCircle.js";
import { Room } from "../server/Room.js";
import { StateMapper } from "../server/StateMapper.js";

function stopIdleMonitoring(room) {
    for (const player of room.circle.players.values()) {
        player.stopIdleMonitoring();
    }
}

async function createPlayingRoom(t, playerNames = ["Alice", "Bob", "Casey"]) {
    const room = new Room(`Rules ${Math.random()}`, playerNames.length);
    t.after(() => stopIdleMonitoring(room));

    for (const name of playerNames) {
        await room.admitPlayer(name);
    }

    room.status = Constants.STATUS.PLAYING;
    room.circle.setCurrentPlayer(playerNames[0]);
    room.discardPile = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)];

    for (const player of room.circle.players.values()) {
        player.hand.clear();
        player.drawAllowance = 1;
    }

    return room;
}

test("room lifecycle predicates describe active and membership-locked states", () => {
    const room = new Room("Lifecycle Room", 2);

    assert.equal(room.isGameActive(), false);
    assert.equal(room.isMembershipLocked(), false);

    for (const status of [Constants.STATUS.PLAYING, Constants.STATUS.PENDING]) {
        room.status = status;
        assert.equal(room.isGameActive(), true);
        assert.equal(room.isMembershipLocked(), true);
    }

    room.status = Constants.STATUS.FINISHED;
    assert.equal(room.isGameActive(), false);
    assert.equal(room.isMembershipLocked(), false);
});

test("room membership enforces uniqueness and capacity", async (t) => {
    const room = new Room("Test Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");

    assert.equal(room.isFull(), true);
    assert.equal(room.isPlayerPresent("alice"), true);
    await assert.rejects(room.admitPlayer("Casey"), /Room is full/);
});

test("visitors can be promoted to players", async (t) => {
    const room = new Room("Promotion Room", 2);
    t.after(() => stopIdleMonitoring(room));

    assert.equal(room.admitVisitor("tab-1"), true);
    const player = await room.promoteVisitor("tab-1", "Alice");

    assert.equal(player.name, "Alice");
    assert.equal(room.visitors.has("tab-1"), false);
    assert.equal(room.isPlayerPresent("Alice"), true);
    await assert.rejects(room.promoteVisitor("missing", "Bob"), /Visitor not found/);
});

test("room membership supports visitor eviction, player demotion, and player eviction", async (t) => {
    const room = new Room("Transitions", 3);
    t.after(() => stopIdleMonitoring(room));

    assert.equal(room.admitVisitor("visitor-1"), true);
    assert.equal(room.admitVisitor("visitor-1"), false);
    assert.equal(room.evictVisitor("visitor-1"), true);
    assert.equal(room.evictVisitor("visitor-1"), false);

    const alice = await room.admitPlayer("Alice");
    alice.hand.draw(new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS));
    assert.equal((await room.demotePlayer("Alice", "alice-tab")).name, "Alice");
    assert.equal(room.visitors.has("alice-tab"), true);
    assert.equal(room.isPlayerPresent("Alice"), false);
    await assert.rejects(room.demotePlayer("missing", "tab"), /Player does not exist/);

    await room.admitPlayer("Bob");
    assert.equal((await room.evictPlayer("Bob")).name, "Bob");
    await assert.rejects(room.evictPlayer("Bob"), /Player does not exist/);
    assert.equal(room.isEmpty(), true);
});

test("room payload uses one player shape and session identifies the local player", async (t) => {
    const room = new Room("Payload Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");

    const localPayload = StateMapper.toRoomPayload(room, "Alice");
    const visitorPayload = StateMapper.toRoomPayload(room, null);
    const expectedKeys = [
        "cardCount",
        "cards",
        "drawAllowance",
        "isActive",
        "isConnected",
        "isWinner",
        "name",
        "score"
    ];

    assert.equal(localPayload.session.playerName, "Alice");
    assert.equal(visitorPayload.session.playerName, null);
    assert.deepEqual(Object.keys(localPayload.players[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.players[1]).sort(), expectedKeys);
});

test("a game requires two players", async (t) => {
    const room = new Room("Small Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await assert.rejects(room.startGame(), /Need at least two players/);
});

test("non-playing rooms allow any discard without applying game rules", async (t) => {
    const room = new Room("Waiting Room", 2);
    t.after(() => stopIdleMonitoring(room));

    const player = await room.admitPlayer("Alice");
    player.hand.drawMany([
        { value: "5", suit: "clubs" },
        { value: "k", suit: "hearts" }
    ]);

    await room.discardCard("Alice", "5", "clubs");
    await room.discardCard("Alice", "k", "hearts");

    assert.equal(player.hand.cards.length, 0);
    assert.equal(room.status, Constants.STATUS.WAITING);
    assert.equal(player.drawAllowance, 1);
    assert.equal(room.declaredSuit, null);
    assert.deepEqual(room.winners, []);
    assert.equal(room.getTopDiscard().getId(), "k-hearts");
});

test("starting a game deals seven cards and selects an ordinary discard", async (t) => {
    const room = new Room("Game Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");
    await room.startGame();

    assert.equal(room.status, Constants.STATUS.PLAYING);
    assert.equal(room.discardPile.length, 1);
    assert.equal(room.getTopDiscard().isSpecial(), false);
    assert.equal(room.getCurrentPlayer() === null, false);

    for (const player of room.circle.players.values()) {
        assert.equal(player.hand.cards.length, Constants.PLAYER_INITIAL_CARD_COUNT);
    }

    assert.equal(room.deck.cards.length, 39);
});

test("only the current player can act and passing advances the turn", async (t) => {
    const room = new Room("Turn Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");
    await room.startGame();

    const current = room.getCurrentPlayer();
    const other = [...room.circle.players.values()].find((player) => player.key !== current.key);
    const initialCount = current.hand.cards.length;

    await assert.rejects(room.passTurn(other.name), /Not your turn/);
    const drawn = await room.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.hand.cards.length, initialCount + 1);
    assert.equal(room.getCurrentPlayer().key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.circle.getPlayer("Alice");
    alice.drawAllowance = 2;

    const cards = await room.drawCards("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(room.getCurrentPlayer().name, "Bob");

    room.circle.setCurrentPlayer("Alice");
    await assert.rejects(room.drawCards("Alice"), /No draw allowance remaining/);
    await assert.rejects(room.drawCards("Missing"), /Player does not exist/);
});

test("special discards apply skip, reverse, draw, suit, and game-ending effects", async (t) => {
    const scenarios = [
        {value: Constants.CARD.VALUE.EIGHT.id, expectedPlayer: "Casey", expectedAllowance: 1},
        {value: Constants.CARD.VALUE.JACK.id, expectedPlayer: "Casey", expectedAllowance: 1},
        {value: Constants.CARD.VALUE.TWO.id, expectedPlayer: "Bob", expectedAllowance: 2}
    ];

    for (const scenario of scenarios) {
        const room = await createPlayingRoom(t);
        const alice = room.circle.getPlayer("Alice");
        alice.hand.drawMany([
            new Card(scenario.value, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);

        await room.discardCard("Alice", scenario.value, Constants.CARD.SUIT.HEARTS);

        assert.equal(room.getCurrentPlayer().name, scenario.expectedPlayer);
        assert.equal(room.getCurrentPlayer().drawAllowance, scenario.expectedAllowance);
    }

    const suitRoom = await createPlayingRoom(t, ["Alice", "Bob"]);
    suitRoom.circle.getPlayer("Alice").hand.drawMany([
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);
    await suitRoom.discardCard("Alice", Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(suitRoom.status, Constants.STATUS.PENDING);
    assert.equal(await suitRoom.declareSuit(Constants.CARD.SUIT.CLUBS), true);
    assert.equal(suitRoom.declaredSuit, Constants.CARD.SUIT.CLUBS);
    assert.equal(suitRoom.getCurrentPlayer().name, "Bob");

    const finishRoom = await createPlayingRoom(t, ["Alice", "Bob"]);
    finishRoom.circle.getPlayer("Alice").hand.draw(new Card(
        Constants.CARD.VALUE.SEVEN.id,
        Constants.CARD.SUIT.HEARTS
    ));
    finishRoom.circle.getPlayer("Bob").hand.draw(new Card(
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.SUIT.CLUBS
    ));
    await finishRoom.discardCard("Alice", Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(finishRoom.status, Constants.STATUS.FINISHED);
    assert.equal(finishRoom.winners.includes("Alice"), true);
    assert.equal(finishRoom.scores.Bob, 13);
});

test("room input validation rejects invalid capacity and suit", async (t) => {
    assert.throws(() => new Room("Invalid", 1), /Capacity must be between/);
    assert.throws(() => Room.normalizeSuit("purple"), /Invalid suit/);

    const room = new Room("Suit Room", 2);
    t.after(() => stopIdleMonitoring(room));
    await assert.rejects(room.declareSuit("hearts"), /No suit pending declaration/);
});

test("a room commits the selected card order when the player moves", async (t) => {
    const room = new Room("Sort Room", 2);
    t.after(() => stopIdleMonitoring(room));

    const player = await room.admitPlayer("Alice");
    player.hand.drawMany([
        { value: "k", suit: "clubs" },
        { value: "3", suit: "hearts" },
        { value: "8", suit: "spades" }
    ]);

    await room.passTurn("Alice", "value");

    assert.deepEqual(player.hand.toArray().map(String), ["3-hearts", "8-spades", "k-clubs"]);
});

test("AI preserves the ace of spades when no draw attack is active", async (t) => {
    const ai = new AIPlayer("Bot");
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

    ai.hand.draw(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES));
    ai.drawAllowance = 1;

    const room = {
        declaredSuit: null,
        getCurrentPlayer: () => ai,
        getTopDiscard: () => new Card("5", Constants.CARD.SUIT.SPADES),
        drawCards: async () => {
            isCardDrawn = true;
        },
        discardCard: async () => {
            isCardDiscarded = true;
        }
    };

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, true);
    assert.equal(isCardDiscarded, false);
    assert.equal(ai.hand.cards.length, 1);
});

test("AI accepts draw two when its ace of spades is the only defense and the next player cannot finish", async (t) => {
    const ai = new AIPlayer("Bot");
    const nextPlayer = new Player("Alice");
    const circle = new PlayerCircle();
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

    ai.hand.draw(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES));
    ai.drawAllowance = 2;
    nextPlayer.hand.draw(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS));
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setCurrentPlayer(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getCurrentPlayer: () => ai,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {
            isCardDrawn = true;
        },
        discardCard: async () => {
            isCardDiscarded = true;
        }
    };

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, true);
    assert.equal(isCardDiscarded, false);

    nextPlayer.hand.clear();
    nextPlayer.hand.draw(new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.CLUBS));
    isCardDrawn = false;
    await ai.takeTurn(room);

    assert.equal(isCardDrawn, false);
    assert.equal(isCardDiscarded, true);
});

test("AI prefers a discard that blocks the next player's final card", async (t) => {
    const ai = new AIPlayer("Bot");
    const nextPlayer = new Player("Alice");
    const circle = new PlayerCircle();
    const originalSetTimeout = globalThis.setTimeout;
    let discardedCard = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.hand.drawMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.hand.draw(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setCurrentPlayer(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getCurrentPlayer: () => ai,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "3-hearts");
});
