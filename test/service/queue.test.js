import assert from "node:assert/strict";
import test from "node:test";

import { RoomService } from "../../service/RoomService.js";
import { Constants } from "../../shared/Constants.js";
import { Card } from "../../model/Card.js";

// These scenarios exercise public operations competing for the same room queue.
test("concurrent admissions obey capacity and a rejected admission does not poison the queue", async (t) => {
    const service = new RoomService("Concurrent Room", 2);
    t.after(function cleanup() { service.stopIdleMonitoring(); });
    const admissions = await Promise.allSettled([
        service.joinPlayer("Alice"), service.joinPlayer("Bob"), service.joinPlayer("Casey")
    ]);
    assert.deepEqual(admissions.map(function status(result) { return result.status; }),
        ["fulfilled", "fulfilled", "rejected"]);
    assert.match(admissions[2].reason.message, /Room is full/);
    await service.removePlayer("Bob");
    await service.joinPlayer("Casey");
    assert.deepEqual(service.room.match.turnOrder.order, ["alice", "casey"]);
});

test("queued match commands revalidate turn ownership after earlier mutations and recover after failure", async (t) => {
    const service = new RoomService("Command Queue", 2);
    t.after(function cleanup() { service.stopIdleMonitoring(); });
    const alice = await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.startMatch();
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    alice.collection.items = [new Card("5", "clubs"), new Card("6", "diamonds")];
    const results = await Promise.allSettled([
        service.perform("discard", "Alice", { card: { value: "5", suit: "clubs" } }),
        service.perform("draw", "Alice"),
        service.perform("draw", "Bob")
    ]);
    assert.deepEqual(results.map(function status(result) { return result.status; }),
        ["fulfilled", "rejected", "fulfilled"]);
    assert.match(results[1].reason.message, /Not your turn/);
    assert.equal(results[2].value.length, 1);
});

test("command admission resumes ordinary results inside the service without resetting hands", async (t) => {
    const service = new RoomService("Resume Queue", 2);
    t.after(function cleanup() { service.stopIdleMonitoring(); });
    const alice = await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    alice.collection.add(new Card("3", "clubs"));
    service.room.match.state = Constants.ROOM_STATE.FINISHED;
    await Promise.all([service.perform("draw", "Alice"), service.perform("draw", "Bob")]);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(alice.collection.items[0].id, "3-clubs");
    assert.equal(alice.collection.size, 2);
    assert.equal(service.room.match.turnOrder.get("Bob").collection.size, 1);
});
