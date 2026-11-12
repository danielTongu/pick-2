import assert from "node:assert/strict";
import test from "node:test";

import { RoomService } from "../../service/RoomService.js";
import { Constants } from "../../shared/Constants.js";
import { Card } from "../../model/Card.js";

/** Creates a monitored room with controllable time and automatic cleanup. */
function monitoredRoom(t) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const service = new RoomService("Idle Policy", 3);
    const expired = [];
    service.onPlayerIdle = function idle(name) { expired.push(name); };
    t.after(function cleanup() { service.stopIdleMonitoring(); });
    return { service, expired };
}

test("waiting humans expire while bots never receive idle timers", async (t) => {
    const { service, expired } = monitoredRoom(t);
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.joinPlayer("Robot", true);
    t.mock.timers.tick(Constants.ROOM_WAIT_MS);
    assert.deepEqual(expired, ["Alice", "Bob"]);
});

test("turn changes cancel the old human timer and give the next owner a full window", async (t) => {
    const { service, expired } = monitoredRoom(t);
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.startMatch();
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    const alice = service.room.match.turnOrder.get("Alice");
    alice.collection.items = [new Card("5", "clubs"), new Card("6", "diamonds")];
    await service.drawItems("Alice");
    t.mock.timers.tick(Constants.ROOM_WAIT_MS - 1);
    await service.passTurn("Alice");
    t.mock.timers.tick(1);
    assert.deepEqual(expired, []);
    t.mock.timers.tick(Constants.ROOM_WAIT_MS - 1);
    assert.deepEqual(expired, ["Bob"]);
});

test("departures and service shutdown release timers without late callbacks", async (t) => {
    const { service, expired } = monitoredRoom(t);
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.removePlayer("Alice");
    t.mock.timers.tick(Constants.ROOM_WAIT_MS);
    assert.deepEqual(expired, ["Bob"]);
    await service.joinPlayer("Casey");
    service.stopIdleMonitoring();
    t.mock.timers.tick(Constants.ROOM_WAIT_MS * 2);
    assert.deepEqual(expired, ["Bob"]);
});

test("unmonitored rooms do not schedule player expiration", async (t) => {
    const { service, expired } = monitoredRoom(t);
    service.onPlayerIdle = null;
    await service.joinPlayer("Alice");
    t.mock.timers.tick(Constants.ROOM_WAIT_MS * 2);
    assert.deepEqual(expired, []);
});
