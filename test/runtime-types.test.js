"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { HostRequestContext } from "../host/HostRequestContext.js";
import { HostRequest } from "../host/HostRequest.js";
import { View } from "../ui/View.js";
import { HostConnection } from "../host/HostConnection.js";
import { RoomMembership } from "../host/RoomMembership.js";
import { ConnectionRegistry } from "../host/ConnectionRegistry.js";
import { RoomLifecycle } from "../host/RoomLifecycle.js";

test("HostRequest validates one canonical command shape", () => {
    const request = HostRequest.parse({ command: "join", data: { tabId: "tab-1" } });

    assert.equal(request.command, "join");
    assert.deepEqual(request.data, { tabId: "tab-1" });
    assert.throws(() => HostRequest.parse(null), /Request/);
    assert.throws(() => HostRequest.parse({ command: "" }), /Command/);
});

test("HostRequestContext accumulates typed authentication and room state", () => {
    const connection = new HostConnection("connection-1", () => {}, () => {}, async function receive() {}, async function close() {});
    const request = HostRequest.parse({ command: "start", data: { tabId: "tab-1" } });
    const membership = new RoomMembership("tab-1", connection, "test-room", "Daniel");
    const room = { name: "Test Room" };
    const context = new HostRequestContext(connection, request)
        .identifyTab()
        .attachMembership(membership)
        .attachRoom("test-room", room);

    assert.equal(context.request.command, "start");
    assert.equal(context.tabId, "tab-1");
    assert.equal(context.membership, membership);
    assert.equal(context.room, room);
    assert.equal(context.membership.actorName, "Daniel");
});

test("HostConnection owns transport state and RoomMembership owns membership state", () => {
    const published = [];
    const terminated = [];
    const connection = new HostConnection("connection-1",
        (response) => published.push(response),
        (code, reason) => terminated.push({ code, reason }),
        async function receive() {}, async function close() {});
    const membership = new RoomMembership("tab-1", connection, "test-room", null);

    connection.authenticate("tab-1");
    connection.publish({ view: "home" });
    membership.join("Daniel");

    assert.equal(connection.tabId, "tab-1");
    assert.deepEqual(published, [{ view: "home" }]);
    assert.notEqual(membership.actorName, null);
    assert.equal(membership.roomKey, "test-room");
    assert.equal(membership.actorName, "Daniel");

    membership.view();
    connection.markClosed();
    connection.publish({ view: "room" });
    connection.terminate(1001, "Done");
    connection.clearAuthentication("tab-1");

    assert.equal(membership.actorName, null);
    assert.equal(connection.isOpen, false);
    assert.equal(connection.tabId, null);
    assert.deepEqual(published, [{ view: "home" }]);
    assert.deepEqual(terminated, [{ code: 1001, reason: "Done" }]);
});

test("ConnectionRegistry owns Home subscriptions and room membership indexes", () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(() => {}, () => {}, async function receive() {}, async function close() {});

    registry.subscribeHome(connection);
    const membership = registry.register("tab-1", connection, "test-room", null);

    assert.deepEqual(registry.homeConnections(), []);
    assert.equal(registry.get("tab-1"), membership);
    assert.deepEqual(registry.inRoom("test-room"), [membership]);
    assert.equal(registry.findConnection(connection), membership);

    membership.join("Daniel");
    assert.equal(registry.findActor("test-room", "Daniel"), membership);
    assert.equal(registry.isCurrent(membership), true);

    assert.equal(registry.unregister("tab-1", connection), membership);
    assert.equal(registry.get("tab-1"), null);
    assert.deepEqual(registry.inRoom("test-room"), []);
});

test("one HostConnection handles transport requests and owns room membership", async () => {
    const received = [];
    const closed = [];
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(function send() {}, function disconnect() {},
        async function receive(current, request) { received.push([current, request]); },
        async function close(current) { closed.push(current); });
    const membership = registry.register("tab-1", connection, "test-room", "Alice");

    await connection.receive({ command: "draw" });
    await connection.close();

    assert.equal(membership.connection, connection);
    assert.deepEqual(received, [[connection, { command: "draw" }]]);
    assert.deepEqual(closed, [connection]);
});

test("RoomLifecycle replaces, cancels, and clears pending room work", () => {
    const lifecycle = new RoomLifecycle();

    lifecycle.schedule("room-one", 60_000, () => {});
    assert.equal(lifecycle.hasPending("room-one"), true);
    lifecycle.cancel("room-one");
    assert.equal(lifecycle.hasPending("room-one"), false);

    lifecycle.schedule("room-two", 60_000, () => {});
    lifecycle.clear();
    assert.equal(lifecycle.hasPending("room-two"), false);
});

test("View validates its hosted URL", () => {
    const view = new View(new URL("https://example.test/room.html"));
    assert.throws(() => view.connect("", null), /WebSocket URL/);
});

test("local and hosted View connections close explicitly", async (t) => {
    const originalWebSocket = globalThis.WebSocket;
    const directRequests = [];
    const statuses = [];
    let closes = 0;

    class FakeWebSocket {
        static OPEN = 1;

        constructor() {
            this.readyState = 0;
            this.closeCalls = [];
        }

        addEventListener() {}

        close(code, reason) {
            this.closeCalls.push({ code, reason });
        }
    }

    globalThis.WebSocket = FakeWebSocket;
    t.after(() => {
        if (originalWebSocket === undefined) delete globalThis.WebSocket;
        else globalThis.WebSocket = originalWebSocket;
    });

    const direct = new View(new URL("https://example.test/room.html"));
    direct.connect({
        accept() {
            return {
                receive(request) {
                    directRequests.push(request);
                },
                close() {}
            };
        }
    }, null, (status, label) => statuses.push({ status, label }));

    direct.request("list", {});
    direct.disconnect();
    await Promise.resolve();

    const hosted = new View(new URL("https://example.test/room.html"));
    hosted.connect("ws://example.test", {handleClientClose() { closes += 1; }},
        (status, label) => statuses.push({ status, label }));
    hosted.disconnect();

    assert.deepEqual(directRequests, []);
    assert.equal(closes, 1);
    assert.deepEqual(statuses.filter((entry) => entry.status === "disconnected"), [
        { status: "disconnected", label: "Closed" },
        { status: "disconnected", label: "Closed" }
    ]);
});
