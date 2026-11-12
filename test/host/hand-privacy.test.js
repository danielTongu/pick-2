import assert from "node:assert/strict";
import test from "node:test";
import { RoomService } from "../../service/RoomService.js";
import { StateMapper } from "../../host/StateMapper.js";

for (const state of ["waiting", "active"]) {
    test(`${state} snapshots expose only the recipient's hand and no spectator hands`, async t => {
        const service = new RoomService("Hand Privacy", 2);
        t.after(() => { service.stopIdleMonitoring(); });
        await service.joinPlayer("Alice");
        await service.joinPlayer("Bob");
        await service.startMatch();
        service.room.match.state = state;
        for (const recipient of ["Alice", "Bob", null, "Unknown"]) {
            const snapshot = StateMapper.toRoomData(service.room, recipient);
            for (const player of snapshot.match.turnOrder.players) {
                assert.equal(player.collection.itemCount, 7);
                if (player.name === recipient) {
                    assert.equal(player.collection.items.length, 7);
                    assert.equal(typeof player.collection.penalty, "number");
                } else {
                    assert.deepEqual(player.collection.items, []);
                    assert.equal(player.collection.penalty, null);
                }
            }
            assert.equal(snapshot.match.collections.draw.items, undefined);
        }
    });
}

test("completed match results reveal hands, and a new match hides them again", async t => {
    const service = new RoomService("Results Privacy", 2);
    t.after(() => { service.stopIdleMonitoring(); });
    await service.joinPlayer("Alice");
    await service.joinPlayer("Bob");
    await service.startMatch();
    service.room.match.state = "finished";
    assert.ok(StateMapper.toRoomData(service.room, null).match.turnOrder.players.every(player => player.collection.items.length === 7));
    await service.startMatch();
    assert.ok(StateMapper.toRoomData(service.room, null).match.turnOrder.players.every(player => player.collection.items.length === 0));
});
