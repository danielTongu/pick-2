import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { Constants } from "../../core/Constants.js";

test("room button actions check current membership, turn, pending action, and restart permission", () => {
    const source = readFileSync(new URL("../../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const start = source.indexOf("    #canSubmitPlayerCommand(command) {");
    const end = source.indexOf("    /** Submits the Knockout choice", start);
    const method = source.slice(start, end).replace("#canSubmitPlayerCommand", "canSubmitPlayerCommand");
    const Controller = new Function("Constants", `return class RoomController {
        static #getLocalPlayer(room) { return room?.player ?? null; }
        ${method}
    }`)(Constants);
    const controller = new Controller();
    controller.capabilities = { restart: false };
    const player = { key: "alice", drawAllowance: 1 };
    const match = { state: "active", pending: null, turnOrder: { ownerKey: "alice", playerCount: 2 } };
    controller.room = { player, match };
    const allowed = command => controller.canSubmitPlayerCommand(command);
    assert.equal(allowed("draw"), true);
    assert.equal(allowed("pass"), true);
    match.turnOrder.ownerKey = "bob";
    assert.equal(allowed("draw"), false);
    assert.equal(allowed("pass"), false);
    match.turnOrder.ownerKey = "alice";
    player.drawAllowance = 0;
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
    match.turnOrder.playerCount = 1;
    assert.equal(allowed("start"), false);
    controller.room.player = null;
    for (const command of ["draw", "pass", "start"]) assert.equal(allowed(command), false);
    controller.room = null;
    assert.equal(allowed("start"), false);
});

test("Room leave ignores repeat submissions and allows retry after a rejected request", () => {
    const source = readFileSync(new URL("../../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const start = source.indexOf("    #leave(event) {");
    const end = source.indexOf("\n    }", start) + "\n    }".length;
    const method = source.slice(start, end).replace("#leave(event)", "leave(event)");
    const Controller = new Function("Constants", `return class {
        #isLeaving = false;
        #homeHandler;
        constructor(view, home) { this.view = view; this.#homeHandler = home; }
        ${method}
    }`)(Constants);
    let requests = 0;
    let navigations = 0;
    const controller = new Controller({ request() { return ++requests > 1; } }, () => navigations++);
    const event = { preventDefault() {} };
    controller.leave(event);
    controller.leave(event);
    controller.leave(event);
    assert.equal(requests, 2);
    assert.equal(navigations, 1);
});
