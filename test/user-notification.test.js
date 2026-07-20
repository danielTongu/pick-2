"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../server/Card.js";
import { Constants } from "../public/scripts/Constants.js";
import { Deck } from "../server/Deck.js";
import { UserNotification } from "../server/UserNotification.js";
import { Player } from "../server/Player.js";
import { Room } from "../server/Room.js";

test("actionable player and game-rule failures use UserNotification", async () => {
    assert.throws(() => new Player(""), UserNotification);

    const room = new Room("Expected errors");
    await room.admitPlayer("Alice");
    await room.admitPlayer("Bob");
    await room.startGame();

    const currentPlayer = room.getCurrentPlayer();
    const otherPlayer = [...room.circle.players.values()].find(
        (player) => player.key !== currentPlayer.key
    );

    await assert.rejects(room.passTurn(otherPlayer.name), UserNotification);

    for (const player of room.circle.players.values()) {
        player.stopIdleMonitoring();
    }
});

test("internal contract failures remain ordinary errors", () => {
    assert.throws(
        () => new Deck("yes"),
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
