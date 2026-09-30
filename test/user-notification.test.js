"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../core/Card.js";
import { CardCollection } from "../core/CardCollection.js";
import { Constants } from "../core/Constants.js";
import { Actor } from "../core/Actor.js";
import { Room } from "../core/Room.js";
import { UserNotification } from "../core/UserNotification.js";
import { ValidationUtils } from "../core/ValidationUtils.js";

test("named strings accept readable names and reject unsupported characters", () => {
    assert.equal(ValidationUtils.namedString("  Saoirse O'Connor  ", "Actor name", 24), "Saoirse O'Connor");
    assert.equal(ValidationUtils.namedString("Été-2026", "Room name", 48), "Été-2026");

    for (const value of ["", "a", "!!!", "Room__", "two  spaces", "Room/7", "Room."]) {
        assert.throws(() => ValidationUtils.namedString(value, "Room name", 48), UserNotification);
    }
});

test("actionable actor and game-rule failures use UserNotification", async () => {
    assert.throws(() => new Actor("", { drawAllowance: 1 }), UserNotification);

    const room = new Room("Expected errors");
    await room.joinActor("Alice");
    await room.joinActor("Bob");
    await room.startMatch();

    const turnOwner = room.match.turnOrder.owner;
    const otherActor = [...room.match.turnOrder.actors.values()].find((actor) => actor.key !== turnOwner.key);

    await assert.rejects(room.passTurn(otherActor.name), UserNotification);

    for (const actor of room.match.turnOrder.actors.values()) {
        actor.stopIdleMonitoring();
    }
});

test("internal contract failures remain ordinary errors", () => {
    assert.throws(
        () => CardCollection.createDeck("yes"),
        (error) => error instanceof Error && !(error instanceof UserNotification)
    );

    assert.throws(
        () => new Card("invalid", Constants.CARD.SUIT.CLUBS),
        (error) => error instanceof Error && !(error instanceof UserNotification)
    );

    assert.throws(
        () => new Card(Constants.CARD.VALUE.ACE.id, Constants.CARD.SUIT.SPADES, Number.NaN),
        (error) => error instanceof Error && !(error instanceof UserNotification)
    );
});
