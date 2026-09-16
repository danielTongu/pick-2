"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../core/Card.js";
import { CardSortUtils } from "../core/CardSortUtils.js";
import { Constants } from "../core/Constants.js";
import { CardCollection } from "../core/CardCollection.js";
import { Actor as Player } from "../core/Actor.js";
import { TurnOrder } from "../core/TurnOrder.js";
import { TurnUtils } from "../core/TurnUtils.js";

const { VALUE, SUIT } = Constants.CARD;

test("an unshuffled deck contains 54 unique cards", () => {
    const deck = CardCollection.createDeck(false);
    const ids = deck.toArray().map((card) => card.id);

    assert.equal(deck.items.length, 54);
    assert.equal(new Set(ids).size, 54);
    assert.equal(ids.filter((id) => id.startsWith("joker-")).length, 2);
});

test("deck drawing and insertion preserve top and bottom order", () => {
    const deck = CardCollection.createDeck(false);
    deck.clear();

    const two = new Card(VALUE.TWO.id, SUIT.CLUBS);
    const three = new Card(VALUE.THREE.id, SUIT.CLUBS);
    const four = new Card(VALUE.FOUR.id, SUIT.CLUBS);

    deck.addManyFirst([two, three]);
    deck.add(four);

    assert.deepEqual(deck.takeMany(3).map(String), ["4-clubs", "3-clubs", "2-clubs"]);
    assert.equal(deck.take(), null);
    assert.throws(() => deck.takeMany(-1), /non-negative integer/);
});

test("hands draw, discard, and total card scores", () => {
    const hand = new CardCollection([new Card(VALUE.TWO.id, SUIT.CLUBS), new Card(VALUE.ACE.id, SUIT.SPADES)]);

    assert.equal(hand.items.length, 2);
    assert.equal(hand.score, 70);
    assert.equal(hand.has(new Card(VALUE.TWO.id, SUIT.CLUBS)), true);

    const discarded = hand.remove(new Card(VALUE.TWO.id, SUIT.CLUBS));
    assert.equal(discarded.id, "2-clubs");
    assert.equal(hand.score, 50);
    assert.equal(hand.remove(discarded), null);
});

test("hands serialize through Serializable with plain card snapshots", () => {
    const hand = new CardCollection([new Card(VALUE.TWO.id, SUIT.CLUBS, 0), new Card(VALUE.ACE.id, SUIT.SPADES, 0)]);
    const snapshot = hand.toJSON();

    assert.equal(snapshot.score, 70);
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.items[0].value, VALUE.TWO.id);
    assert.equal(snapshot.items[0] instanceof Card, false);
});

test("hand sorting is permanent for existing cards but does not auto-sort new draws", () => {
    const hand = new CardCollection([
        new Card(VALUE.KING.id, SUIT.CLUBS),
        new Card(VALUE.THREE.id, SUIT.HEARTS),
        new Card(VALUE.EIGHT.id, SUIT.SPADES)
    ]);

    hand.sort(CardSortUtils.comparator("value"));
    assert.deepEqual(hand.toArray().map(String), ["3-hearts", "8-spades", "k-clubs"]);

    hand.add(new Card(VALUE.TWO.id, SUIT.DIAMONDS));
    assert.deepEqual(hand.toArray().map(String), ["3-hearts", "8-spades", "k-clubs", "2-diamonds"]);
    assert.throws(() => hand.sort(null), /must be a function/);
});

test("shared sorting returns an ordered copy for browser rendering", () => {
    const cards = [
        { value: "k", suit: "clubs", score: 13 },
        { value: "3", suit: "hearts", score: 3 },
        { value: "8", suit: "spades", score: 8 }
    ];

    assert.deepEqual(
        CardSortUtils.sorted(cards, "value").map((card) => card.value),
        ["3", "8", "k"]
    );
    assert.deepEqual(
        cards.map((card) => card.value),
        ["k", "3", "8"]
    );
});

test("turn order moves, reverses, and preserves order after removal", () => {
    const turnOrder = new TurnOrder();
    const alice = turnOrder.add(new Player("Alice", { drawAllowance: 1 }));
    const bob = turnOrder.add(new Player("Bob", { drawAllowance: 1 }));
    turnOrder.add(new Player("Casey", { drawAllowance: 1 }));

    assert.equal(turnOrder.ownerKey, null);
    assert.equal(TurnUtils.hasTurnOwner(turnOrder.ownerKey), false);
    assert.equal(TurnUtils.isTurnOwner(turnOrder.ownerKey, alice.key), false);
    assert.throws(() => turnOrder.requireOwner(), /Turn owner is not assigned/);

    turnOrder.setOwner("Alice");
    assert.equal(turnOrder.ownerKey, alice.key);
    assert.equal(TurnUtils.hasTurnOwner(turnOrder.ownerKey), true);
    assert.equal(TurnUtils.isTurnOwner(turnOrder.ownerKey, alice.key), true);
    assert.equal(TurnUtils.isTurnOwner(turnOrder.ownerKey, bob.key), false);
    assert.equal(turnOrder.requireOwner(), alice);
    assert.equal(turnOrder.relative(1).name, "Bob");

    turnOrder.move();
    assert.equal(turnOrder.owner.name, "Bob");

    turnOrder.reverse();
    turnOrder.move();
    assert.equal(turnOrder.owner.name, "Alice");

    turnOrder.remove("Alice");
    assert.equal(turnOrder.owner.name, "Casey");
    assert.equal(turnOrder.relative(1).name, "Bob");
    assert.equal(turnOrder.relative(2).name, "Casey");
});

test("player names produce stable keys", () => {
    assert.equal(Player.normalizeKey("  Ada Lovelace!  "), "ada-lovelace");
    assert.throws(() => new Player("   ", { drawAllowance: 1 }), /cannot be empty/);
});
