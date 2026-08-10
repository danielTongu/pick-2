"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../src/core/Card.js";
import { Constants } from "../src/core/Constants.js";
import { AIPlayer, Player } from "../src/core/Player.js";
import { PlayerCircle } from "../src/core/PlayerCircle.js";
import { Room } from "../src/core/Room.js";
import { StateMapper } from "../src/core/StateMapper.js";
import { TurnUtils } from "../src/core/TurnUtils.js";

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
    room.circle.setTurnOwner(playerNames[0]);
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

test("stopping a completed round returns the same table to waiting", async (t) => {
    const room = new Room("Completed Table", 2);

    t.after(() => stopIdleMonitoring(room));
    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");
    await room.startGame();
    room.status = Constants.STATUS.FINISHED;

    assert.equal(await room.stopGame(), true);
    assert.equal(room.status, Constants.STATUS.WAITING);
    assert.equal(room.circle.turnOwnerKey, null);
    assert.equal(room.circle.players.size, 2);
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

test("players and visitors can exit while a game is active", async (t) => {
    const room = await createPlayingRoom(t);

    assert.equal(room.admitVisitor("active-visitor"), true);
    assert.equal((await room.evictPlayer("Alice")).name, "Alice");
    assert.equal(room.evictVisitor("active-visitor"), true);
    assert.equal(room.status, Constants.STATUS.PLAYING);
    assert.equal(room.isPlayerPresent("Alice"), false);
    assert.equal(room.visitors.has("active-visitor"), false);
});

test("room payload uses one player shape and session identifies the local player", async (t) => {
    const room = new Room("Payload Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");

    const localPayload = StateMapper.toRoomPayload(room, "Alice");
    const visitorPayload = StateMapper.toRoomPayload(room, null);
    const expectedKeys = [
        "drawAllowance",
        "hand",
        "isWinner",
        "key",
        "name"
    ];

    assert.equal(localPayload.session.playerName, "Alice");
    assert.equal(visitorPayload.session.playerName, null);
    assert.equal(localPayload.circle.turnOwnerKey, null);
    assert.deepEqual(Object.keys(localPayload.circle.players[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.circle.players[1]).sort(), expectedKeys);
});

test("a game requires two players", async (t) => {
    const room = new Room("Small Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await assert.rejects(room.startGame(), /Need at least two players/);
});

test("waiting rooms have no turn owner and allow every player to draw or discard", async (t) => {
    const room = new Room("Waiting Room", 2);
    t.after(() => stopIdleMonitoring(room));

    const alice = await room.admitPlayer("Alice");
    const bob = await room.admitPlayer("Bob");
    alice.hand.draw({ value: "5", suit: "clubs" });
    bob.hand.draw({ value: "k", suit: "hearts" });

    await room.discardCard("Alice", "5", "clubs");
    await room.discardCard("Bob", "k", "hearts");

    assert.equal(room.status, Constants.STATUS.WAITING);
    assert.equal(room.circle.getTurnOwner(), null);
    assert.equal(room.circle.turnOwnerKey, null);
    assert.equal(TurnUtils.hasTurnOwner(room.circle.turnOwnerKey), false);
    assert.equal(TurnUtils.isTurnOwner(room.circle.turnOwnerKey, alice.key), false);
    assert.throws(() => room.circle.requireTurnOwner(), /Turn owner is not assigned/);
    assert.equal(alice.hand.cards.length, 0);
    assert.equal(bob.hand.cards.length, 0);
    assert.equal(alice.drawAllowance, 1);
    assert.equal(bob.drawAllowance, 1);
    assert.equal(room.declaredSuit, null);
    assert.deepEqual(room.winners, []);
    assert.equal(room.getTopDiscard().getId(), "k-hearts");

    assert.equal((await room.drawCards("Alice")).length, 1);
    assert.equal((await room.drawCards("Bob")).length, 1);
    assert.equal(room.circle.getTurnOwner(), null);
});

test("a null turn owner bypasses playing turn and card-legality checks", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.circle.getPlayer("Alice");
    const bob = room.circle.getPlayer("Bob");

    room.circle.setTurnOwner(null);
    bob.hand.drawMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);

    await room.discardCard(
        bob.name,
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.SUIT.CLUBS
    );

    alice.drawAllowance = 0;
    const drawn = await room.drawCards(alice.name);

    assert.equal(room.status, Constants.STATUS.PLAYING);
    assert.equal(room.circle.getTurnOwner(), null);
    assert.equal(room.getTopDiscard().getId(), "k-clubs");
    assert.equal(drawn.length, 1);
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
    assert.equal(room.circle.getTurnOwner() === null, false);
    assert.equal(TurnUtils.hasTurnOwner(room.circle.turnOwnerKey), true);
    assert.equal(
        TurnUtils.isTurnOwner(room.circle.turnOwnerKey, room.circle.requireTurnOwner().key),
        true
    );

    for (const player of room.circle.players.values()) {
        assert.equal(player.hand.cards.length, Constants.PLAYER_INITIAL_CARD_COUNT);
    }

    assert.equal(room.deck.cards.length, 39);
});

test("only the turn owner can act and passing advances the turn", async (t) => {
    const room = new Room("Turn Room", 2);
    t.after(() => stopIdleMonitoring(room));

    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");
    await room.startGame();

    const current = room.circle.getTurnOwner();
    const other = [...room.circle.players.values()].find((player) => player.key !== current.key);
    const initialCount = current.hand.cards.length;

    await assert.rejects(room.passTurn(other.name), /Not your turn/);
    const drawn = await room.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.hand.cards.length, initialCount + 1);
    assert.equal(room.circle.getTurnOwner().key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.circle.getPlayer("Alice");
    alice.drawAllowance = 2;

    const cards = await room.drawCards("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(room.circle.getTurnOwner().name, "Bob");

    room.circle.setTurnOwner("Alice");
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

        assert.equal(room.circle.getTurnOwner().name, scenario.expectedPlayer);
        assert.equal(room.circle.getTurnOwner().drawAllowance, scenario.expectedAllowance);
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
    assert.equal(suitRoom.circle.getTurnOwner().name, "Bob");

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
    const circle = new PlayerCircle();

    circle.addPlayer(ai);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
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

test("AI preserves an ace when another legal card is available", async (t) => {
    const ai = new AIPlayer("Bot");
    const opponent = new Player("Alice");
    const circle = new PlayerCircle();
    const originalSetTimeout = globalThis.setTimeout;
    const discardedCardIds = [];

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.hand.drawMany([
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)
    ]);
    circle.addPlayer(ai);
    circle.addPlayer(opponent);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).getId());
        }
    };

    await ai.takeTurn(room);
    assert.deepEqual(discardedCardIds, ["5-clubs"]);

    ai.hand.clear();
    ai.hand.draw(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(room);

    assert.deepEqual(discardedCardIds, ["5-clubs", "a-hearts"]);
});

test("AI uses its ace of spades against draw two without inspecting the next player's card", async (t) => {
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
    nextPlayer.hand.cards = new Proxy(nextPlayer.hand.cards, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {
            isCardDrawn = true;
        },
        discardCard: async () => {
            isCardDiscarded = true;
        }
    };

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, false);
    assert.equal(isCardDiscarded, true);
});

