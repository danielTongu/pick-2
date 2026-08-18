"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../src/core/Card.js";
import { Constants } from "../src/core/Constants.js";

const { VALUE, SUIT } = Constants.CARD;

test("card-domain constants expose immutable canonical collections", () => {
    assert.deepEqual(Constants.CARD.STANDARD_SUITS, [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS, SUIT.SPADES]);
    assert.deepEqual(Constants.CARD.JOKER_SUITS, [SUIT.BLACK, SUIT.RED]);
    assert.equal(Constants.CARD.STANDARD_VALUES.includes(VALUE.ACE.id), true);
    assert.equal(Constants.CARD.STANDARD_VALUES.includes(VALUE.JOKER.id), false);
    assert.equal(Object.isFrozen(Constants.CARD.STANDARD_SUITS), true);
    assert.equal(Object.isFrozen(Constants.CARD.JOKER_SUITS), true);
    assert.equal(Object.isFrozen(Constants.CARD.STANDARD_VALUES), true);
});

test("default session configuration assigns two AI players to two sessions", () => {
    assert.equal(Constants.DEFAULT_SESSIONS.filter((session) => session.aiCount === 2).length, 2);
    assert.equal(Constants.DEFAULT_SESSIONS.every((session) => Object.isFrozen(session)), true);
    assert.equal(Object.isFrozen(Constants.DEFAULT_SESSIONS), true);
});

test("the Session API uses one-word actions", () => {
    assert.deepEqual(Constants.ACTIONS, {
        LIST: "list",
        CREATE: "create",
        VIEW: "view",
        JOIN: "join",
        LEAVE: "leave",
        START: "start",
        PASS: "pass",
        DRAW: "draw",
        DISCARD: "discard",
        DECLARE: "declare"
    });
    assert.equal(Object.values(Constants.ACTIONS).every((action) => !action.includes("_")), true);
});

test("local opponent names are centralized and immutable", () => {
    assert.equal(Object.isFrozen(Constants.LOCAL_OPPONENT_NAMES), true);
    assert.equal(Constants.LOCAL_OPPONENT_NAMES.length, Constants.SESSION_MAX_CAPACITY - 1);
    assert.equal(
        Constants.LOCAL_OPPONENT_NAMES.every((name) => typeof name === "string" && name.trim().length > 0),
        true
    );
    assert.equal(new Set(Constants.LOCAL_OPPONENT_NAMES).size, Constants.LOCAL_OPPONENT_NAMES.length);
});

test("card-domain suit operations share canonical suit definitions", () => {
    assert.equal(Constants.isStandardSuit(SUIT.HEARTS), true);
    assert.equal(Constants.isStandardSuit(SUIT.RED), false);
    assert.equal(Constants.isJokerSuit(SUIT.RED), true);
    assert.equal(Constants.isJokerSuit(SUIT.SPADES), false);
    assert.equal(Constants.normalizeStandardSuit("  HEARTS "), SUIT.HEARTS);
    assert.throws(() => Constants.normalizeStandardSuit("purple"), /Invalid suit/);
});

test("cards validate standard cards and joker suits", () => {
    assert.equal(new Card(VALUE.ACE.id, SUIT.HEARTS, 0).getId(), "a-hearts");
    assert.equal(new Card(VALUE.JOKER.id, SUIT.RED, 0).getId(), "joker-red");

    assert.throws(() => new Card("1", SUIT.HEARTS), /Invalid card value/);
    assert.throws(() => new Card(VALUE.JOKER.id, SUIT.HEARTS), /Joker must use red or black suit/);
    assert.throws(() => new Card(VALUE.KING.id, SUIT.RED), /Invalid card suit/);
});

test("special cards use the expected scores", () => {
    assert.equal(new Card(VALUE.TWO.id, SUIT.CLUBS).score, 20);
    assert.equal(new Card(VALUE.SEVEN.id, SUIT.HEARTS).score, 30);
    assert.equal(new Card(VALUE.ACE.id, SUIT.SPADES).score, 40);
    assert.equal(new Card(VALUE.JOKER.id, SUIT.BLACK).score, 50);
    assert.equal(new Card(VALUE.KING.id, SUIT.DIAMONDS).score, 13);
});

