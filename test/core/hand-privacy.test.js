import assert from "node:assert/strict";
import test from "node:test";
import { Room } from "../../core/Room.js";
import { StateMapper } from "../../core/StateMapper.js";

for (const state of ["waiting", "active"]) {
    test(`${state} snapshots expose only the recipient's hand and no spectator hands`, async t => {
        const room = new Room("Hand Privacy", 2);
        t.after(() => { for (const player of room.match.turnOrder) player.stopIdleMonitoring(); });
        await room.joinPlayer("Alice");
        await room.joinPlayer("Bob");
        await room.startMatch();
        room.match.state = state;
        for (const recipient of ["Alice", "Bob", null, "Unknown"]) {
            const snapshot = StateMapper.toRoomData(room, recipient);
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
    const room = new Room("Results Privacy", 2);
    t.after(() => { for (const player of room.match.turnOrder) player.stopIdleMonitoring(); });
    await room.joinPlayer("Alice");
    await room.joinPlayer("Bob");
    await room.startMatch();
    room.match.state = "finished";
    assert.ok(StateMapper.toRoomData(room, null).match.turnOrder.players.every(player => player.collection.items.length === 7));
    await room.startMatch();
    assert.ok(StateMapper.toRoomData(room, null).match.turnOrder.players.every(player => player.collection.items.length === 0));
});
