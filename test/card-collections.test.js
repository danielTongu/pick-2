import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../core/Card.js";
import { CardCollection } from "../core/CardCollection.js";

test("Pick2 card identity and collections use the same scoring rules", () => {
    const card = new Card("2", "clubs", 0);
    assert.equal(card.rank, 2);
    assert.equal(card.score, 20);
    assert.equal(card.isDrawTwo(), true);
    assert.equal(new CardCollection([card]).score, 20);
    assert.equal(CardCollection.createDeck(false).items.length, 54);
});

test("Pick2 collections preserve specialized cards when creating and recycling", () => {
    const deck = CardCollection.createDeck(false);
    assert.ok(deck.items.every((card) => card instanceof Card));
    const hand = new CardCollection([{ value: "2", suit: "clubs", rotation: 0 }]);
    assert.equal(hand.score, 20);
    deck.add(hand.items[0]);
    const card = deck.take();
    assert.ok(card instanceof Card);
    assert.equal(card.isDrawTwo(), true);
    assert.equal(card.score, 20);
});
