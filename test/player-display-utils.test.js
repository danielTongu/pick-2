"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { PlayerDisplayUtils } from "../src/ui/PlayerDisplayUtils.js";

test("player display starts with the local player and preserves circle order", () => {
    const players = [
        {name: "Alice"},
        {name: "Bob"},
        {name: "Casey"},
        {name: "Daniel"}
    ];

    assert.deepEqual(
        PlayerDisplayUtils.localFirst(players, "Casey").map((player) => player.name),
        ["Casey", "Daniel", "Alice", "Bob"]
    );
    assert.deepEqual(players.map((player) => player.name), ["Alice", "Bob", "Casey", "Daniel"]);
});

test("player display keeps supplied order when there is no local player", () => {
    const players = [{name: "Alice"}, {name: "Bob"}];

    assert.deepEqual(PlayerDisplayUtils.localFirst(players, null), players);
    assert.deepEqual(PlayerDisplayUtils.localFirst(players, "Unknown"), players);
    assert.deepEqual(PlayerDisplayUtils.localFirst(null, "Alice"), []);
});
