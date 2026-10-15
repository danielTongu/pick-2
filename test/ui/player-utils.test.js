import assert from "node:assert/strict";
import test from "node:test";
import { PlayerUtils } from "../../ui/utilities/PlayerUtils.js";

test("player display ordering starts locally without changing authoritative turn order", () => {
    const players = [{ name: "Alice" }, { name: "Bob" }, { name: "Casey" }, { name: "Daniel" }];
    assert.deepEqual(PlayerUtils.localFirst(players, "Casey").map(player => player.name), ["Casey", "Daniel", "Alice", "Bob"]);
    assert.deepEqual(players.map(player => player.name), ["Alice", "Bob", "Casey", "Daniel"]);
    assert.deepEqual(PlayerUtils.localFirst(players, null), players);
    assert.deepEqual(PlayerUtils.localFirst(players, "Unknown"), players);
    assert.deepEqual(PlayerUtils.localFirst(null, "Alice"), []);
});

test("Room renders hidden opponents using public item counts", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const start = source.indexOf("    #renderPlayers(room) {");
    const end = source.indexOf("\n    }", start) + "\n    }".length;
    const method = source.slice(start, end).replace("#renderPlayers", "renderPlayers");
    const rendered = [];
    const container = { children: [], insertBefore() {} };
    const utilities = {
        localFirst: PlayerUtils.localFirst,
        create(data) { rendered.push(data); return { dataset: {}, parentElement: null, nextElementSibling: null }; },
        updateElement() {}
    };
    const Controller = new Function("PlayerUtils", "DomUtils", "HTMLUListElement", `return class RoomController {
        static #getPlayers(room) { return room.match.turnOrder.players; }
        ${method}
    }`)(utilities, { require() { return container; } }, class {});
    new Controller().renderPlayers({ localPlayerName: "Alice", match: { turnOrder: { players: [
        { key: "bob", name: "Bob", collection: { itemCount: 7, items: [] } }
    ] } } });
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].itemCount, 7);
});
