"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../../core/Card.js";
import { Constants } from "../../core/Constants.js";
import { Knockout, Match, Room } from "../../core/Room.js";

function stopPlayers(room) {
    for (const player of room.match.turnOrder.players.values()) player.stopIdleMonitoring();
}

async function playingRoom(t, names, knockout) {
    const room = new Room("Knockout Test", names.length);
    t.after(function cleanup() { stopPlayers(room); });
    for (const name of names) await room.joinPlayer(name);
    await room.startMatch(knockout);
    room.match.turnOrder.setOwner(names[0]);
    room.match.collections.play.items = [new Card("5", "hearts")];
    for (const player of room.match.turnOrder.players.values()) player.collection.clear();
    return room;
}

test("knockout eliminates every tied high penalty and waits for Play", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey", "Dana"], true);
    assert.ok(room.match instanceof Knockout);
    assert.equal(Object.hasOwn(room, "turnOrder"), false);
    assert.equal("turnOrder" in room, false);
    assert.equal(Object.hasOwn(room.toJSON(), "match"), true);
    assert.equal(Object.hasOwn(room.toJSON(), "turnOrder"), false);
    assert.equal(Object.hasOwn(room, "mode"), false);
    assert.equal(Object.hasOwn(room.toJSON(), "mode"), false);
    assert.equal(room.match.nextMatchAvailable, false);
    assert.equal(room.match.isKnockoutComplete, false);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("q", "diamonds"));
    room.match.turnOrder.get("Dana").collection.add(new Card("3", "clubs"));

    await room.playItem("Alice", "7", "hearts");
    assert.equal(Object.hasOwn(room, "winners"), false);
    assert.deepEqual([...room.match.turnOrder.players.values()].filter(function eliminated(player) {
        return player.state === Constants.PLAYER_STATE.ELIMINATED;
    }).map(function nameOf(player) { return player.name; }), ["Bob", "Casey"]);
    assert.deepEqual([...room.match.turnOrder.players.values()].map(function stateOf(player) { return player.state; }),
        ["qualified", "eliminated", "eliminated", "qualified"]);
    assert.equal(room.match.turnOrder.get("Bob").collection.penalty, 12);
    await room.movePlayerToView("Bob", "bob-tab");
    await room.movePlayerToView("Casey", "casey-tab");
    assert.equal(room.match.nextMatchAvailable, true);
    assert.deepEqual(room.match.turnOrder.order, ["alice", "dana"]);
    const currentOrder = room.match.turnOrder;
    await room.startMatch();
    assert.strictEqual(room.match.turnOrder, currentOrder);
    assert.deepEqual(room.match.turnOrder.order, ["alice", "dana"]);
    assert.equal(room.match.isKnockoutComplete, false);
    assert.ok(room.match instanceof Knockout);
    assert.equal(room.match.nextMatchAvailable, false);
});

test("knockout final match can tie and a one-on-one departure awards the remaining player", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob"], true);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Alice").collection.add(new Card("5", "clubs"));
    room.match.turnOrder.get("Bob").collection.add(new Card("5", "diamonds"));
    await room.playItem("Alice", "7", "hearts");
    assert.deepEqual([...room.match.turnOrder.players.values()].map(function stateOf(player) { return player.state; }),
        [Constants.PLAYER_STATE.WON, Constants.PLAYER_STATE.WON]);
    assert.equal(room.match.isKnockoutComplete, true);
    assert.equal(room.match.nextMatchAvailable, false);

    const forfeit = await playingRoom(t, ["Alice", "Bob"], true);
    await forfeit.removePlayer("Bob");
    assert.equal(forfeit.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(forfeit.match.isKnockoutComplete, true);
    assert.equal(forfeit.match.state, Constants.ROOM_STATE.FINISHED);
});

test("ordinary match keeps its existing winner and departure behavior", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey"], false);
    assert.ok(room.match instanceof Match);
    assert.equal(room.match instanceof Knockout, false);
    assert.equal("prepareNextMatch" in room.match, false);
    assert.equal("afterPlayerRemoved" in room.match, false);
    assert.equal("nextMatchAvailable" in room.match, false);
    assert.equal("isKnockoutComplete" in room.match, false);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await room.playItem("Alice", "7", "hearts");
    assert.equal(room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(Object.hasOwn(room.match, "nextMatchAvailable"), false);
    assert.equal(room.match instanceof Knockout, false);
});

test("a qualified player wins if the other player leaves before the next Play", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey"], true);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await room.playItem("Alice", "7", "hearts");
    await room.movePlayerToView("Bob", "bob-tab");
    assert.equal(room.match.nextMatchAvailable, true);
    await room.removePlayer("Casey");
    assert.equal(room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(room.match.isKnockoutComplete, true);
    assert.equal(room.match.nextMatchAvailable, false);
    assert.equal(room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
});

test("a full high-penalty tie eliminates everyone and ends the knockout in a tie", async (t) => {
    const room = await playingRoom(t, ["Alice", "Bob", "Casey"], true);
    room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    room.match.turnOrder.get("Alice").collection.add(new Card("5", "clubs"));
    room.match.turnOrder.get("Bob").collection.add(new Card("5", "diamonds"));
    room.match.turnOrder.get("Casey").collection.add(new Card("5", "spades"));
    await room.playItem("Alice", "7", "hearts");
    assert.deepEqual([...room.match.turnOrder.players.values()].map(function stateOf(player) { return player.state; }),
        [Constants.PLAYER_STATE.ELIMINATED, Constants.PLAYER_STATE.ELIMINATED, Constants.PLAYER_STATE.ELIMINATED]);
    for (const name of ["Alice", "Bob", "Casey"]) await room.removePlayer(name);
    assert.equal([...room.match.turnOrder.players.values()].some(function won(player) {
        return player.state === Constants.PLAYER_STATE.WON;
    }), false);
    assert.equal(room.match.isKnockoutComplete, true);
});

