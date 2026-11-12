import assert from "node:assert/strict";
import test from "node:test";
import { Host } from "../../host/Host.js";
import { RoomService } from "../../service/RoomService.js";
import { Card } from "../../model/Card.js";
import { Constants } from "../../shared/Constants.js";
import { createPlayingRoomService } from "../helpers/room-service.js";

test("the next player command resumes a finished room before its waiting transaction", async (t) => {
    const service = await createPlayingRoomService(t, ["Alice", "Bob"]);
    const alice = service.room.match.turnOrder.get("Alice");
    const bob = service.room.match.turnOrder.get("Bob");

    alice.collection.add(new Card("3", "clubs", 0));
    bob.collection.addMany([new Card("4", "diamonds", 0), new Card("6", "hearts", 0)]);
    service.room.match.state = Constants.ROOM_STATE.FINISHED;

    const finishedHands = [alice, bob].map((player) => player.collection.items.map((card) => card.id));

    await service.perform(Constants.COMMANDS.DRAW, "Alice", { sortKey: "none" });

    assert.equal(service.room.match.state, Constants.ROOM_STATE.WAITING);
    assert.equal(service.room.match.turnOrder.ownerKey, null);
    assert.equal(alice.collection.size, finishedHands[0].length + 1);
    assert.deepEqual(alice.collection.items.slice(0, finishedHands[0].length).map((card) => card.id), finishedHands[0]);
    assert.deepEqual(bob.collection.items.map((card) => card.id), finishedHands[1]);

    await service.startMatch();

    assert.equal(service.room.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(alice.collection.size, RoomService.INITIAL_ITEM_COUNT);
    assert.equal(bob.collection.size, RoomService.INITIAL_ITEM_COUNT);
    assert.equal(service.room.match.collections.play.size, 1);
    assert.equal(service.room.match.collections.draw.size, 39);
});


test("Host advances a bot through a draw that retains ownership before passing", async (t) => {
    class ControlledHost extends Host {
        createRoomService(name, limit) {
            this.service = super.createRoomService(name, limit);
            return this.service;
        }
        async runAutomatedTurn(service) {
            if (this.armed) {
                this.actions += 1;
                await service.perform(this.actions === 1 ? "draw" : "pass", service.room.match.turnOrder.owner.name);
            }
        }
    }
    const host = new ControlledHost("direct", "fill", false);
    t.after(function cleanup() { return host.shutdown(); });
    const connection = host.accept(function receive() {}, function disconnect() {});
    await connection.receive({ command: "create", data: { tabId: "bot-progress", roomName: "Progress Room", playerName: "Alice", playerLimit: 2 } });
    await connection.receive({ command: "start", data: { tabId: "bot-progress" } });
    const service = host.service;
    service.room.match.turnOrder.setOwner("Alice");
    service.room.match.collections.play.items = [new Card("9", "hearts")];
    service.room.match.collections.draw.items = [new Card("2", "diamonds")];
    service.room.match.turnOrder.get("Alice").collection.items = [new Card("5", "hearts"), new Card("3", "clubs")];
    const bot = service.room.match.turnOrder.get("CM");
    bot.collection.items = [new Card("6", "spades")];
    host.armed = true;
    host.actions = 0;
    await connection.receive({ command: "discard", data: { tabId: "bot-progress", card: { value: "5", suit: "hearts" } } });
    assert.equal(host.actions, 2);
    assert.equal(bot.collection.size, 2);
    assert.equal(service.room.match.turnOrder.owner.name, "Alice");
});
