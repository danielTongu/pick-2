import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";

import { HostedClient } from "../../ui/HostedClient.js";
import { HostedProtocol } from "../../shared/HostedProtocol.js";
import { HostedGateway } from "../../server/HostedGateway.js";
import { Host } from "../../host/Host.js";
import { installLiveSockets } from "../helpers/live-socket.js";

const TOKEN = "a".repeat(43);

/** Creates observable transport callbacks without a browser DOM. */
function clientState() {
    const state = { responses: [], statuses: [], opens: 0, closes: 0, exhausted: 0 };
    state.client = new HostedClient("https://api.example.test", {
        status(status) { state.statuses.push(status); },
        response(response) { state.responses.push(response); },
        open() { state.opens += 1; },
        close() { state.closes += 1; },
        exhausted() { state.exhausted += 1; }
    });
    return state;
}

/** Wires real Hosted sessions over browser-style sockets, without any HTTP API. */
function harness(t) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = new Host("hosted", 0, false);
    const gateway = new HostedGateway(host, { allowedOrigins: ["https://frontend.example.test"] });
    const network = installLiveSockets(t, gateway);
    const clients = [];
    t.mock.method(globalThis, "fetch", function unexpectedHttp() { throw new Error("Hosted commands must not use HTTP"); });
    t.after(async function cleanup() {
        for (const state of clients) state.client.stop();
        await gateway.close();
        await host.shutdown();
    });
    return { gateway, network,
        async client() {
            const state = clientState();
            clients.push(state);
            state.client.start();
            await settle();
            return state;
        }
    };
}

/** Minimal session authority for transport failure tests. */
function readyGateway() {
    return { createStream(_address, send) {
        send({ type: "ready", service: "pick-2", version: 2, token: TOKEN });
        return { stream: { receive() {}, acknowledge() {}, close() {}, release() {} } };
    } };
}

test("one explicit WebSocket command set includes admission and gameplay", () => {
    assert.deepEqual(HostedProtocol.COMMANDS, ["list", "create", "view", "join", "leave", "start", "draw", "pass", "discard", "declare"]);
    assert.equal(HostedProtocol.PATH, "/live");
});

test("WebSocket admission and gameplay push shared private snapshots without polling", async (t) => {
    const api = harness(t);
    const alice = await api.client();
    const bob = await api.client();
    const viewer = await api.client();
    alice.client.request("create", { roomName: "Live Room", playerName: "Alice", playerLimit: 2 });
    await settle();
    bob.client.request("join", { roomName: "Live Room", playerName: "Bob" });
    await settle();
    viewer.client.request("view", { roomName: "Live Room" });
    await settle();
    alice.client.request("start", { roomName: "Live Room", knockout: false });
    await settle();
    for (const [state, name] of [[alice, "Alice"], [bob, "Bob"], [viewer, null]]) {
        const snapshot = state.responses.findLast(item => item.view === "room").data;
        assert.equal(snapshot.localPlayerName, name);
        assert.equal(snapshot.match.state, "active");
        for (const player of snapshot.match.turnOrder.players) assert.equal(player.collection.items.length, player.name === name ? 7 : 0);
        assert.equal(state.opens, 1);
    }
    assert.ok(api.network.frames.some(frame => frame.command === "start"));
    assert.ok(api.network.sockets.every(socket => socket.url === "wss://api.example.test/live"));
    const requests = api.network.frames.length;
    t.mock.timers.tick(30000);
    await settle();
    assert.equal(api.network.frames.length, requests, "idle live sessions must not poll");
});

test("socket recovery replays missed room changes without recreating credentials or admission", async (t) => {
    const api = harness(t);
    const alice = await api.client();
    alice.client.request("create", { roomName: "Replay Room", playerName: "Alice", playerLimit: 2 });
    await settle();
    api.network.sockets[0].close(1006);
    await settle();
    const bob = await api.client();
    bob.client.request("join", { roomName: "Replay Room", playerName: "Bob" });
    await settle();
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(alice.opens, 1);
    assert.equal(alice.responses.findLast(item => item.view === "room").data.match.turnOrder.playerCount, 2);
    assert.equal(api.network.frames.filter(frame => frame.type === "create").length, 2);
    const authentication = api.network.frames.filter(frame => frame.type === "authenticate");
    assert.match(authentication.at(-1).token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(authentication.at(-1).after > 0);
});

test("expired credentials create a new server session and request admission again", async (t) => {
    const api = harness(t);
    const alice = await api.client();
    api.network.sockets[0].stream.release();
    await settle();
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(alice.opens, 2);
    assert.equal(api.network.frames.filter(frame => frame.type === "create").length, 2);
});

test("five failed socket retries do not replay a gameplay mutation", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const network = installLiveSockets(t, readyGateway());
    const state = clientState();
    state.client.start();
    await settle();
    state.client.request("draw", { roomName: "Game Room" });
    network.available = false;
    network.sockets[0].close(1006);
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        t.mock.timers.tick(delay - 1);
        await settle();
        assert.equal(state.exhausted, 0);
        t.mock.timers.tick(1);
        await settle();
    }
    assert.equal(state.exhausted, 1);
    assert.equal(network.frames.filter(frame => frame.command === "draw").length, 1);
    assert.equal(state.client.request("draw", { roomName: "Game Room" }), false);
});

