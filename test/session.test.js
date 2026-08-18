"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../src/core/Card.js";
import { Constants } from "../src/core/Constants.js";
import { AIPlayer, Player } from "../src/core/Player.js";
import { PlayerCircle } from "../src/core/PlayerCircle.js";
import { Session } from "../src/core/Session.js";
import { StateMapper } from "../src/core/StateMapper.js";
import { TurnUtils } from "../src/core/TurnUtils.js";

function stopIdleMonitoring(session) {
    for (const player of session.circle.players.values()) {
        player.stopIdleMonitoring();
    }
}

async function createPlayingSession(t, playerNames = ["Alice", "Bob", "Casey"]) {
    const session = new Session(`Rules ${Math.random()}`, playerNames.length);
    t.after(() => stopIdleMonitoring(session));

    for (const name of playerNames) {
        await session.join(name);
    }

    session.status = Constants.STATUS.PLAYING;
    session.circle.setTurnOwner(playerNames[0]);
    session.discardPile = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)];

    for (const player of session.circle.players.values()) {
        player.hand.clear();
        player.drawAllowance = 1;
    }

    return session;
}

test("session lifecycle predicates describe active and membership-locked states", () => {
    const session = new Session("Lifecycle Session", 2);

    assert.equal(session.isActive(), false);
    assert.equal(session.isMembershipLocked(), false);

    for (const status of [Constants.STATUS.PLAYING, Constants.STATUS.PENDING]) {
        session.status = status;
        assert.equal(session.isActive(), true);
        assert.equal(session.isMembershipLocked(), true);
    }

    session.status = Constants.STATUS.FINISHED;
    assert.equal(session.isActive(), false);
    assert.equal(session.isMembershipLocked(), false);
});

test("stopping a completed round returns the same session to waiting", async (t) => {
    const session = new Session("Completed Session", 2);

    t.after(() => stopIdleMonitoring(session));
    await session.join("Alice");
    await session.join("Bob");
    await session.start();
    session.status = Constants.STATUS.FINISHED;

    assert.equal(await session.stop(), true);
    assert.equal(session.status, Constants.STATUS.WAITING);
    assert.equal(session.circle.turnOwnerKey, null);
    assert.equal(session.circle.players.size, 2);
});

test("session membership enforces uniqueness and capacity", async (t) => {
    const session = new Session("Test Session", 2);
    t.after(() => stopIdleMonitoring(session));

    await session.join("Alice");
    await session.join("Bob");

    assert.equal(session.isFull(), true);
    assert.equal(session.isPlayerPresent("alice"), true);
    await assert.rejects(session.join("Casey"), /Session is full/);
});

test("a viewer can join the session as a player", async (t) => {
    const session = new Session("Viewed Session", 2);
    t.after(() => stopIdleMonitoring(session));

    assert.equal(session.view("tab-1"), true);
    const player = await session.join("Alice", false, "tab-1");

    assert.equal(player.name, "Alice");
    assert.equal(session.viewers.has("tab-1"), false);
    assert.equal(session.isPlayerPresent("Alice"), true);
    await assert.rejects(session.join("Bob", false, "missing"), /Viewer not found/);
});

test("sessions support viewing, idle-player removal, and leaving", async (t) => {
    const session = new Session("Transitions", 3);
    t.after(() => stopIdleMonitoring(session));

    assert.equal(session.view("viewer-1"), true);
    assert.equal(session.view("viewer-1"), false);
    assert.equal(session.leaveViewer("viewer-1"), true);
    assert.equal(session.leaveViewer("viewer-1"), false);

    const alice = await session.join("Alice");
    alice.hand.draw(new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.CLUBS));
    assert.equal((await session.movePlayerToView("Alice", "alice-tab")).name, "Alice");
    assert.equal(session.viewers.has("alice-tab"), true);
    assert.equal(session.isPlayerPresent("Alice"), false);
    await assert.rejects(session.movePlayerToView("missing", "tab"), /Player does not exist/);

    await session.join("Bob");
    assert.equal((await session.leavePlayer("Bob")).name, "Bob");
    await assert.rejects(session.leavePlayer("Bob"), /Player does not exist/);
    assert.equal(session.isEmpty(), true);
});