test("AI treats a visible one-card count as a threat without reading the hidden card", async (t) => {
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
    nextPlayer.hand.cards = new Proxy(nextPlayer.hand.cards, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    Object.defineProperty(nextPlayer.hand, "score", {
        configurable: true,
        get() {
            throw new Error("AI inspected a hidden opponent score.");
        }
    });
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "5-clubs");
});

test("AI uses discard-pile card counting to reduce a one-card opponent's response chance", async (t) => {
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
    nextPlayer.hand.draw(new Card(
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.SUIT.DIAMONDS
    ));
    nextPlayer.hand.cards = new Proxy(nextPlayer.hand.cards, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setTurnOwner(ai.name);

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
    ].map(value => new Card(value, Constants.CARD.SUIT.HEARTS));
    const room = {
        circle,
        declaredSuit: null,
        discardPile: [
            ...discardedHearts,
            new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS),
            new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
            new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.SPADES),
            new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)
        ],
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "3-hearts");
});

test("room remembers which player made the latest gameplay discard", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const alice = room.circle.getPlayer("Alice");

    room.discardPile = [new Card(
        Constants.CARD.VALUE.FIVE.id,
        Constants.CARD.SUIT.DIAMONDS
    )];
    alice.hand.drawMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);

    assert.equal(room.getLastDiscardPlayer(), null);

    await room.discardCard(
        alice.name,
        Constants.CARD.VALUE.THREE.id,
        Constants.CARD.SUIT.DIAMONDS
    );

    assert.equal(room.getLastDiscardPlayer(), alice);
});

