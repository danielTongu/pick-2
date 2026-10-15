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