test("players and viewers can leave while a session is active", async (t) => {
    const session = await createPlayingSession(t);

    assert.equal(session.view("active-viewer"), true);
    assert.equal((await session.leavePlayer("Alice")).name, "Alice");
    assert.equal(session.leaveViewer("active-viewer"), true);
    assert.equal(session.status, Constants.STATUS.PLAYING);
    assert.equal(session.isPlayerPresent("Alice"), false);
    assert.equal(session.viewers.has("active-viewer"), false);
});

test("session payload uses one player shape and localPlayerName identifies the local player", async (t) => {
    const session = new Session("Payload Session", 2);
    t.after(() => stopIdleMonitoring(session));

    await session.join("Alice");
    await session.join("Bob");

    const localPayload = StateMapper.toSessionPayload(session, "Alice");
    const viewerPayload = StateMapper.toSessionPayload(session, null);
    const expectedKeys = [
        "drawAllowance",
        "hand",
        "isWinner",
        "key",
        "name"
    ];

    assert.equal(localPayload.localPlayerName, "Alice");
    assert.equal(viewerPayload.localPlayerName, null);
    assert.equal(localPayload.circle.turnOwnerKey, null);
    assert.deepEqual(Object.keys(localPayload.circle.players[0]).sort(), expectedKeys);
    assert.deepEqual(Object.keys(localPayload.circle.players[1]).sort(), expectedKeys);
});

test("a game requires two players", async (t) => {
    const session = new Session("Small Session", 2);
    t.after(() => stopIdleMonitoring(session));

    await session.join("Alice");
    await assert.rejects(session.start(), /Need at least two players/);
});

test("waiting sessions have no turn owner and allow every player to draw or discard", async (t) => {
    const session = new Session("Waiting Session", 2);
    t.after(() => stopIdleMonitoring(session));

    const alice = await session.join("Alice");
    const bob = await session.join("Bob");
    alice.hand.draw({ value: "5", suit: "clubs" });
    bob.hand.draw({ value: "k", suit: "hearts" });

    await session.discardCard("Alice", "5", "clubs");
    await session.discardCard("Bob", "k", "hearts");

    assert.equal(session.status, Constants.STATUS.WAITING);
    assert.equal(session.circle.getTurnOwner(), null);
    assert.equal(session.circle.turnOwnerKey, null);
    assert.equal(TurnUtils.hasTurnOwner(session.circle.turnOwnerKey), false);
    assert.equal(TurnUtils.isTurnOwner(session.circle.turnOwnerKey, alice.key), false);
    assert.throws(() => session.circle.requireTurnOwner(), /Turn owner is not assigned/);
    assert.equal(alice.hand.cards.length, 0);
    assert.equal(bob.hand.cards.length, 0);
    assert.equal(alice.drawAllowance, 1);
    assert.equal(bob.drawAllowance, 1);
    assert.equal(session.declaredSuit, null);
    assert.deepEqual(session.winners, []);
    assert.equal(session.getTopDiscard().getId(), "k-hearts");

    assert.equal((await session.drawCards("Alice")).length, 1);
    assert.equal((await session.drawCards("Bob")).length, 1);
    assert.equal(session.circle.getTurnOwner(), null);
});

