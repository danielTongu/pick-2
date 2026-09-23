"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { CommandContext, CommandRouter, HostRequest } from "../runtime/Command.js";
import { Endpoint, EndpointEvents } from "../runtime/Transport.js";
import { PeerChannel } from "../runtime/Transport.js";
import { PeerSession, RoomSession } from "../runtime/Session.js";
import { SessionRegistry } from "../runtime/Session.js";
import { RoomLifecycle } from "../runtime/RoomLifecycle.js";
import { WebSocketEndpoint } from "../runtime/Transport.js";

test("HostRequest validates one canonical command shape", () => {
    const request = HostRequest.parse({ command: "join", data: { tabId: "tab-1" } });

    assert.equal(request.command, "join");
    assert.deepEqual(request.data, { tabId: "tab-1" });
    assert.throws(() => HostRequest.parse(null), /Request/);
    assert.throws(() => HostRequest.parse({ command: "" }), /Command/);
});

test("CommandContext accumulates typed authentication and room state", () => {
    const channel = new PeerChannel(() => {}, () => {});
    const peer = new PeerSession("peer-1", channel);
    const request = HostRequest.parse({ command: "start", data: { tabId: "tab-1" } });
    const session = new RoomSession("tab-1", peer, "test-room", "Daniel");
    const room = { name: "Test Room" };
    const context = new CommandContext(peer, request)
        .identifyTab()
        .attachSession(session)
        .attachRoom("test-room", room);

    assert.equal(context.request.command, "start");
    assert.equal(context.tabId, "tab-1");
    assert.equal(context.session, session);
    assert.equal(context.room, room);
    assert.equal(context.session.playerName, "Daniel");
});

test("PeerSession owns transport state and RoomSession owns membership state", () => {
    const published = [];
    const terminated = [];
    const channel = new PeerChannel(
        (response) => published.push(response),
        (code, reason) => terminated.push({ code, reason })
    );
    const peer = new PeerSession("peer-1", channel);
    const session = new RoomSession("tab-1", peer, "test-room", null);

    peer.authenticate("tab-1");
    peer.publish({ view: "home" });
    session.join("Daniel");

    assert.equal(peer.tabId, "tab-1");
    assert.deepEqual(published, [{ view: "home" }]);
    assert.notEqual(session.playerName, null);
    assert.equal(session.roomKey, "test-room");
    assert.equal(session.playerName, "Daniel");

    session.view();
    peer.markClosed();
    peer.publish({ view: "room" });
    peer.terminate(1001, "Done");
    peer.clearAuthentication("tab-1");

    assert.equal(session.playerName, null);
    assert.equal(peer.isOpen, false);
    assert.equal(peer.tabId, null);
    assert.deepEqual(published, [{ view: "home" }]);
    assert.deepEqual(terminated, [{ code: 1001, reason: "Done" }]);
});

test("SessionRegistry owns Home subscriptions and room membership indexes", () => {
    const registry = new SessionRegistry();
    const channel = new PeerChannel(() => {}, () => {});
    const peer = registry.createPeer(channel);

    registry.subscribeHome(peer);
    const session = registry.register("tab-1", peer, "test-room", null);

    assert.deepEqual(registry.homePeers(), []);
    assert.equal(registry.get("tab-1"), session);
    assert.deepEqual(registry.inRoom("test-room"), [session]);
    assert.equal(registry.findPeer(peer), session);

    session.join("Daniel");
    assert.equal(registry.findPlayer("test-room", "Daniel"), session);
    assert.equal(registry.isCurrent(session), true);

    assert.equal(registry.unregister("tab-1", peer), session);
    assert.equal(registry.get("tab-1"), null);
    assert.deepEqual(registry.inRoom("test-room"), []);
});

test("CommandRouter owns built-in and fallback command dispatch", async () => {
    const received = [];
    const receiver = { name: "host" };
    const builtIn = function builtIn(context) {
        received.push([this.name, context.request.command]);
    };
    const fallback = function fallback(context) {
        received.push(["fallback", context.request.command]);
    };
    const router = new CommandRouter({ list: builtIn }, fallback);

    await router.dispatch(receiver, { request: { command: "list" } });
    await router.dispatch(receiver, { request: { command: "draw" } });

    assert.deepEqual(received, [
        ["host", "list"],
        ["fallback", "draw"]
    ]);
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

test("mechanism-specific infrastructure extends the default APIs", () => {
    assert.equal(new WebSocketEndpoint("ws://example.test") instanceof Endpoint, true);
});

test("direct and WebSocket connections share explicit close behavior", async (t) => {
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

    const events = new EndpointEvents(
        () => {},
        (status, label) => statuses.push({ status, label }),
        () => {},
        () => {
            closes += 1;
        }
    );
    const direct = new Endpoint({
        accept() {
            return {
                receive(request) {
                    directRequests.push(request);
                },
                close() {}
            };
        }
    }).open(events);

    direct.request({ command: "list", data: {} });
    direct.close();
    await Promise.resolve();

    const network = new WebSocketEndpoint("ws://example.test").open(events);
    network.close(1000, "Done");

    assert.deepEqual(directRequests, []);
    assert.equal(closes, 2);
    assert.deepEqual(statuses.filter((entry) => entry.status === "disconnected"), [
        { status: "disconnected", label: "Closed" },
        { status: "disconnected", label: "Closed" }
    ]);
});