test("AI presses the suit after an opponent discards its lowest ordinary card", async (t) => {
    const ai = new AIPlayer("Bot");
    const previousPlayer = new Player("Alice");
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
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    previousPlayer.hand.drawMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    circle.addPlayer(ai);
    circle.addPlayer(previousPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getLastDiscardPlayer: () => previousPlayer,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.THREE.id,
            Constants.CARD.SUIT.DIAMONDS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "2-diamonds");
});

test("AI ignores a low-discard suit inference when that opponent will not act next", async (t) => {
    const ai = new AIPlayer("Bot");
    const projectedPlayer = new Player("Alice");
    const previousPlayer = new Player("Casey");
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
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    projectedPlayer.hand.drawMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES),
        new Card(Constants.CARD.VALUE.NINE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
    circle.addPlayer(ai);
    circle.addPlayer(projectedPlayer);
    circle.addPlayer(previousPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getLastDiscardPlayer: () => previousPlayer,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.THREE.id,
            Constants.CARD.SUIT.DIAMONDS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "3-hearts");
});

test("AI uses a skip to bypass an immediate one-card opponent", async (t) => {
    const ai = new AIPlayer("Bot");
    const nextPlayer = new Player("Alice");
    const followingPlayer = new Player("Casey");
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
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.hand.draw(new Card(
        Constants.CARD.VALUE.FIVE.id,
        Constants.CARD.SUIT.DIAMONDS
    ));
    followingPlayer.hand.drawMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.addPlayer(followingPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "8-hearts");
});

test("AI uses a two-player skip to prepare an immediate final discard", async (t) => {
    const ai = new AIPlayer("Bot");
    const opponent = new Player("Alice");
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
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)
    ]);
    opponent.hand.drawMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.SPADES),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.HEARTS)
    ]);
    circle.addPlayer(ai);
    circle.addPlayer(opponent);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.CLUBS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "8-clubs");
});

test("AI uses the visible card count of the player reached by a skip", async (t) => {
    const ai = new AIPlayer("Bot");
    const skippedPlayer = new Player("Alice");
    const projectedPlayer = new Player("Casey");
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
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.HEARTS)
    ]);
    skippedPlayer.hand.drawMany([
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    projectedPlayer.hand.draw(new Card(
        Constants.CARD.VALUE.EIGHT.id,
        Constants.CARD.SUIT.DIAMONDS
    ));
    circle.addPlayer(ai);
    circle.addPlayer(skippedPlayer);
    circle.addPlayer(projectedPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "5-clubs");
});

test("AI uses the visible card count of the player reached by a reverse", async (t) => {
    const ai = new AIPlayer("Bot");
    const nextPlayer = new Player("Alice");
    const reversedNextPlayer = new Player("Casey");
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
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.JACK.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.hand.drawMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.CLUBS)
    ]);
    reversedNextPlayer.hand.draw(new Card(
        Constants.CARD.VALUE.JACK.id,
        Constants.CARD.SUIT.CLUBS
    ));
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.addPlayer(reversedNextPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "3-hearts");
});

test("AI uses a suit-changing ace to take control against a visible one-card threat", async (t) => {
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
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS)
    ]);
    nextPlayer.hand.draw(new Card(
        Constants.CARD.VALUE.FIVE.id,
        Constants.CARD.SUIT.DIAMONDS
    ));
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "a-hearts");
});

