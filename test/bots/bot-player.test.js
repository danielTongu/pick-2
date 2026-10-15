"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../../core/Card.js";
import { Constants } from "../../core/Constants.js";
import { Player } from "../../core/Player.js";
import { ImmediateBot } from "../helpers/bot.js";
import { TurnOrder } from "../../core/TurnOrder.js";

test("AI preserves the ace of spades when no draw attack is active", async (t) => {
    const ai = new ImmediateBot("Bot");
    let isCardDrawn = false;
    let isCardDiscarded = false;

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
    const ai = new ImmediateBot("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const discardedCardIds = [];

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
    room.match = room;

    await ai.takeTurn(room);
    assert.deepEqual(discardedCardIds, ["5-clubs"]);

    ai.collection.clear();
    ai.collection.add(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.HEARTS));
    await ai.takeTurn(room);

    assert.deepEqual(discardedCardIds, ["5-clubs", "a-hearts"]);
});

test("hard-mode AI uses its ace of spades against draw two", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let isCardDrawn = false;
    let isCardDiscarded = false;

    ai.collection.add(new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES));
    ai.drawAllowance = 2;
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS));
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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(isCardDrawn, false);
    assert.equal(isCardDiscarded, true);
});

test("hard-mode AI avoids matching the next player's final card", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.DIAMONDS));
    Object.defineProperty(nextPlayer.collection, "penalty", {
        configurable: true,
        get() {
            throw new Error("AI inspected a hidden opponent penalty.");
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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("hard-mode AI sheds more penalty when neither choice matches the final opponent card", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.add(new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS));
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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "5-clubs");
});

test("AI presses the suit after an opponent discards its lowest ordinary card", async (t) => {
    const ai = new ImmediateBot("Bot");
    const previousPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
        getLastDiscardPlayer: () => previousPlayer,
        getTopItem: () => new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-diamonds");
});

test("AI ignores a low-discard suit inference when that opponent will not act next", async (t) => {
    const ai = new ImmediateBot("Bot");
    const projectedPlayer = new Player("Alice", { drawAllowance: 1 });
    const previousPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.HEARTS)
    ]);
    projectedPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.CLUBS),
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
        getLastDiscardPlayer: () => previousPlayer,
        getTopItem: () => new Card(Constants.CARD.VALUE.THREE.id, Constants.CARD.SUIT.DIAMONDS),
        drawItems: async () => {},
        playItem: async (playerName, value, suit) => {
            discardedCard = new Card(value, suit);
        }
    };
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("AI uses a skip to bypass an immediate one-card opponent", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const followingPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "8-hearts");
});

test("AI uses a two-player skip to prepare an immediate final discard", async (t) => {
    const ai = new ImmediateBot("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "8-clubs");
});

test("AI uses the visible card count of the player reached by a skip", async (t) => {
    const ai = new ImmediateBot("Bot");
    const skippedPlayer = new Player("Alice", { drawAllowance: 1 });
    const projectedPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "5-clubs");
});

test("AI uses the visible card count of the player reached by a reverse", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const reversedNextPlayer = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "3-hearts");
});

test("AI uses a suit-changing ace to take control against a visible one-card threat", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "a-hearts");
});

test("AI breaks equal suit strength toward the scarcest publicly unseen suit", async (t) => {
    const ai = new ImmediateBot("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let declaredSuit = null;

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
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-hearts");
});

test("AI starts pressuring an opponent before they reach one card", async (t) => {
    const ai = new ImmediateBot("Bot");
    const nextPlayer = new Player("Alice", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    let discardedCard = null;

    ai.collection.addMany([
        new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.CLUBS),
        new Card(Constants.CARD.VALUE.TWO.id, Constants.CARD.SUIT.HEARTS)
    ]);
    nextPlayer.collection.addMany([
        new Card(Constants.CARD.VALUE.KING.id, Constants.CARD.SUIT.DIAMONDS),
        new Card(Constants.CARD.VALUE.QUEEN.id, Constants.CARD.SUIT.SPADES)
    ]);
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
    room.match = room;

    await ai.takeTurn(room);

    assert.equal(discardedCard.id, "2-hearts");
});

test("hard-mode AI releases seven of hearts only when remaining penalties are favorable", async (t) => {
    const ai = new ImmediateBot("Bot");
    const opponent = new Player("Alice", { drawAllowance: 1 });
    const otherOpponent = new Player("Casey", { drawAllowance: 1 });
    const turnOrder = new TurnOrder();
    const discardedCardIds = [];
    let drawCount = 0;

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
        playItem: async (playerName, value, suit) => {
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
