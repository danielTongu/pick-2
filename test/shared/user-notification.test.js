"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../../model/Card.js";
import { CardCollection } from "../../model/CardCollection.js";
import { Constants } from "../../shared/Constants.js";
import { Player } from "../../model/Player.js";
import { RoomService } from "../../service/RoomService.js";
import { UserNotification } from "../../shared/UserNotification.js";
import { ValidationUtils } from "../../shared/ValidationUtils.js";

test("notification constants use uniform names and payloads", () => {
    for (const group of [Constants.AUTO_NOTIFICATIONS, Constants.ACTION_NOTIFICATIONS]) {
        for (const [name, notification] of Object.entries(group)) {
            assert.match(name, /^[A-Z][A-Z_]*$/);
            assert.deepEqual(Object.keys(notification), ["status", "title", "message"]);
            assert.ok(Object.isFrozen(notification));
        }
    }
});

test("named strings accept readable names and reject unsupported characters", () => {
    assert.equal(ValidationUtils.namedString("  Saoirse O'Connor  ", "Player name", 24), "Saoirse O'Connor");
    assert.equal(ValidationUtils.namedString("Été-2026", "Room name", 48), "Été-2026");

    for (const value of ["", "a", "!!!", "Room__", "two  spaces", "Room/7", "Room."]) {
        assert.throws(() => ValidationUtils.namedString(value, "Room name", 48), UserNotification);
    }
});

test("actionable player and game-rule failures use UserNotification", async () => {
    assert.throws(() => new Player("", { drawAllowance: 1 }), UserNotification);

    const service = new RoomService("Expected errors");
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.startMatch();

    const turnOwner = service.room.match.turnOrder.owner;
    const otherPlayer = [...service.room.match.turnOrder.players.values()].find((player) => player.key !== turnOwner.key);

    await assert.rejects(service.passTurn(otherPlayer.name), UserNotification);

    service.stopIdleMonitoring();
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
