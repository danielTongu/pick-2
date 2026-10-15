"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { createConnection, latestGame } from "../helpers/host.js";
import { Constants } from "../../core/Constants.js";
import { Host } from "../../host/Host.js";
import { HostConnection } from "../../host/HostConnection.js";

for (const mode of ["direct", "hosted"]) {
    test(`${mode} rejects the removed discard-to-hand command`, async (t) => {
        const host = new Host(mode, 0, false);
        t.after(() => host.shutdown());
        const owner = createConnection(host, "owner");
        await owner.request(Constants.COMMANDS.CREATE, { roomName: "Discard Flow", playerName: "Alice", playerLimit: 2 });
        const drawn = latestGame(await owner.request(Constants.COMMANDS.DRAW));
        const card = drawn.match.turnOrder.players.find((player) => player.name === "Alice").collection.items[0];
        const discarded = latestGame(await owner.request(Constants.COMMANDS.DISCARD, { card }));
        assert.equal(discarded.match.collections.play.items.length, 1);

        const rejected = await owner.request("return", { card });
        assert.match(rejected.findLast((response) => response.message)?.message.message ?? "", /Unknown command/);
        const current = latestGame(await owner.request(Constants.COMMANDS.LIST)) ?? discarded;
        assert.equal(current.match.turnOrder.players.find((player) => player.name === "Alice").collection.items.length, 0);
        assert.deepEqual(current.match.collections.play.items[0], card);
    });
}

test("Host seeds configured bot players and leaves every remaining seat open", async (t) => {
    const host = new Host("direct", 0, false);
    t.after(() => host.shutdown());
    const connection = createConnection(host);
    const home = (await connection.request(Constants.COMMANDS.LIST)).findLast(
        (response) => response.view === Constants.VIEWS.HOME
    ).data;

    assert.deepEqual(
        home.rooms.map((room) => ({
            name: room.name,
            playerLimit: room.playerLimit,
            playerCount: room.match.turnOrder.playerCount
        })),
        Host.DEFAULT_ROOMS.map(({ roomName, playerLimit, botCount }) => ({
            name: roomName,
            playerLimit: playerLimit,
            playerCount: botCount
        }))
    );
    assert.equal(home.connectionMode, "direct");
    assert.equal(home.capabilities.botFill, false);
    await connection.connection.close();
});

test("a custom local game fills its open seats with bots immediately", async (t) => {
    const host = new Host("direct", "fill", false);
    t.after(() => host.shutdown());
    const connection = createConnection(host);
    const responses = await connection.request(Constants.COMMANDS.CREATE, {
        roomName: "Local Game",
        playerName: "Daniel",
        playerLimit: 4
    });
    const game = latestGame(responses);

    assert.equal(game.match.turnOrder.playerCount, 4);
    assert.equal(game.localPlayerName, "Daniel");
    assert.deepEqual(
        game.match.turnOrder.players.map((player) => player.name),
        ["Daniel", ...Host.DIRECT_OPPONENT_NAMES]
    );
    await connection.connection.close();
});

test("the shared Host rejects every join while a room is playing", async (t) => {
    const host = new Host("hosted", 0, false);
    t.after(() => host.shutdown());
    const owner = createConnection(host, "owner");
    const guest = createConnection(host, "guest");
    const lateGuest = createConnection(host, "late");

    await owner.request(Constants.COMMANDS.CREATE, {
        roomName: "Network Game",
        playerName: "Daniel",
        playerLimit: 3
    });
    await guest.request(Constants.COMMANDS.JOIN, {
        roomName: "Network Game",
        playerName: "Casey"
    });
    await owner.request(Constants.COMMANDS.START);
    const rejected = await lateGuest.request(Constants.COMMANDS.JOIN, {
        roomName: "Network Game",
        playerName: "Jordan"
    });

    assert.match(rejected.findLast((response) => response.message)?.message?.message ?? "", /in progress/i);
    await owner.connection.close();
    await guest.connection.close();
    await lateGuest.connection.close();
});

test("Host returns one connection and rejects another connection claiming its tab", async (t) => {
    const host = new Host("hosted", 0, false);
    t.after(function stopHost() { return host.shutdown(); });
    const owner = createConnection(host, "shared-tab");
    const other = createConnection(host, "shared-tab");

    assert.equal(owner.connection instanceof HostConnection, true);
    await owner.request(Constants.COMMANDS.CREATE, {
        roomName: "Owned Room", playerName: "Alice", playerLimit: 2
    });
    const rejected = await other.request(Constants.COMMANDS.VIEW, { roomName: "Owned Room" });

    assert.match(rejected.findLast(function findError(response) {
        return response.message?.status === Constants.STATUS.ERROR;
    })?.message?.message ?? "", /connection expired/i);
    assert.equal(owner.connection.isOpen, true);

    await owner.connection.close();
    assert.equal(owner.connection.isOpen, false);
    await other.connection.close();
});

test("a player can leave a hosted room while it is playing", async (t) => {
    const host = new Host("hosted", 0, false);
    t.after(() => host.shutdown());
    const owner = createConnection(host, "owner");
    const guest = createConnection(host, "guest");

    await owner.request(Constants.COMMANDS.CREATE, {
        roomName: "Active Room",
        playerName: "Daniel",
        playerLimit: 3
    });
    await guest.request(Constants.COMMANDS.JOIN, {
        roomName: "Active Room",
        playerName: "Casey"
    });
    await owner.request(Constants.COMMANDS.START);

    const homeResponses = await guest.request(Constants.COMMANDS.LEAVE);
    const home = homeResponses.findLast((response) => response.view === Constants.VIEWS.HOME);

    assert.ok(home);
    const activeRoom = home.data.rooms.find((room) => room.name === "Active Room");

    assert.ok(activeRoom);
    assert.equal(activeRoom.match.turnOrder.playerCount, 1);
    await owner.connection.close();
    await guest.connection.close();
});

test("Host retains a custom room in memory after its creator leaves", async (t) => {
    const host = new Host("direct", "fill", false);
    t.after(() => host.shutdown());
    const connection = createConnection(host, "owner");

    await connection.request(Constants.COMMANDS.CREATE, {
        roomName: "Saved Game",
        playerName: "Daniel",
        playerLimit: 3
    });
    const home = (await connection.request(Constants.COMMANDS.LEAVE)).findLast(
        (response) => response.view === Constants.VIEWS.HOME
    ).data;
    await connection.connection.close();

    assert.equal(
        home.rooms.some((room) => room.name === "Saved Game"),
        true
    );
});

test("default game configuration exposes three bot player-limit levels", () => {
    assert.deepEqual(
        Host.DEFAULT_ROOMS.map((room) => room.botCount),
        [3, 2, 1]
    );
    assert.equal(
        Host.DEFAULT_ROOMS.every((room) => Object.isFrozen(room)),
        true
    );
    assert.equal(Object.isFrozen(Host.DEFAULT_ROOMS), true);
});

test("direct opponent names are centralized and immutable", () => {
    assert.equal(Object.isFrozen(Host.DIRECT_OPPONENT_NAMES), true);
    assert.equal(Host.DIRECT_OPPONENT_NAMES.length, Constants.ROOM_PLAYER_LIMIT - 1);
    assert.equal(
        Host.DIRECT_OPPONENT_NAMES.every((name) => typeof name === "string" && name.trim().length > 0),
        true
    );
    assert.equal(new Set(Host.DIRECT_OPPONENT_NAMES).size, Host.DIRECT_OPPONENT_NAMES.length);
});
