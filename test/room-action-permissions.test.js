import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Constants } from "../core/Constants.js";

test("room button actions check current membership, turn, pending action, and restart permission", () => {
    const source = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const start = source.indexOf("    #canSubmitActorCommand(command) {");
    const end = source.indexOf("    /** Submits the Knockout choice", start);
    const method = source.slice(start, end).replace("#canSubmitActorCommand", "canSubmitActorCommand");
    const Controller = new Function("Constants", `return class RoomController {
        static #getLocalActor(room) { return room?.actor ?? null; }
        ${method}
    }`)(Constants);
    const controller = new Controller();
    controller.capabilities = { restart: false };
    const actor = { key: "alice", drawAllowance: 1 };
    const match = { state: "active", pending: null, turnOrder: { ownerKey: "alice", actorCount: 2 } };
    controller.room = { actor, match };
    const allowed = command => controller.canSubmitActorCommand(command);
    assert.equal(allowed("draw"), true);
    assert.equal(allowed("pass"), true);
    match.turnOrder.ownerKey = "bob";
    assert.equal(allowed("draw"), false);
    assert.equal(allowed("pass"), false);
    match.turnOrder.ownerKey = "alice";
    actor.drawAllowance = 0;
    assert.equal(allowed("draw"), false);
    match.state = "waiting";
    assert.equal(allowed("draw"), true);
    assert.equal(allowed("start"), true);
    match.pending = { command: "start" };
    for (const command of ["draw", "pass", "start"]) assert.equal(allowed(command), false);
    match.pending = null;
    match.state = "finished";
    assert.equal(allowed("start"), false);
    controller.capabilities.restart = true;
    assert.equal(allowed("start"), true);
    match.isKnockout = true;
    match.isKnockoutComplete = false;
    match.nextMatchAvailable = false;
    assert.equal(allowed("start"), false);
    match.nextMatchAvailable = true;
    assert.equal(allowed("start"), true);
    match.turnOrder.actorCount = 1;
    assert.equal(allowed("start"), false);
    controller.room.actor = null;
    for (const command of ["draw", "pass", "start"]) assert.equal(allowed(command), false);
    controller.room = null;
    assert.equal(allowed("start"), false);
});
