"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../src/core/Card.js";
import { Constants } from "../src/core/Constants.js";
import { Deck } from "../src/core/Deck.js";
import { Player } from "../src/core/Player.js";
import { Session } from "../src/core/Session.js";
import { UserNotification } from "../src/core/UserNotification.js";

test("actionable player and game-rule failures use UserNotification", async () => {
    assert.throws(() => new Player(""), UserNotification);

    const session = new Session("Expected errors");
    await session.join("Alice");
    await session.join("Bob");
    await session.start();

    const turnOwner = session.circle.getTurnOwner();
    const otherPlayer = [...session.circle.players.values()].find(
        (player) => player.key !== turnOwner.key
    );

    await assert.rejects(session.passTurn(otherPlayer.name), UserNotification);

    for (const player of session.circle.players.values()) {
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
