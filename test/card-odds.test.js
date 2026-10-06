"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../core/Card.js";
import { CardOdds } from "../core/CardOdds.js";

test("response odds count legal cards without inspecting actual opponent hands", () => {
    const unseen = [new Card("3", "hearts", 0), new Card("5", "clubs", 0), new Card("9", "spades", 0)];
    const top = new Card("5", "hearts", 0);
    assert.ok(Math.abs(CardOdds.responseChance(top, null, 1, unseen) - 2 / 3) < 1e-12);
    assert.equal(CardOdds.responseChance(top, null, 2, unseen), 1);
    assert.equal(CardOdds.responseChance(top, null, 0, unseen), 0);
    assert.equal(CardOdds.responseChance(top, null, 1, []), 0);
});

test("response odds respect a declared suit and draw-attack defenses", () => {
    const unseen = [new Card("3", "clubs", 0), new Card("2", "hearts", 0), new Card("a", "spades", 0)];
    assert.ok(Math.abs(CardOdds.responseChance(new Card("a", "diamonds", 0), "clubs", 1, unseen) - 2 / 3) < 1e-12);
    assert.ok(Math.abs(CardOdds.responseChance(new Card("2", "clubs", 0), null, 1, unseen) - 2 / 3) < 1e-12);
});

test("penalty odds sample without replacement and include tied penalties", () => {
    const unseen = [new Card("3", "clubs", 0), new Card("5", "hearts", 0), new Card("8", "spades", 0)];
    assert.equal(CardOdds.penaltyChance(5, 1, unseen), 2 / 3);
    assert.equal(CardOdds.penaltyChance(10, 2, unseen), 2 / 3);
    assert.equal(CardOdds.penaltyChance(8, 2, unseen), 1);
    assert.equal(CardOdds.penaltyChance(20, 2, unseen), 0);
    assert.equal(CardOdds.penaltyChance(0, 0, []), 1);
    assert.equal(CardOdds.penaltyChance(1, 0, unseen), 0);
    assert.equal(CardOdds.penaltyChance(1, 2, []), 0);
});

test("response odds clear a collected draw penalty while retaining the public top card", () => {
    const joker = new Card("joker", "red", 0);
    const cards = [new Card("3", "hearts", 0)];
    assert.equal(CardOdds.responseChance(joker, null, 1, cards), 0);
    assert.equal(CardOdds.responseChance(joker, null, 1, cards, 1), 1);
});
