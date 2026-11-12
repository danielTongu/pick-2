"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Card } from "../../model/Card.js";
import { Constants } from "../../shared/Constants.js";
import { Knockout } from "../../model/Knockout.js";
import { Match } from "../../model/Match.js";
import { RoomService } from "../../service/RoomService.js";

function stopPlayers(service) {
    service.stopIdleMonitoring();
}

async function playingRoom(t, names, knockout) {
    const service = new RoomService("Knockout Test", names.length);
    t.after(function cleanup() { stopPlayers(service); });
    for (const name of names) await service.joinPlayer(name);
    await service.startMatch(knockout);
    service.room.match.turnOrder.setOwner(names[0]);
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    for (const player of service.room.match.turnOrder.players.values()) player.collection.clear();
    return service;
}

test("knockout eliminates every tied high penalty and waits for Play", async (t) => {
    const service = await playingRoom(t, ["Alice", "Bob", "Casey", "Dana"], true);
    assert.ok(service.room.match instanceof Knockout);
    assert.equal(Object.hasOwn(service, "turnOrder"), false);
    assert.equal("turnOrder" in service, false);
    assert.equal(Object.hasOwn(service.room.toJSON(), "match"), true);
    assert.equal(Object.hasOwn(service.room.toJSON(), "turnOrder"), false);
    assert.equal(Object.hasOwn(service, "mode"), false);
    assert.equal(Object.hasOwn(service.room.toJSON(), "mode"), false);
    assert.equal(service.room.match.nextMatchAvailable, false);
    assert.equal(service.room.match.isKnockoutComplete, false);
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    service.room.match.turnOrder.get("Casey").collection.add(new Card("q", "diamonds"));
    service.room.match.turnOrder.get("Dana").collection.add(new Card("3", "clubs"));

    await service.playItem("Alice", "7", "hearts");
    assert.equal(Object.hasOwn(service, "winners"), false);
    assert.deepEqual([...service.room.match.turnOrder.players.values()].filter(function eliminated(player) {
        return player.state === Constants.PLAYER_STATE.ELIMINATED;
    }).map(function nameOf(player) { return player.name; }), ["Bob", "Casey"]);
    assert.deepEqual([...service.room.match.turnOrder.players.values()].map(function stateOf(player) { return player.state; }),
        ["qualified", "eliminated", "eliminated", "qualified"]);
    assert.equal(service.room.match.turnOrder.get("Bob").collection.penalty, 12);
    await service.movePlayerToView("Bob", "bob-tab");
    await service.movePlayerToView("Casey", "casey-tab");
    assert.equal(service.room.match.nextMatchAvailable, true);
    assert.deepEqual(service.room.match.turnOrder.order, ["alice", "dana"]);
    const currentOrder = service.room.match.turnOrder;
    await service.startMatch();
    assert.strictEqual(service.room.match.turnOrder, currentOrder);
    assert.deepEqual(service.room.match.turnOrder.order, ["alice", "dana"]);
    assert.equal(service.room.match.isKnockoutComplete, false);
    assert.ok(service.room.match instanceof Knockout);
    assert.equal(service.room.match.nextMatchAvailable, false);
});

test("knockout final match can tie and a one-on-one departure awards the remaining player", async (t) => {
    const service = await playingRoom(t, ["Alice", "Bob"], true);
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Alice").collection.add(new Card("5", "clubs"));
    service.room.match.turnOrder.get("Bob").collection.add(new Card("5", "diamonds"));
    await service.playItem("Alice", "7", "hearts");
    assert.deepEqual([...service.room.match.turnOrder.players.values()].map(function stateOf(player) { return player.state; }),
        [Constants.PLAYER_STATE.WON, Constants.PLAYER_STATE.WON]);
    assert.equal(service.room.match.isKnockoutComplete, true);
    assert.equal(service.room.match.nextMatchAvailable, false);

    const forfeit = await playingRoom(t, ["Alice", "Bob"], true);
    await forfeit.removePlayer("Bob");
    assert.equal(forfeit.room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(forfeit.room.match.isKnockoutComplete, true);
    assert.equal(forfeit.room.match.state, Constants.ROOM_STATE.FINISHED);
});

test("ordinary match keeps its existing winner and departure behavior", async (t) => {
    const service = await playingRoom(t, ["Alice", "Bob", "Casey"], false);
    assert.ok(service.room.match instanceof Match);
    assert.equal(service.room.match instanceof Knockout, false);
    assert.equal("prepareNextMatch" in service.room.match, false);
    assert.equal("afterPlayerRemoved" in service.room.match, false);
    assert.equal("nextMatchAvailable" in service.room.match, false);
    assert.equal("isKnockoutComplete" in service.room.match, false);
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    service.room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await service.playItem("Alice", "7", "hearts");
    assert.equal(service.room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(Object.hasOwn(service.room.match, "nextMatchAvailable"), false);
    assert.equal(service.room.match instanceof Knockout, false);
});

test("a qualified player wins if the other player leaves before the next Play", async (t) => {
    const service = await playingRoom(t, ["Alice", "Bob", "Casey"], true);
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Bob").collection.add(new Card("q", "clubs"));
    service.room.match.turnOrder.get("Casey").collection.add(new Card("3", "clubs"));
    await service.playItem("Alice", "7", "hearts");
    await service.movePlayerToView("Bob", "bob-tab");
    assert.equal(service.room.match.nextMatchAvailable, true);
    await service.removePlayer("Casey");
    assert.equal(service.room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
    assert.equal(service.room.match.isKnockoutComplete, true);
    assert.equal(service.room.match.nextMatchAvailable, false);
    assert.equal(service.room.match.turnOrder.get("Alice").state, Constants.PLAYER_STATE.WON);
});

test("a full high-penalty tie eliminates everyone and ends the knockout in a tie", async (t) => {
    const service = await playingRoom(t, ["Alice", "Bob", "Casey"], true);
    service.room.match.turnOrder.get("Alice").collection.add(new Card("7", "hearts"));
    service.room.match.turnOrder.get("Alice").collection.add(new Card("5", "clubs"));
    service.room.match.turnOrder.get("Bob").collection.add(new Card("5", "diamonds"));
    service.room.match.turnOrder.get("Casey").collection.add(new Card("5", "spades"));
    await service.playItem("Alice", "7", "hearts");
    assert.deepEqual([...service.room.match.turnOrder.players.values()].map(function stateOf(player) { return player.state; }),
        [Constants.PLAYER_STATE.ELIMINATED, Constants.PLAYER_STATE.ELIMINATED, Constants.PLAYER_STATE.ELIMINATED]);
    for (const name of ["Alice", "Bob", "Casey"]) await service.removePlayer(name);
    assert.equal([...service.room.match.turnOrder.players.values()].some(function won(player) {
        return player.state === Constants.PLAYER_STATE.WON;
    }), false);
    assert.equal(service.room.match.isKnockoutComplete, true);
});