test("a null turn owner bypasses playing turn and card-legality checks", async (t) => {
    const session = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = session.circle.getPlayer("Alice");
    const bob = session.circle.getPlayer("Bob");

    session.circle.setTurnOwner(null);
    bob.hand.drawMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.FOUR.id, Constants.CARD.SUIT.CLUBS)
    ]);

    await session.discardCard(
        bob.name,
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.SUIT.CLUBS
    );

    alice.drawAllowance = 0;
    const drawn = await session.drawCards(alice.name);

    assert.equal(session.status, Constants.STATUS.PLAYING);
    assert.equal(session.circle.getTurnOwner(), null);
    assert.equal(session.getTopDiscard().getId(), "k-clubs");
    assert.equal(drawn.length, 1);
});

test("starting a session deals seven cards and selects an ordinary discard", async (t) => {
    const session = new Session("Started Session", 2);
    t.after(() => stopIdleMonitoring(session));

    await session.join("Alice");
    await session.join("Bob");
    await session.start();

    assert.equal(session.status, Constants.STATUS.PLAYING);
    assert.equal(session.discardPile.length, 1);
    assert.equal(session.getTopDiscard().isSpecial(), false);
    assert.equal(session.circle.getTurnOwner() === null, false);
    assert.equal(TurnUtils.hasTurnOwner(session.circle.turnOwnerKey), true);
    assert.equal(
        TurnUtils.isTurnOwner(session.circle.turnOwnerKey, session.circle.requireTurnOwner().key),
        true
    );

    for (const player of session.circle.players.values()) {
        assert.equal(player.hand.cards.length, Constants.PLAYER_INITIAL_CARD_COUNT);
    }

    assert.equal(session.deck.cards.length, 39);
});

test("only the turn owner can act and passing advances the turn", async (t) => {
    const session = new Session("Turn Session", 2);
    t.after(() => stopIdleMonitoring(session));

    await session.join("Alice");
    await session.join("Bob");
    await session.start();

    const current = session.circle.getTurnOwner();
    const other = [...session.circle.players.values()].find((player) => player.key !== current.key);
    const initialCount = current.hand.cards.length;

    await assert.rejects(session.passTurn(other.name), /Not your turn/);
    const drawn = await session.passTurn(current.name);

    assert.equal(drawn.length, 1);
    assert.equal(current.hand.cards.length, initialCount + 1);
    assert.equal(session.circle.getTurnOwner().key, other.key);
});

test("drawing consumes allowances and rejects additional draws", async (t) => {
    const session = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = session.circle.getPlayer("Alice");
    alice.drawAllowance = 2;

    const cards = await session.drawCards("Alice");

    assert.equal(cards.length, 2);
    assert.equal(alice.drawAllowance, 0);
    assert.equal(session.circle.getTurnOwner().name, "Bob");

    session.circle.setTurnOwner("Alice");
    await assert.rejects(session.drawCards("Alice"), /No draw allowance remaining/);
    await assert.rejects(session.drawCards("Missing"), /Player does not exist/);
});

