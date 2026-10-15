import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { Host } from "../../host/Host.js";
import { WebSocketGateway } from "../../server/WebSocketGateway.js";

const ORIGIN = "https://game.example.test";

async function fixture(t, limits = {}, policy = {}, applicationHost = null) {
    const host = applicationHost ?? {
        clients: [], requests: [], closed: 0, waiters: [],
        async handle() {},
        accept(publish) {
            const client = {
                publish,
                receive: async request => { host.requests.push(request); await host.handle(request); publish({ ack: request }); },
                async close() {
                    host.closed++;
                    for (const waiter of host.waiters) if (host.closed >= waiter.count) waiter.resolve();
                }
            };
            host.clients.push(client);
            return client;
        },
        waitForClosed(count) {
            return host.closed >= count ? Promise.resolve() : new Promise(resolve => host.waiters.push({ count, resolve }));
        }
    };
    const server = http.createServer((_request, response) => response.end("OK"));
    const gateway = new WebSocketGateway(server, host, { allowedOrigins: [ORIGIN], limits, ...policy });
    t.after(async () => {
        await gateway.close();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const url = `ws://127.0.0.1:${server.address().port}/`;
    async function open(settings = {}) {
        const socket = new WebSocket(url, { origin: ORIGIN, ...settings });
        socket.on("error", () => {});
        await once(socket, "open");
        return socket;
    }
    async function rejected(settings = {}) {
        const socket = new WebSocket(url, { origin: ORIGIN, ...settings });
        socket.on("error", () => {});
        return new Promise((resolve, reject) => {
            socket.once("open", () => { socket.terminate(); reject(new Error("Upgrade unexpectedly accepted")); });
            socket.once("unexpected-response", (_request, response) => {
                response.resume();
                socket.terminate();
                resolve(response.statusCode);
            });
            socket.once("error", reject);
        });
    }
    return { host, gateway, open, rejected };
}

test("only explicitly allowed origins can open a game connection", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    for (const origin of [undefined, "null", "https://evil.example.test", "https://game.example.test.evil.test"]) {
        assert.equal(await f.rejected({ origin }), 403);
    }
    assert.equal(f.host.clients.length, 0);
    const socket = await f.open();
    const reply = once(socket, "message");
    socket.send(JSON.stringify({ command: "list" }));
    assert.deepEqual(JSON.parse((await reply)[0].toString()), { ack: { command: "list" } });
});

test("global capacity rejects competing upgrades and is released on disconnect", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxConnections: 2, maxConnectionsPerIp: 5 });
    const sockets = await Promise.all([f.open(), f.open()]);
    assert.equal(await f.rejected(), 503);
    sockets[0].close();
    await f.host.waitForClosed(1);
    await f.open();
    assert.equal(f.host.clients.length, 3);
});

test("IP limits ignore spoofed forwarded headers from untrusted peers", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxConnectionsPerIp: 1 });
    await f.open({ headers: { "X-Forwarded-For": "198.51.100.1" } });
    assert.equal(await f.rejected({ headers: { "X-Forwarded-For": "198.51.100.2" } }), 429);
});

test("explicitly trusted proxies use the nearest untrusted forwarded address", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxConnectionsPerIp: 1 }, { trustedProxyIps: ["127.0.0.1"] });
    await f.open({ headers: { "X-Forwarded-For": "203.0.113.1, 198.51.100.1" } });
    await f.open({ headers: { "X-Forwarded-For": "198.51.100.2" } });
    assert.equal(await f.rejected({ headers: { "X-Forwarded-For": "203.0.113.99, 198.51.100.1" } }), 429);
    assert.equal(await f.rejected({ headers: { "X-Forwarded-For": "::ffff:198.51.100.1" } }), 429);
});

test("handshake rate limits survive reconnecting with fresh sockets", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxUpgradesPerIp: 2 });
    for (let count = 1; count <= 2; count++) {
        const socket = await f.open();
        socket.close();
        await f.host.waitForClosed(count);
    }
    assert.equal(await f.rejected(), 429);
});

