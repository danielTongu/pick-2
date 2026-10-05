import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";

test("final knockout results open once despite later actor roster updates", () => {
    const source = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const start = source.indexOf("    render(room) {");
    const end = source.indexOf("    /**", start);
    const method = source.slice(start, end).replaceAll("#", "_");
    const region = { dataset: {} };
    const Controller = new Function("Constants", "ValidationUtils", "DomUtils", "HTMLElement", `return class RoomController {
        static _getLocalActor(room) { return room.match.turnOrder.actors.find(actor => actor.name === room.localActorName) ?? null; }
        ${method}
    }`)(Constants, ValidationUtils, { require() { return region; } }, class {});
    const controller = new Controller();
    const shown = [];
    let hidden = 0;
    controller._previousState = "active";
    controller._playDialog = null;
    controller._resultsController = { show(room) { shown.push(room); }, hide() { hidden++; } };
    controller._suitController = { show() {}, hide() {} };
    controller._countdownController = { show() {} };
    for (const name of ["_renderRoom", "_renderActors", "_renderDiscardPile", "_renderLocalActor"]) controller[name] = () => {};
    const finalists = {
        localActorName: "Alice", connectionMode: "direct",
        match: { state: "finished", pending: null, isKnockout: true, isKnockoutComplete: true,
            turnOrder: { actors: [{ key: "alice", name: "Alice", state: "won" }, { key: "bob", name: "Bob", state: "lost" }] } }
    };
    controller.render(finalists);
    assert.deepEqual(shown, [finalists]);
    const reseated = structuredClone(finalists);
    reseated.match.turnOrder.actors.push({ key: "bot", name: "Bot", state: "ready" });
    controller.render(reseated);
    controller.render(reseated);
    assert.equal(shown.length, 1);
    assert.equal(hidden, 0);
    controller.render({ ...reseated, match: { ...reseated.match, state: "waiting" } });
    assert.equal(hidden, 1);
    controller.render(finalists);
    assert.equal(shown.length, 2);
});