test("card scores come from the shared constants source", () => {
    assert.equal(Constants.getCardScore(VALUE.TWO.id, SUIT.HEARTS), Constants.CARD.SCORE.TWO);
    assert.equal(Constants.getCardScore(VALUE.SEVEN.id, SUIT.HEARTS), Constants.CARD.SCORE.SEVEN_OF_HEARTS);
    assert.equal(Constants.getCardScore(VALUE.ACE.id, SUIT.SPADES), Constants.CARD.SCORE.ACE_OF_SPADES);
    assert.equal(Constants.getCardScore(VALUE.JOKER.id, SUIT.RED), Constants.CARD.SCORE.JOKER);
    assert.equal(Constants.getCardScore(VALUE.QUEEN.id, SUIT.CLUBS), VALUE.QUEEN.rank);
});

test("emoji constants provide reusable silly and winner groups", () => {
    assert.equal(Constants.EMOJIS.silly.values.length > 0, true);
    assert.deepEqual(Constants.EMOJIS.winner.values, ["🏆", "🎉", "🎊"]);
    assert.equal(Constants.EMOJIS.silly.values.includes(Constants.EMOJIS.silly.random), true);
    assert.equal(Constants.EMOJIS.winner.values.includes(Constants.EMOJIS.winner.random), true);
    assert.equal(Object.isFrozen(Constants.EMOJIS.silly.values), true);
    assert.equal(Object.isFrozen(Constants.EMOJIS.winner.values), true);
});

test("player inactivity timeout is a positive whole-second duration", () => {
    assert.equal(Constants.MAX_IDLE_MS, 30_000);
    assert.equal(Constants.MAX_IDLE_MS > 0, true);
    assert.equal(Constants.MAX_IDLE_MS % 1_000, 0);
});

test("ordinary plays must match value or suit", () => {
    const top = new Card(VALUE.FIVE.id, SUIT.HEARTS);

    assert.equal(new Card(VALUE.FIVE.id, SUIT.CLUBS).isLegalOn(top), true);
    assert.equal(new Card(VALUE.KING.id, SUIT.HEARTS).isLegalOn(top), true);
    assert.equal(new Card(VALUE.KING.id, SUIT.CLUBS).isLegalOn(top), false);
    assert.equal(new Card(VALUE.JOKER.id, SUIT.RED).isLegalOn(top), true);
    assert.equal(new Card(VALUE.ACE.id, SUIT.SPADES).isLegalOn(top), true);
});

test("declared suits override ordinary compatibility", () => {
    const top = new Card(VALUE.ACE.id, SUIT.HEARTS);

    assert.equal(new Card(VALUE.FIVE.id, SUIT.CLUBS).isLegalOn(top, SUIT.CLUBS), true);
    assert.equal(new Card(VALUE.FIVE.id, SUIT.HEARTS).isLegalOn(top, SUIT.CLUBS), false);
    assert.equal(new Card(VALUE.ACE.id, SUIT.DIAMONDS).isLegalOn(top, SUIT.CLUBS), true);
});

test("draw penalties only accept a sufficient draw card or ace of spades", () => {
    const drawTwo = new Card(VALUE.TWO.id, SUIT.HEARTS);
    const joker = new Card(VALUE.JOKER.id, SUIT.BLACK);

    assert.equal(new Card(VALUE.TWO.id, SUIT.CLUBS).isLegalOn(drawTwo, null, 2), true);
    assert.equal(new Card(VALUE.JOKER.id, SUIT.RED).isLegalOn(drawTwo, null, 2), true);
    assert.equal(new Card(VALUE.ACE.id, SUIT.SPADES).isLegalOn(drawTwo, null, 2), true);
    assert.equal(new Card(VALUE.KING.id, SUIT.HEARTS).isLegalOn(drawTwo, null, 2), false);
    assert.equal(new Card(VALUE.TWO.id, SUIT.CLUBS).isLegalOn(joker, null, 4), false);
});

test("special card effects vary by player count", () => {
    assert.equal(new Card(VALUE.SEVEN.id, SUIT.HEARTS).isSessionEndCard(), true);
    assert.equal(new Card(VALUE.EIGHT.id, SUIT.CLUBS).isSkip(4), true);
    assert.equal(new Card(VALUE.JACK.id, SUIT.CLUBS).isSkip(2), true);
    assert.equal(new Card(VALUE.JACK.id, SUIT.CLUBS).isReverse(4), true);
    assert.equal(new Card(VALUE.JACK.id, SUIT.CLUBS).isReverse(2), false);
});
