"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../core/Card.js";
import { CardCollection } from "../core/CardCollection.js";
import { Constants } from "../core/Constants.js";
import { Player } from "../core/Player.js";
import { Room } from "../core/Room.js";
import { UserNotification } from "../core/UserNotification.js";
import { ValidationUtils } from "../core/ValidationUtils.js";

test("named strings accept readable names and reject unsupported characters", () => {
    assert.equal(ValidationUtils.namedString("  Saoirse O'Connor  ", "Player name", 24), "Saoirse O'Connor");
    assert.equal(ValidationUtils.namedString("Été-2026", "Room name", 48), "Été-2026");

    for (const value of ["", "a", "!!!", "Room__", "two  spaces", "Room/7", "Room."]) {
        assert.throws(() => ValidationUtils.namedString(value, "Room name", 48), UserNotification);
    }
});

test("actionable player and game-rule failures use UserNotification", async () => {
    assert.throws(() => new Player("", { drawAllowance: 1 }), UserNotification);

    const room = new Room("Expected errors");
    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    await room.startMatch();

    const turnOwner = room.match.turnOrder.owner;
    const otherPlayer = [...room.match.turnOrder.players.values()].find((player) => player.key !== turnOwner.key);

    await assert.rejects(room.passTurn(otherPlayer.name), UserNotification);

    for (const player of room.match.turnOrder.players.values()) {
        player.stopIdleMonitoring();
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
