"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { CardCollection } from "../core/CardCollection.js";
import { Card } from "../core/Card.js";

function collectionWithCards(ids) {
    return new CardCollection(ids.map(id => {
        const [value, suit] = id.split("-");
        return new Card(value, suit, 0);
    }));
}

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