test("special discards apply skip, reverse, draw, suit, and session-ending effects", async (t) => {
    const scenarios = [
        {value: Constants.CARD.VALUE.EIGHT.id, expectedPlayer: "Casey", expectedAllowance: 1},
        {value: Constants.CARD.VALUE.JACK.id, expectedPlayer: "Casey", expectedAllowance: 1},
        {value: Constants.CARD.VALUE.TWO.id, expectedPlayer: "Bob", expectedAllowance: 2}
    ];

    for (const scenario of scenarios) {
        const session = await createPlayingSession(t);
        const alice = session.circle.getPlayer("Alice");
        alice.hand.drawMany([
            new Card(scenario.value, Constants.CARD.SUIT.HEARTS),
            new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
        ]);

        await session.discardCard("Alice", scenario.value, Constants.CARD.SUIT.HEARTS);

        assert.equal(session.circle.getTurnOwner().name, scenario.expectedPlayer);
        assert.equal(session.circle.getTurnOwner().drawAllowance, scenario.expectedAllowance);
    }

    const suitSession = await createPlayingSession(t, ["Alice", "Bob"]);
    suitSession.circle.getPlayer("Alice").hand.drawMany([
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);
    await suitSession.discardCard("Alice", Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(suitSession.status, Constants.STATUS.PENDING);
    assert.equal(await suitSession.declareSuit(Constants.CARD.SUIT.CLUBS), true);
    assert.equal(suitSession.declaredSuit, Constants.CARD.SUIT.CLUBS);
    assert.equal(suitSession.circle.getTurnOwner().name, "Bob");

    const finishSession = await createPlayingSession(t, ["Alice", "Bob"]);
    finishSession.circle.getPlayer("Alice").hand.draw(new Card(
        Constants.CARD.VALUE.SEVEN.id,
        Constants.CARD.SUIT.HEARTS
    ));
    finishSession.circle.getPlayer("Bob").hand.draw(new Card(
        Constants.CARD.VALUE.KING.id,
        Constants.CARD.SUIT.CLUBS
    ));
    await finishSession.discardCard("Alice", Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS);
    assert.equal(finishSession.status, Constants.STATUS.FINISHED);
    assert.equal(finishSession.winners.includes("Alice"), true);
    assert.equal(finishSession.scores.Bob, 13);
});

test("session input validation rejects invalid capacity and suit", async (t) => {
    assert.throws(() => new Session("Invalid", 1), /Capacity must be between/);
    assert.throws(() => Session.normalizeSuit("purple"), /Invalid suit/);

    const session = new Session("Suit Session", 2);
    t.after(() => stopIdleMonitoring(session));
    await assert.rejects(session.declareSuit("hearts"), /No suit pending declaration/);
});

test("a session commits the selected card order when the player moves", async (t) => {
    const session = new Session("Sort Session", 2);
    t.after(() => stopIdleMonitoring(session));

    const player = await session.join("Alice");
    player.hand.drawMany([
        { value: "k", suit: "clubs" },
        { value: "3", suit: "hearts" },
        { value: "8", suit: "spades" }
    ]);

    await session.passTurn("Alice", "value");

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCardIds.push(new Card(value, suit).getId());
        }
    };

    await ai.takeTurn(session);
    assert.deepEqual(discardedCardIds, ["5-clubs"]);

    ai.hand.clear();
    ai.hand.draw(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
        circle,
        declaredSuit: null,
        getTopDiscard: () => new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS),
        drawCards: async () => {},
        discardCard: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };

    await ai.takeTurn(session);

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
    const session = {
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

    await ai.takeTurn(session);

    assert.equal(discardedCard.getId(), "3-hearts");
});

test("session remembers which player made the latest gameplay discard", async (t) => {
    const session = await createPlayingSession(t, ["Alice", "Bob"]);
    const alice = session.circle.getPlayer("Alice");

    session.discardPile = [new Card(
        Constants.CARD.VALUE.FIVE.id,
        Constants.CARD.SUIT.DIAMONDS
    )];
    alice.hand.drawMany([
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.CLUBS)
    ]);

    assert.equal(session.getLastDiscardPlayer(), null);

    await session.discardCard(
        alice.name,
        Constants.CARD.VALUE.THREE.id,
        Constants.CARD.SUIT.DIAMONDS
    );

    assert.equal(session.getLastDiscardPlayer(), alice);
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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.chooseSuit(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

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

    const session = {
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

    await ai.takeTurn(session);

    assert.equal(drawCount, 0);
    assert.deepEqual(discardedCardIds, ["7-hearts"]);

    ai.hand.clear();
    ai.hand.drawMany([
        new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS),
        new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES)
    ]);
    await ai.takeTurn(session);

    assert.equal(drawCount, 1);
    assert.deepEqual(discardedCardIds, ["7-hearts"]);

    ai.hand.clear();
    ai.hand.draw(new Card(Constants.CARD.VALUE.SEVEN.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(session);

    assert.equal(drawCount, 1);
    assert.deepEqual(discardedCardIds, ["7-hearts", "7-hearts"]);
});
