"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../../shared/Constants.js";
import { Session } from "../../ui/Session.js";

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
    const session = new Session(new URL("https://example.test/room.html"));
    const statuses = [];
    const dataEvents = [];
    session.sortKey = "rank";
    assert.throws(() => {
        session.sortKey = "value";
    }, /Invalid card sort key/);
    session.connect(host, {
        handleConnectionStatus(status) { statuses.push(status); },
        handleData(name, data) { dataEvents.push({ view: name, data }); }
    });

    assert.equal(session.request(Constants.COMMANDS.CREATE, { roomName: "Test" }), true);
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

test("Session validates its Hosted origin before admitting hosted work", () => {
    const session = new Session(new URL("https://example.test/room.html"));
    assert.throws(function emptyOrigin() { session.connect("", null); }, /Hosted origin/);
    assert.throws(function socketOrigin() { session.connect("ws://example.test", null); }, /HTTP\/HTTPS/);
    session.disconnect();
});

test("switching local sessions discards stale requests, responses, and disconnect callbacks", async () => {
    const requests = [];
    let publishOld;
    let closeOld;
    let shutdowns = 0;
    const oldHost = {
        accept(send, disconnect) {
            publishOld = send;
            closeOld = disconnect;
            return { receive(request) { requests.push(["old", request]); }, close() {} };
        },
        shutdown() { shutdowns += 1; }
    };
    const newHost = { accept() {
        return { receive(request) { requests.push(["new", request]); }, close() {} };
    } };
    const responses = [];
    const session = new Session(new URL("https://example.test/room.html"));
    session.connect(oldHost, { handleData(_view, data) { responses.push(data); } });
    session.request("list", {});
    session.connect(newHost, null);
    publishOld({ view: "room", data: { stale: true } });
    closeOld();
    session.request("list", {});
    await Promise.resolve();
    assert.deepEqual(requests.map(function source([name]) { return name; }), ["new"]);
    assert.deepEqual(responses, []);
    assert.equal(shutdowns, 1);
    session.disconnect();
});

test("explicit local disconnect prevents queued work and notifies the controller once", async () => {
    const requests = [];
    let closes = 0;
    const session = new Session(new URL("https://example.test/index.html"));
    session.connect({ accept() {
        return { receive(request) { requests.push(request); }, close() {} };
    } }, { handleClientClose() { closes += 1; } });
    session.request("list", {});
    session.disconnect();
    session.disconnect();
    await Promise.resolve();
    assert.deepEqual(requests, []);
    assert.equal(closes, 1);
});