for (const example of [
    { name: "oversized messages", limits: { maxPayloadBytes: 128 }, payload: JSON.stringify({ data: "x".repeat(512) }), code: 1009 },
    { name: "binary frames", limits: {}, payload: Buffer.from('{}'), code: 1003 },
    { name: "malformed JSON", limits: {}, payload: '{', code: 1007 }
]) {
    test(`rejects ${example.name} before dispatching application work`, { timeout: 5000 }, async t => {
        const f = await fixture(t, example.limits);
        const socket = await f.open();
        const closed = once(socket, "close");
        socket.send(example.payload);
        assert.equal((await closed)[0], example.code);
        assert.deepEqual(f.host.requests, []);
        await f.host.waitForClosed(1);
    });
}

test("message bursts are bounded before Host dispatch", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxMessagesPerWindow: 2 });
    const socket = await f.open();
    const closed = once(socket, "close");
    for (let index = 0; index < 3; index++) socket.send(JSON.stringify({ index }));
    assert.equal((await closed)[0], 1008);
    assert.equal(f.host.requests.length, 2);
});

test("unfinished Host work is bounded per connection", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxInFlightRequests: 1 });
    let release;
    f.host.handle = () => new Promise(resolve => { release = resolve; });
    t.after(() => release?.());
    const socket = await f.open();
    const closed = once(socket, "close");
    socket.send('{}');
    socket.send('{}');
    assert.equal((await closed)[0], 1008);
    assert.equal(f.host.requests.length, 1);
});

test("an excessive outbound buffer budget disconnects the client", { timeout: 5000 }, async t => {
    const f = await fixture(t, { maxBufferedBytes: 32 });
    const socket = await f.open();
    const closed = once(socket, "close");
    f.host.clients[0].publish({ data: "x".repeat(100) });
    assert.equal((await closed)[0], 1006);
    await f.host.waitForClosed(1);
});

test("missed pong terminates a stale socket and releases its membership", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const socket = await f.open({ autoPong: false });
    const ping = once(socket, "ping");
    f.gateway.maintain();
    await ping;
    const closed = once(socket, "close");
    f.gateway.maintain();
    assert.equal((await closed)[0], 1006);
    await f.host.waitForClosed(1);
});

test("responsive clients remain connected across heartbeat checks", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const socket = await f.open();
    for (let index = 0; index < 2; index++) {
        const ping = once(socket, "ping");
        f.gateway.maintain();
        await ping;
        const response = once(socket, "message");
        socket.send(JSON.stringify({ index }));
        await response;
    }
    assert.equal(f.host.closed, 0);
});

test("real hosted clients receive their own hands while spectators receive counts only", { timeout: 5000 }, async t => {
    const host = new Host("hosted", 0, false);
    const f = await fixture(t, {}, {}, host);
    t.after(() => host.shutdown());
    const [alice, bob, spectator] = await Promise.all([f.open(), f.open(), f.open()]);
    function waitForRoom(socket, state = null) {
        return new Promise(resolve => {
            function receive(data) {
                const response = JSON.parse(data.toString());
                if (response.view === "room" && (state === null || response.data.match.state === state)) {
                    socket.off("message", receive);
                    resolve(response.data);
                }
            }
            socket.on("message", receive);
        });
    }
    let response = waitForRoom(alice);
    alice.send(JSON.stringify({ command: "create", data: { tabId: "wire-alice", roomName: "Wire Privacy", playerName: "Alice", playerLimit: 2 } }));
    await response;
    response = waitForRoom(bob);
    bob.send(JSON.stringify({ command: "join", data: { tabId: "wire-bob", roomName: "Wire Privacy", playerName: "Bob" } }));
    await response;
    response = waitForRoom(spectator);
    spectator.send(JSON.stringify({ command: "view", data: { tabId: "wire-viewer", roomName: "Wire Privacy" } }));
    await response;
    const started = [alice, bob, spectator].map(socket => waitForRoom(socket, "active"));
    alice.send(JSON.stringify({ command: "start", data: { tabId: "wire-alice" } }));
    for (const snapshot of await Promise.all(started)) {
        for (const player of snapshot.match.turnOrder.players) {
            assert.equal(player.collection.itemCount, 7);
            assert.equal(player.collection.items.length, player.name === snapshot.localPlayerName ? 7 : 0);
            if (player.name !== snapshot.localPlayerName) assert.equal(player.collection.penalty, null);
        }
    }
});
