import assert from "node:assert/strict";
import test from "node:test";

import { BotService } from "../../service/BotService.js";
import { RoomService } from "../../service/RoomService.js";
import { Constants } from "../../shared/Constants.js";
import { Card } from "../../model/Card.js";

/** Creates controlled real models and delayed automation with owned cleanup. */
async function scenario(t, knockout = false) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const service = new RoomService("Automation Room", 3);
    t.after(function cleanup() { service.dispose(); });
    const robot = await service.joinPlayer("Robot", true);
    const alice = await service.joinPlayer("Alice");
    const bob = await service.joinPlayer("Bob");
    await service.startMatch(knockout);
    service.room.match.turnOrder.setOwner(robot.key);
    service.room.match.collections.play.items = [new Card("5", "hearts")];
    robot.collection.items = [new Card("5", "clubs"), new Card("6", "diamonds")];
    alice.collection.items = [new Card("3", "clubs")];
    bob.collection.items = [new Card("q", "clubs")];
    const bots = new BotService();
    bots.DELAY_MIN_MS = 1000;
    bots.DELAY_MAX_MS = 1000;
    return { service, robot, bots };
}

test("disposing a room cancels bot delays and rejects already queued and future commands", async (t) => {
    const { service, robot, bots } = await scenario(t);
    const hand = robot.collection.toJSON();
    const delayed = bots.takeTurn(robot, service);
    const queued = service.drawItems("Robot");
    service.dispose();
    await delayed;
    await assert.rejects(queued, /Room is closed/);
    await assert.rejects(service.startMatch(), /Room is closed/);
    assert.deepEqual(robot.collection.toJSON(), hand);
    assert.equal(service.isDisposed, true);
});

for (const knockout of [false, true]) {
    test(`starting another ${knockout ? "Knockout round" : "match"} cancels the earlier bot action`, async (t) => {
        const { service, robot, bots } = await scenario(t, knockout);
        const previousMatch = service.room.match;
        const previousSignal = service.automationSignal;
        const delayed = bots.takeTurn(robot, service);
        service.room.match.finishMatch();
        await service.startMatch(knockout ? null : false);
        service.room.match.turnOrder.setOwner(robot.key);
        const freshState = JSON.stringify(service.room.toJSON());
        await delayed;
        t.mock.timers.tick(5000);
        assert.equal(JSON.stringify(service.room.toJSON()), freshState);
        assert.equal(previousSignal.aborted, true);
        assert.notEqual(service.automationSignal, previousSignal);
        if (knockout) assert.equal(service.room.match, previousMatch, "generation must change even when Match is reused");
    });
}

test("the mutation queue rejects a bot decision belonging to a replaced match generation", async (t) => {
    const { service, robot } = await scenario(t);
    const oldSignal = service.automationSignal;
    service.room.match.state = Constants.ROOM_STATE.FINISHED;
    const restart = service.startMatch();
    const obsolete = service.performBotCommand(robot, oldSignal, "discard", { card: { value: "5", suit: "clubs" } });
    await restart;
    const freshState = JSON.stringify(service.room.toJSON());
    await obsolete;
    assert.equal(JSON.stringify(service.room.toJSON()), freshState);
});

test("a bot decision cannot control a replacement player with the same key", async (t) => {
    const { service, robot } = await scenario(t);
    service.room.match.state = Constants.ROOM_STATE.WAITING;
    await service.removePlayer(robot.key);
    const replacement = await service.joinPlayer("Robot", true);
    service.room.match.state = Constants.ROOM_STATE.ACTIVE;
    service.room.match.turnOrder.setOwner(replacement.key);
    const freshState = JSON.stringify(service.room.toJSON());
    await service.performBotCommand(robot, service.automationSignal, "draw", {});
    assert.equal(JSON.stringify(service.room.toJSON()), freshState);
});

test("duplicate delayed decisions cannot act twice when drawing keeps the same turn owner", async (t) => {
    const { service, robot } = await scenario(t);
    const revision = service.revision;
    const signal = service.automationSignal;
    const count = robot.collection.size;
    await Promise.all([
        service.performBotCommand(robot, signal, "draw", {}, revision),
        service.performBotCommand(robot, signal, "draw", {}, revision)
    ]);
    assert.equal(robot.collection.size, count + 1);
    assert.equal(service.room.match.turnOrder.owner, robot);
});