test("uncertain room creation is not resent and its result survives reconnect", async (t) => {
    const api = harness(t);
    const alice = await api.client();
    api.network.dropEvents = true;
    alice.client.request("create", { roomName: "Uncertain Room", playerName: "Alice", playerLimit: 2 });
    await settle();
    api.network.sockets[0].close(1006);
    await settle();
    api.network.dropEvents = false;
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(api.network.frames.filter(frame => frame.command === "create").length, 1);
    assert.equal(alice.responses.findLast(item => item.view === "room").data.name, "Uncertain Room");
    assert.equal(alice.opens, 1);
});

test("stop cancels an opening socket and suppresses stale callbacks", async (t) => {
    const network = installLiveSockets(t, readyGateway());
    const state = clientState();
    state.client.start();
    state.client.stop();
    await settle();
    assert.equal(network.sockets[0].readyState, 3);
    assert.equal(state.opens, 0);
    assert.deepEqual(state.responses, []);
});

test("a rendering exception does not retire credentials, reconnect, or stop subsequent delivery", async (t) => {
    const api = harness(t);
    const alice = await api.client();
    const errors = [];
    t.mock.method(console, "error", function recordError(...args) { errors.push(args); });
    let failed = false;
    alice.responses.push = function render(value) {
        if (!failed) {
            failed = true;
            throw new Error("Rendering failed");
        }
        return Array.prototype.push.call(this, value);
    };
    alice.client.request("create", { roomName: "Rendering Room", playerName: "Alice", playerLimit: 2 });
    await settle();
    alice.client.request("draw", { roomName: "Rendering Room" });
    await settle();
    alice.client.request("list", {});
    await settle();
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "Page callback failed:");
    assert.equal(alice.opens, 1);
    assert.equal(alice.closes, 0);
    assert.equal(api.network.frames.filter(frame => frame.type === "release").length, 0);
    assert.ok(alice.responses.some(item => item.data?.name === "Rendering Room"));
    assert.equal(api.network.sockets.length, 1);
});

for (const failure of ["version", "sequence"]) {
    test(`an invalid ${failure} frame releases its session without exposing the credential`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const network = installLiveSockets(t, { createStream(_address, send) {
            send({ type: "ready", service: "pick-2", version: failure === "version" ? 1 : 2, token: TOKEN });
            if (failure === "sequence") send({ type: "event", sequence: 2, response: { view: "home", data: {}, message: null } });
            return { stream: { receive() {}, acknowledge() {}, close() {}, release() {} } };
        } });
        const state = clientState();
        t.after(function cleanup() { state.client.stop(); });
        state.client.start();
        await settle();
        assert.deepEqual(state.responses, []);
        assert.equal(state.closes, 1);
        assert.ok(network.frames.some(function released(frame) { return frame.type === "release"; }));
        assert.doesNotMatch(JSON.stringify(state.statuses), new RegExp(TOKEN));
    });
}

test("a stalled handshake has a deadline and stopping cancels its retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const network = installLiveSockets(t, { createStream() {
        return { stream: { close() {}, release() {} } };
    } });
    const state = clientState();
    state.client.start();
    await settle();
    t.mock.timers.tick(HostedProtocol.CONNECTION_TIMEOUT_MS);
    await settle();
    assert.equal(state.closes, 1);
    assert.equal(state.opens, 0);
    assert.equal(network.sockets[0].readyState, 3);
    state.client.stop();
    t.mock.timers.tick(10000);
    await settle();
    assert.equal(network.sockets.length, 1);
});

for (const failure of ["sequence", "cursor"]) {
    test(`repeated ${failure} failures exhaust retries even after successful ready frames`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const network = installLiveSockets(t, { createStream(_address, send, disconnect) {
            send({ type: "ready", service: "pick-2", version: 2, token: TOKEN });
            if (failure === "sequence") send({ type: "event", sequence: 2, response: { view: "home", message: null, data: {} } });
            else queueMicrotask(function rejectCursor() { disconnect(4009); });
            return { stream: { receive() {}, acknowledge() {}, close() {}, release() {} } };
        } });
        const state = clientState();
        t.after(function cleanup() { state.client.stop(); });
        state.client.start();
        await settle();
        for (const delay of [1000, 2000, 4000, 8000, 16000]) {
            const sockets = network.sockets.length;
            t.mock.timers.tick(delay - 1);
            await settle();
            assert.equal(network.sockets.length, sockets);
            assert.equal(state.exhausted, 0);
            t.mock.timers.tick(1);
            await settle();
        }
        assert.equal(state.exhausted, 1);
        assert.equal(network.sockets.length, 6);
        assert.equal(state.client.request("draw", {}), false);
        t.mock.timers.tick(60000);
        await settle();
        assert.equal(network.sockets.length, 6, "manual recovery must own the next attempt");
    });
}
