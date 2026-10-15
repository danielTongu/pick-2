import assert from "node:assert/strict";
import test from "node:test";
import { Host } from "../../host/Host.js";
import { Room } from "../../core/Room.js";
import { Card } from "../../core/Card.js";
import { Constants } from "../../core/Constants.js";
import { createPlayingRoom } from "../helpers/room.js";

test("the next player command resumes a finished room before its waiting transaction", async (t) => {
    const room = await createPlayingRoom(t, ["Alice", "Bob"]);
    const host = new Host("direct", 0, false);
    t.after(() => host.shutdown());
    const alice = room.match.turnOrder.get("Alice");
    const bob = room.match.turnOrder.get("Bob");

    alice.collection.add(new Card("3", "clubs", 0));
    bob.collection.addMany([new Card("4", "diamonds", 0), new Card("6", "hearts", 0)]);
    room.match.state = Constants.ROOM_STATE.FINISHED;

    const finishedHands = [alice, bob].map((player) => player.collection.items.map((card) => card.id));

    await host.executeMatchCommand(room, "Alice", Constants.COMMANDS.DRAW, { sortKey: "none" });

    assert.equal(room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(room.match.turnOrder.ownerKey, null);
    assert.equal(alice.collection.size, finishedHands[0].length + 1);
    assert.deepEqual(alice.collection.items.slice(0, finishedHands[0].length).map((card) => card.id), finishedHands[0]);
    assert.deepEqual(bob.collection.items.map((card) => card.id), finishedHands[1]);

    await room.startMatch();

    assert.equal(room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(alice.collection.size, Room.INITIAL_ITEM_COUNT);
    assert.equal(bob.collection.size, Room.INITIAL_ITEM_COUNT);
    assert.equal(room.match.collections.play.size, 1);
    assert.equal(room.match.collections.draw.size, 39);
});

