"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { UserNotification } from "../../core/UserNotification.js";
import { RequestThrottle } from "../../host/RequestThrottle.js";

test("RequestThrottle isolates scopes and supports reset, pruning, and validation", () => {
    const guard = new RequestThrottle();

    guard.enforceConnection({ tabId: " tab " }, "sync", 1000);
    assert.throws(() => guard.enforceConnection({ tabId: "tab" }, "sync", 1000), UserNotification);

    guard.reset("connection:tab");
    guard.enforceConnection({ tabId: "tab" }, "sync", 1000);
    guard.enforcePlayerThrottle("player-tab", "move", 0);
    guard.enforceRoomThrottle("room-key", "start", 0);
    guard.prune(0);
    guard.resetAll();

    assert.throws(() => guard.enforcePlayerThrottle("", "move", 1), /cannot be empty/);
    assert.throws(() => guard.enforceRoomThrottle("room", "move", -1), /non-negative integer/);
});
