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

for (const mode of ["direct", "hosted"]) {
    test(`${mode} returns action notifications to the initiating player`, async (t) => {
        const { Host } = await import("../host/Host.js");
        const { NotificationUtils } = await import("../ui/utilities/NotificationUtils.js");
        const host = new Host(mode, 0, false);
        t.after(() => host.shutdown());
        const responses = [];
        const connection = host.accept((response) => responses.push(response), () => {});
        async function request(command, data = {}) {
            responses.length = 0;
            await connection.receive({ command, data: { tabId: "notifications", ...data } });
            return responses.findLast((response) => response.message)?.message;
        }
        const created = await request("create", { roomName: "Notice Room", playerName: "Alice", playerLimit: 2 });
        assert.equal(created.status, "success");
        assert.equal(created.title, "Room created");
        const drawn = await request("draw");
        assert.deepEqual(drawn, { status: "success", title: "+ 1", message: "Card added" });
        assert.deepEqual(NotificationUtils.normalize(drawn), drawn);
        const failed = await request("join", { roomName: "Missing Room", playerName: "Alice" });
        assert.equal(failed.status, "error");
        assert.equal(failed.title, "Join Room");
        assert.match(failed.message, /Room not found/);
        const left = await request("leave");
        assert.equal(left.status, "success");
        assert.equal(left.title, "Left room");
        const joined = await request("join", { roomName: Constants.DEFAULT_ROOMS[0].roomName, playerName: "Alice" });
        assert.deepEqual(joined, { status: "success", title: "Player Joined", message: "Welcome, Alice !!" });
        const viewerResponses = [];
        const viewer = host.accept((response) => viewerResponses.push(response), () => {});
        await viewer.receive({ command: "view", data: { tabId: "viewer", roomName: Constants.DEFAULT_ROOMS[0].roomName } });
        assert.deepEqual(viewerResponses.findLast((response) => response.message)?.message, {
            status: "success", title: "Viewer Entered", message: "Welcome viewer. See FAQ to learn more."
        });
        const started = await request("start");
        assert.equal(started, undefined);
        assert.ok(responses.some((response) => response.data?.match?.state === Constants.ROOM_STATE.ACTIVE));
        const viewerOffset = viewerResponses.length;
        await viewer.receive({ command: "start", data: { tabId: "viewer" } });
        const failedStart = viewerResponses.slice(viewerOffset).findLast((response) => response.message)?.message;
        assert.equal(failedStart.status, "error");
        assert.equal(failedStart.title, "Start Match");
    });
}

test("card additions use a count title and reserve emoji for draw effects", async (t) => {
    const { Host } = await import("../host/Host.js");
    const host = new Host("hosted", 0, false);
    t.after(() => host.shutdown());
    for (const [command, state, count, effect] of [
        ["draw", Constants.ROOM_STATE.WAITING, 1, false],
        ["draw", Constants.ROOM_STATE.ACTIVE, 1, false],
        ["draw", Constants.ROOM_STATE.ACTIVE, 2, true],
        ["pass", Constants.ROOM_STATE.ACTIVE, 2, true]
    ]) {
        const room = { match: { state }, perform: async () => Array(count).fill({}) };
        const notice = await host.executeMatchCommand(room, "Alice", command, {});
        assert.equal(notice.status, "success");
        assert.equal(notice.title, `+ ${count}`);
        const detail = `${count === 1 ? "Card" : "Cards"} added`;
        if (effect) {
            assert.ok(["😈", "😂", "😝", "🙃", "🤪"].some((emoji) => notice.message === `${detail} ${emoji}`));
        } else {
            assert.equal(notice.message, detail);
        }
    }
});

test("playing a card identifies its value and suit, including plays that draw cards", async (t) => {
    const { Host } = await import("../host/Host.js");
    const host = new Host("hosted", 0, false);
    t.after(() => host.shutdown());
    for (const drawn of [[], [{}]]) {
        const room = { match: { state: Constants.ROOM_STATE.ACTIVE }, perform: async () => drawn };
        const notice = await host.executeMatchCommand(room, "Alice", "discard", { card: { value: "7", suit: "hearts" } });
        assert.deepEqual(notice, { status: "success", title: "Card played", message: "7-hearts" });
    }
});