test("AI breaks equal suit strength toward the scarcest publicly unseen suit", async (t) => {
    const ai = new AIPlayer("Bot");
    const opponent = new Player("Alice");
    const circle = new PlayerCircle();
    const originalSetTimeout = globalThis.setTimeout;
    let declaredSuit = null;

    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    t.after(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    ai.hand.drawMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);
    opponent.hand.drawMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.SPADES)
    ]);
    circle.addPlayer(ai);
    circle.addPlayer(opponent);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        discardPile: [
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
        ].map(value => new Card(value, Constants.CARD.SUIT.CLUBS)),
        declareSuit: async (suit) => {
            declaredSuit = suit;
        }
    };

    await ai.chooseSuit(room);

    assert.equal(declaredSuit, Constants.CARD.SUIT.CLUBS);
});

test("AI forces a visible one-card opponent to draw when legally possible", async (t) => {
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
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.hand.draw(new Card(
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.SUIT.DIAMONDS
    ));
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "2-hearts");
});

test("AI starts pressuring an opponent before they reach one card", async (t) => {
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
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.hand.drawMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
    nextPlayer.hand.cards = new Proxy(nextPlayer.hand.cards, {
        get(target, property, receiver) {
            if (property !== "length") {
                throw new Error("AI inspected a hidden opponent card.");
            }

            return Reflect.get(target, property, receiver);
        }
    });
    circle.addPlayer(ai);
    circle.addPlayer(nextPlayer);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        discardPile: [
            new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.CLUBS),
            new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
            new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.SPADES),
            new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.BLACK),
            new Card(Constants.CARD.VALUE.JOKER.id, Constants.CARD.SUIT.RED),
            new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES),
            new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)
        ],
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(room);

    assert.equal(discardedCard.getId(), "2-hearts");
});

test("AI releases seven of hearts only when its public score estimate is favorable", async (t) => {
    const ai = new AIPlayer("Bot");
    const opponent = new Player("Alice");
    const otherOpponent = new Player("Casey");
    const circle = new PlayerCircle();
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

    ai.hand.drawMany([
        new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);
    opponent.hand.drawMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.SPADES)
    ]);
    otherOpponent.hand.drawMany([
        new Card(Constants.CARD.VALUE.SIX.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.EIGHT.id, Constants.CARD.SUIT.SPADES)
    ]);

    for (const hiddenOpponent of [opponent, otherOpponent]) {
        hiddenOpponent.hand.cards = new Proxy(hiddenOpponent.hand.cards, {
            get(target, property, receiver) {
                if (property !== "length") {
                    throw new Error("AI inspected a hidden opponent card.");
                }

                return Reflect.get(target, property, receiver);
            }
        });
        Object.defineProperty(hiddenOpponent.hand, "score", {
            configurable: true,
            get() {
                throw new Error("AI inspected a hidden opponent score.");
            }
        });
    }

    circle.addPlayer(ai);
    circle.addPlayer(opponent);
    circle.addPlayer(otherOpponent);
    circle.setTurnOwner(ai.name);

    const room = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(
            Constants.CARD.VALUE.FIVE.id,
            Constants.CARD.SUIT.HEARTS
        ),
        drawCards: async () => {
            drawCount += 1;
        },
        discardCard: async (playerName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).getId());
        }
    };

    await ai.takeTurn(room);

    assert.equal(drawCount, 0);
    assert.deepEqual(discardedCardIds, ["7-hearts"]);

    ai.hand.clear();
    ai.hand.drawMany([
        new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES)
    ]);
    await ai.takeTurn(room);

    assert.equal(drawCount, 1);
    assert.deepEqual(discardedCardIds, ["7-hearts"]);

    ai.hand.clear();
    ai.hand.draw(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(room);

    assert.equal(drawCount, 1);
    assert.deepEqual(discardedCardIds, ["7-hearts", "7-hearts"]);
});
