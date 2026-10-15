import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../../core/Card.js";
import { CardCollection } from "../../core/CardCollection.js";
import { Constants } from "../../core/Constants.js";
const { VALUE, SUIT } = Constants.CARD;

function collectionWithCards(ids) {
    return new CardCollection(ids.map(id => {
        const [value, suit] = id.split("-");
        return new Card(value, suit, 0);
    }));
}


test("an unshuffled deck contains 54 unique cards", () => {
    const deck = CardCollection.createDeck(false);
    const ids = deck.items.map((card) => card.id);

    assert.equal(deck.items.length, 54);
    assert.equal(new Set(ids).size, 54);
    assert.equal(ids.filter((id) => id.startsWith("joker-")).length, 2);
});

test("deck drawing preserves last-in first-out order", () => {
    const deck = CardCollection.createDeck(false);
    deck.clear();

    const two = new Card(VALUE.TWO.id, SUIT.CLUBS);
    const three = new Card(VALUE.THREE.id, SUIT.CLUBS);
    const four = new Card(VALUE.FOUR.id, SUIT.CLUBS);

    deck.addMany([two, three]);
    deck.add(four);

    assert.deepEqual([deck.take(), deck.take(), deck.take()].map(String), ["4-clubs", "3-clubs", "2-clubs"]);
    assert.equal(deck.take(), null);
});

test("hands draw, discard, and total card penalties", () => {
    const hand = new CardCollection([new Card(VALUE.TWO.id, SUIT.CLUBS), new Card(VALUE.ACE.id, SUIT.SPADES)]);

    assert.equal(hand.items.length, 2);
    assert.equal(hand.penalty, 70);

    const discarded = hand.remove(new Card(VALUE.TWO.id, SUIT.CLUBS));
    assert.equal(discarded.id, "2-clubs");
    assert.equal(hand.penalty, 50);
    assert.equal(hand.remove(discarded), null);
});

test("hands serialize through Serializable with plain card snapshots", () => {
    const hand = new CardCollection([new Card(VALUE.TWO.id, SUIT.CLUBS, 0), new Card(VALUE.ACE.id, SUIT.SPADES, 0)]);
    const snapshot = hand.toJSON();

    assert.equal(snapshot.penalty, 70);
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

    hand.sort("rank");
    assert.deepEqual(hand.items.map(String), ["3-hearts", "8-spades", "k-clubs"]);

    hand.add(new Card(VALUE.TWO.id, SUIT.DIAMONDS));
    assert.deepEqual(hand.items.map(String), ["3-hearts", "8-spades", "k-clubs", "2-diamonds"]);
    assert.throws(() => hand.sort(null), /Invalid card sort key/);
    assert.throws(() => hand.sort("value"), /Invalid card sort key/);
});

test("shared sorting returns an ordered copy for browser rendering", () => {
    const cards = [
        { value: "k", suit: "clubs", rank: 13 },
        { value: "3", suit: "hearts", rank: 3 },
        { value: "8", suit: "spades", rank: 8 }
    ];

    const collection = new CardCollection(cards);
    assert.deepEqual(collection.sorted("rank").map((card) => card.value), ["3", "8", "k"]);
    assert.deepEqual(collection.items.map((card) => card.value), ["k", "3", "8"]);
    assert.deepEqual(
        cards.map((card) => card.value),
        ["k", "3", "8"]
    );
});

test("Pick2 card identity and collections use the same ranking rules", () => {
    const card = new Card("2", "clubs", 0);
    assert.equal(card.rank, 20);
    assert.equal(card.isDrawTwo(), true);
    assert.equal(new CardCollection([card]).penalty, 20);
    assert.equal(CardCollection.createDeck(false).items.length, 54);
});

test("Pick2 collections preserve specialized cards when creating and recycling", () => {
    const deck = CardCollection.createDeck(false);
    assert.ok(deck.items.every((card) => card instanceof Card));
    const hand = new CardCollection([{ value: "2", suit: "clubs", rotation: 0 }]);
    assert.equal(hand.penalty, 20);
    deck.add(hand.items[0]);
    const card = deck.take();
    assert.ok(card instanceof Card);
    assert.equal(card.isDrawTwo(), true);
    assert.equal(card.rank, 20);
});

test("CardCollection supports every sort mode without mutating the collection", () => {
    const cards = [
        { value: "k", suit: "clubs", rank: 13 },
        { value: "2", suit: "hearts", rank: 20 },
        { value: "5", suit: "diamonds", rank: 5 }
    ];
    const collection = new CardCollection(cards);
    assert.deepEqual(collection.sorted("none"), collection.items);
    assert.notEqual(collection.sorted("none"), collection.items);
    assert.deepEqual(
        collection.sorted("rank").map((card) => card.value),
        ["5", "k", "2"]
    );
    assert.deepEqual(
        collection.sorted("suit").map((card) => card.suit),
        ["clubs", "diamonds", "hearts"]
    );
    assert.throws(() => collection.sorted("score"), /Invalid card sort key/);
    assert.deepEqual(collection.items.map((card) => card.value), ["k", "2", "5"]);
    assert.throws(() => collection.sorted("unknown"), /Invalid card sort key/);
    assert.throws(() => collection.sorted("value"), /Invalid card sort key/);
});

test("collection legal-card queries distinguish matching, declared suits, and active draw defense", () => {
    const collection = collectionWithCards(["q-hearts", "5-clubs", "2-clubs", "a-spades", "joker-red"]);
    const before = [...collection.items];
    assert.deepEqual(collection.getLegalCards(new Card("2", "hearts", 0), null, 2).map(card => card.id),
        ["2-clubs", "a-spades", "joker-red"]);
    assert.deepEqual(collection.getLegalCards(new Card("5", "hearts", 0), null, 1).map(card => card.id),
        ["q-hearts", "5-clubs", "a-spades", "joker-red"]);
    assert.deepEqual(collection.getLegalCards(new Card("a", "diamonds", 0), "clubs", 1).map(card => card.id),
        ["5-clubs", "2-clubs", "a-spades", "joker-red"]);
    assert.deepEqual(collection.items, before);
});

test("collection suit queries exclude a proposed discard by identity and ignore joker colors", () => {
    const collection = collectionWithCards(["3-hearts", "q-hearts", "5-clubs", "joker-red"]);
    assert.equal(collection.getDominantSuit(), "hearts");
    const excluded = new Card("q", "hearts", 0);
    const counts = collection.getSuitCounts(excluded);
    assert.equal(counts.hearts, 1);
    assert.equal(counts.clubs, 1);
    assert.equal(counts.red, undefined);
    assert.equal(collection.getDominantSuit(excluded), Object.keys(counts).find(suit => counts[suit] === 1));
    assert.equal(collection.size, 4);
});

test("collection dominant suit is absent for empty and joker-only hands", () => {
    assert.equal(collectionWithCards([]).getDominantSuit(), null);
    assert.equal(collectionWithCards(["joker-black", "joker-red"]).getDominantSuit(), null);
});
