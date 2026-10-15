import assert from "node:assert/strict";
import test from "node:test";
import { TurnOrder } from "../../core/TurnOrder.js";
import { Player } from "../../core/Player.js";

test("turn order moves, reverses, and preserves order after removal", () => {
    const turnOrder = new TurnOrder();
    const alice = turnOrder.add(new Player("Alice", { drawAllowance: 1 }));
    const bob = turnOrder.add(new Player("Bob", { drawAllowance: 1 }));
    turnOrder.add(new Player("Casey", { drawAllowance: 1 }));

    assert.equal(turnOrder.ownerKey, null);
    assert.throws(() => turnOrder.requireOwner(), /Turn owner is not assigned/);

    turnOrder.setOwner("Alice");
    assert.equal(turnOrder.ownerKey, alice.key);
    assert.notEqual(turnOrder.ownerKey, bob.key);
    assert.equal(turnOrder.requireOwner(), alice);
    assert.equal(turnOrder.relative(1).name, "Bob");

    turnOrder.move();
    assert.equal(turnOrder.owner.name, "Bob");

    turnOrder.reverse();
    turnOrder.move();
    assert.equal(turnOrder.owner.name, "Alice");

    turnOrder.remove("Alice");
    assert.equal(turnOrder.owner.name, "Casey");
    assert.equal(turnOrder.relative(1).name, "Bob");
    assert.equal(turnOrder.relative(2).name, "Casey");
});
