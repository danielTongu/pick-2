"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../../core/Constants.js";
import { Session } from "../../ui/Session.js";
import { Host } from "../../host/Host.js";

test("Session adds shared fields to every local Host request", async () => {
    let publish;
    let request;
    const host = {
        accept(send) {
            publish = send;
            return {
                receive(nextRequest) { request = nextRequest; },
                close() {}
            };
        }
    };
    const view = new Session(new URL("https://example.test/room.html"));
    const statuses = [];
    const dataEvents = [];
    view.sortKey = "rank";
    assert.throws(() => {
        view.sortKey = "value";
    }, /Invalid card sort key/);
    view.connect(host, {
        handleConnectionStatus(status) { statuses.push(status); },
        handleData(name, data) { dataEvents.push({ view: name, data }); }
    });

    assert.equal(view.request(Constants.COMMANDS.CREATE, { roomName: "Test" }), true);
    await Promise.resolve();
    assert.equal(request.command, Constants.COMMANDS.CREATE);
    assert.equal(request.data.roomName, "Test");
    assert.equal(request.data.sortKey, "rank");
    assert.equal(typeof request.data.tabId, "string");

    publish({ view: Constants.VIEWS.ROOM, message: null, data: { version: 2 } });
    await Promise.resolve();
    assert.deepEqual(statuses, ["connecting", "connected"]);
    assert.deepEqual(dataEvents, [{ view: Constants.VIEWS.ROOM, data: { version: 2 } }]);
});

test("Session switches local and hosted connections without replaying old local work", async (t) => {
    const originalWebSocket = globalThis.WebSocket;
    const sent = [];
    class FakeWebSocket {
        static OPEN = 1;
        constructor() { this.readyState = FakeWebSocket.OPEN; }
        addEventListener() {}
        send(message) { sent.push(JSON.parse(message)); }
        close() { this.readyState = 3; }
    }
    globalThis.WebSocket = FakeWebSocket;
    t.after(() => {
        if (originalWebSocket === undefined) delete globalThis.WebSocket;
        else globalThis.WebSocket = originalWebSocket;
    });

    const localRequests = [];
    let oldHostShutdowns = 0;
    let publishOld;
    let disconnectOld;
    const oldHost = { accept(send, disconnect) {
        publishOld = send;
        disconnectOld = disconnect;
        return { receive(request) { localRequests.push(["old", request]); }, close() {} };
    }, shutdown() { oldHostShutdowns += 1; } };
    const newHost = { accept() {
        return { receive(request) { localRequests.push(["new", request]); }, close() {} };
    } };
    const received = [];
    const view = new Session(new URL("https://example.test/room.html"));
    view.sortKey = "rank";
    view.connect(oldHost, { handleData(_name, data) { received.push(data); } });
    view.request("list", {});
    view.connect("ws://example.test", null);
    assert.equal(oldHostShutdowns, 1);
    publishOld({ view: Constants.VIEWS.ROOM, data: { stale: true } });
    disconnectOld();
    await Promise.resolve();
    assert.deepEqual(localRequests, []);
    assert.deepEqual(received, []);

    assert.equal(view.request("list", {}), true);
    assert.equal(sent[0].data.sortKey, "rank");
    view.connect(newHost, null);
    view.request("list", {});
    await Promise.resolve();
    assert.deepEqual(localRequests.map(([source]) => source), ["new"]);
    view.disconnect();
});

test("Session validates its hosted URL", () => {
    const view = new Session(new URL("https://example.test/room.html"));
    assert.throws(() => view.connect("", null), /WebSocket URL/);
});

test("local and hosted Session connections close explicitly", async (t) => {
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

    const direct = new Session(new URL("https://example.test/room.html"));
    direct.connect({
        accept() {
            return {
                receive(request) {
                    directRequests.push(request);
                },
                close() {}
            };
        }
    }, { handleConnectionStatus(status, label) { statuses.push({ status, label }); } });

    direct.request("list", {});
    direct.disconnect();
    await Promise.resolve();

    const hosted = new Session(new URL("https://example.test/room.html"));
    hosted.connect("ws://example.test", {
        handleClientClose() { closes += 1; },
        handleConnectionStatus(status, label) { statuses.push({ status, label }); }
    });
    hosted.disconnect();

    assert.deepEqual(directRequests, []);
    assert.equal(closes, 1);
    assert.deepEqual(statuses.filter((entry) => entry.status === "disconnected"), [
        { status: "disconnected", label: "Closed" },
        { status: "disconnected", label: "Closed" }
    ]);
});
