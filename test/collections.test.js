"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../public/scripts/Constants.js";
import { Card } from "../server/Card.js";
import { Deck } from "../server/Deck.js";
import { Hand } from "../server/Hand.js";
import { Player } from "../server/Player.js";
import { PlayerCircle } from "../server/PlayerCircle.js";
import { CardSortUtils } from "../public/scripts/utils/CardSortUtils.js";
import { TurnUtils } from "../public/scripts/utils/TurnUtils.js";

const { VALUE, SUIT } = Constants.CARD;

test("an unshuffled deck contains 54 unique cards", () => {
    const deck = new Deck(false);
    const ids = deck.toArray().map((card) => card.getId());

    assert.equal(deck.cards.length, 54);
    assert.equal(new Set(ids).size, 54);
    assert.equal(ids.filter((id) => id.startsWith("joker-")).length, 2);
});

test("deck drawing and insertion preserve top and bottom order", () => {
    const deck = new Deck(false);
    deck.clear();

    const two = new Card(VALUE.TWO.id, SUIT.CLUBS);
    const three = new Card(VALUE.THREE.id, SUIT.CLUBS);
    const four = new Card(VALUE.FOUR.id, SUIT.CLUBS);

    deck.putManyBottom([two, three]);
    deck.putTop(four);

    assert.deepEqual(deck.drawMany(3).map(String), ["4-clubs", "3-clubs", "2-clubs"]);
    assert.equal(deck.draw(), null);
    assert.throws(() => deck.drawMany(-1), /non-negative integer/);
});

test("hands draw, discard, and total card scores", () => {
    const hand = new Hand([
        new Card(VALUE.TWO.id, SUIT.CLUBS),
        new Card(VALUE.ACE.id, SUIT.SPADES)
    ]);

    assert.equal(hand.cards.length, 2);
    assert.equal(hand.score, 60);
    assert.equal(hand.isCardPresent(new Card(VALUE.TWO.id, SUIT.CLUBS)), true);

    const discarded = hand.discard(new Card(VALUE.TWO.id, SUIT.CLUBS));
    assert.equal(discarded.getId(), "2-clubs");
    assert.equal(hand.score, 40);
    assert.throws(() => hand.discard(discarded), /Card not found/);
});

test("hands serialize through Serializable with plain card snapshots", () => {
    const hand = new Hand([
        new Card(VALUE.TWO.id, SUIT.CLUBS, 0),
        new Card(VALUE.ACE.id, SUIT.SPADES, 0)
    ]);
    const snapshot = hand.toJSON();

    assert.equal(snapshot.score, 60);
    assert.equal(snapshot.cards.length, 2);
    assert.equal(snapshot.cards[0].value, VALUE.TWO.id);
    assert.equal(snapshot.cards[0] instanceof Card, false);
});

test("hand sorting is permanent for existing cards but does not auto-sort new draws", () => {
    const hand = new Hand([
        new Card(VALUE.KING.id, SUIT.CLUBS),
        new Card(VALUE.THREE.id, SUIT.HEARTS),
        new Card(VALUE.EIGHT.id, SUIT.SPADES)
    ]);

    hand.sortBy("value");
    assert.deepEqual(hand.toArray().map(String), ["3-hearts", "8-spades", "k-clubs"]);

    hand.draw(new Card(VALUE.TWO.id, SUIT.DIAMONDS));
    assert.deepEqual(hand.toArray().map(String), ["3-hearts", "8-spades", "k-clubs", "2-diamonds"]);
    hand.sortBy("none");
    assert.throws(() => hand.sortBy("invalid"), /Invalid card sort key/);
});

test("shared sorting returns an ordered copy for browser rendering", () => {
    const cards = [
        { value: "k", suit: "clubs", score: 13 },
        { value: "3", suit: "hearts", score: 3 },
        { value: "8", suit: "spades", score: 8 }
    ];

    assert.deepEqual(CardSortUtils.sorted(cards, "value").map((card) => card.value), ["3", "8", "k"]);
    assert.deepEqual(cards.map((card) => card.value), ["k", "3", "8"]);
});

test("player circle moves, reverses, and remains linked after removal", () => {
    const circle = new PlayerCircle();
    const alice = circle.addPlayer(new Player("Alice"));
    const bob = circle.addPlayer(new Player("Bob"));
    circle.addPlayer(new Player("Casey"));

    assert.equal(circle.turnOwnerKey, null);
    assert.equal(TurnUtils.hasTurnOwner(circle.turnOwnerKey), false);
    assert.equal(TurnUtils.isTurnOwner(circle.turnOwnerKey, alice.key), false);
    assert.throws(() => circle.requireTurnOwner(), /Turn owner is not assigned/);

    circle.setTurnOwner("Alice");
    assert.equal(circle.turnOwnerKey, alice.key);
    assert.equal(TurnUtils.hasTurnOwner(circle.turnOwnerKey), true);
    assert.equal(TurnUtils.isTurnOwner(circle.turnOwnerKey, alice.key), true);
    assert.equal(TurnUtils.isTurnOwner(circle.turnOwnerKey, bob.key), false);
    assert.equal(circle.requireTurnOwner(), alice);
    assert.equal(circle.getRelativePlayer(1).name, "Bob");

    circle.moveTurnOwner();
    assert.equal(circle.getTurnOwner().name, "Bob");

    circle.reverseTurnDirection();
    circle.moveTurnOwner();
    assert.equal(circle.getTurnOwner().name, "Alice");

    circle.removePlayer("Alice");
    assert.equal(circle.getTurnOwner().name, "Casey");
    assert.equal(circle.getRelativePlayer(1).name, "Bob");
    assert.equal(circle.getRelativePlayer(2).name, "Casey");
});

test("player names produce stable keys", () => {
    assert.equal(Player.normalizeKey("  Ada Lovelace!  "), "ada-lovelace");
    assert.throws(() => new Player("   "), /cannot be empty/);
});
