import assert from "node:assert/strict";
import test from "node:test";
import { Player } from "../../core/Player.js";

test("player names produce stable keys", () => {
    assert.equal(Player.normalizeKey("  Ada Lovelace!  "), "ada-lovelace");
    assert.throws(() => new Player("   ", { drawAllowance: 1 }), /cannot be empty/);
});
