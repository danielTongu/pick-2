import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { setImmediate as settle } from "node:timers/promises";
import WebSocket from "ws";

import { Host } from "../../host/Host.js";
import { HostedGateway } from "../../server/HostedGateway.js";
import { WebSocketGateway } from "../../server/WebSocketGateway.js";
import { memorySockets } from "../helpers/memory-sockets.js";

const ORIGIN = "https://game.example.test";

/** Builds real HTTP upgrade and socket parsers over connected memory streams. */
function harness(t, limits = {}) {
    const host = new Host("hosted", 0, false);
    const sessions = new HostedGateway(host, { allowedOrigins: [ORIGIN] });
    const server = http.createServer();
    const gateway = new WebSocketGateway(server, sessions, { limits });
    const sockets = [];
    t.after(async function cleanup() {
        for (const socket of sockets) socket.destroy();
        await gateway.close();
        await sessions.close();
        await host.shutdown();
    });
    return {
        gateway, sessions,
        async command(token, command, data) {
            const frames = [];
            const opened = sessions.openStream(token, 0, function send(value) { frames.push(value); }, function disconnect() {});
            opened.stream.receive({ command, data });
            await settle();
            opened.stream.close();
        },
        async credential() {
            let token;
            const opened = sessions.createStream("127.0.0.1", function send(frame) {
                if (frame.type === "ready") token = frame.token;
            }, function disconnect() {});
            opened.stream.close();
            return token;
        },
        socket(options = {}, path = "/live") {
            const [clientSocket, serverSocket] = memorySockets();
            sockets.push(clientSocket, serverSocket);
            server.emit("connection", serverSocket);
            const client = new WebSocket(`ws://localhost${path}`, {
                origin: ORIGIN, ...options, createConnection() { return clientSocket; }
            });
            client.frames = [];
            client.on("error", function ignoreTransportError() {});
            client.on("message", function retainFrame(data) { client.frames.push(JSON.parse(data.toString())); });
            return client;
        }
    };
}

/** Waits for one matching already-delivered or future server frame. */
async function frame(client, predicate) {
    let result = client.frames.find(predicate);
    while (result === undefined) {
        await once(client, "message");
        result = client.frames.find(predicate);
    }
    return result;
}

/** Authenticates a real socket without placing credentials in its URL. */
async function connect(api, token, options = {}) {
    const client = api.socket(options);
    await once(client, "open");
    client.send(JSON.stringify({ type: "authenticate", token, after: 0 }));
    await frame(client, function ready(value) { return value.type === "ready"; });
    return client;
}

/** Resolves a refused HTTP upgrade while consuming its response. */
async function refused(api, options, path) {
    const client = api.socket(options, path);
    const [_request, response] = await once(client, "unexpected-response");
    response.resume();
    client.terminate();
    return response.statusCode;
}

test("real upgrades enforce endpoint and exact browser origins", { timeout: 2000 }, async (t) => {
    const api = harness(t);
    assert.equal(await refused(api, { origin: "https://evil.example.test" }), 403);
    assert.equal(await refused(api, { origin: undefined }), 403);
    assert.equal(await refused(api, {}, "/live?token=secret"), 404);
});

test("real socket authentication rejects invalid credentials and non-authentication first frames", { timeout: 2000 }, async (t) => {
    const api = harness(t);
    for (const [message, code] of [[{ type: "authenticate", token: "invalid", after: 0 }, 4001], [{ command: "draw", data: {} }, 1008]]) {
        const client = api.socket();
        await once(client, "open");
        const closed = once(client, "close");
        client.send(JSON.stringify(message));
        assert.equal((await closed)[0], code);
    }
});

test("real gameplay frames push private room snapshots to players and spectators", { timeout: 2000 }, async (t) => {
    const api = harness(t);
    const alice = await api.credential();
    const bob = await api.credential();
    const viewer = await api.credential();
    await api.command(alice, "create", { roomName: "Socket Room", playerName: "Alice", playerLimit: 2 });
    await settle();
    await api.command(bob, "join", { roomName: "Socket Room", playerName: "Bob" });
    await settle();
    await api.command(viewer, "view", { roomName: "Socket Room" });
    await settle();
    const sockets = [await connect(api, alice), await connect(api, bob), await connect(api, viewer)];
    sockets[0].send(JSON.stringify({ command: "start", data: { roomName: "Socket Room", knockout: false } }));
    for (const [socket, local] of [[sockets[0], "Alice"], [sockets[1], "Bob"], [sockets[2], null]]) {
        const active = await frame(socket, function activeRoom(value) { return value.response?.data?.match?.state === "active"; });
        const snapshot = active.response.data;
        assert.equal(snapshot.localPlayerName, local);
        for (const player of snapshot.match.turnOrder.players) {
            assert.equal(player.collection.items.length, player.name === local ? 7 : 0);
            if (player.name !== local) assert.equal(player.collection.penalty, null);
        }
        assert.deepEqual(Object.keys(snapshot.match.collections.draw), ["itemCount"]);
        assert.doesNotMatch(JSON.stringify(active), new RegExp(alice));
    }
});

test("socket loss retains the Hosted session and replays only events after the client cursor", { timeout: 2000 }, async (t) => {
    const api = harness(t);
    const token = await api.credential();
    const first = await connect(api, token);
    const initial = await frame(first, function home(value) { return value.response?.view === "home"; });
    first.send(JSON.stringify({ type: "acknowledge", after: initial.sequence }));
    const closed = once(first, "close");
    first.close();
    await closed;
    const second = api.socket();
    await once(second, "open");
    second.send(JSON.stringify({ type: "authenticate", token, after: initial.sequence }));
    await frame(second, function ready(value) { return value.type === "ready"; });
    await settle();
    assert.equal(second.frames.filter(function event(value) { return value.type === "event"; }).length, 0);
});

test("socket message parsers reject binary, malformed JSON, and oversized frames", { timeout: 2000 }, async (t) => {
    const api = harness(t, { maxPayloadBytes: 256 });
    for (const [payload, code] of [[Buffer.from("binary"), 1003], ["{", 1007], ["x".repeat(1024), 1009]]) {
        const client = api.socket();
        await once(client, "open");
        const closed = once(client, "close");
        client.send(payload);
        assert.equal((await closed)[0], code);
    }
});

test("upgrade capacity is released on close and handshake counters survive reconnection", { timeout: 2000 }, async (t) => {
    const api = harness(t, { maxConnections: 1, maxConnectionsPerIp: 1, maxUpgradesPerIp: 3 });
    const first = await connect(api, await api.credential());
    assert.equal(await refused(api, {}), 503);
    const closed = once(first, "close");
    first.close();
    await closed;
    const second = await connect(api, await api.credential());
    assert.equal(await refused(api, {}), 429);
    second.close();
});

test("heartbeat cleanup removes stale sockets while responsive streams stay open", { timeout: 2000 }, async (t) => {
    const api = harness(t);
    const stale = await connect(api, await api.credential(), { autoPong: false });
    const responsive = await connect(api, await api.credential());
    const pong = once(responsive, "ping");
    api.gateway.maintain();
    await pong;
    await settle();
    const closed = once(stale, "close");
    api.gateway.maintain();
    await closed;
    assert.equal(responsive.readyState, WebSocket.OPEN);
});


test("unauthenticated sockets time out and slow outgoing consumers stay bounded", { timeout: 2000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const api = harness(t);
    const unauthenticated = api.socket();
    await once(unauthenticated, "open");
    const expired = once(unauthenticated, "close");
    t.mock.timers.tick(WebSocketGateway.AUTHENTICATION_TIMEOUT_MS);
    assert.equal((await expired)[0], 1008);

    const bounded = harness(t, { maxBufferedBytes: 64 });
    const client = bounded.socket();
    await once(client, "open");
    const terminated = once(client, "close");
    client.send(JSON.stringify({ type: "authenticate", token: await bounded.credential(), after: 0 }));
    assert.equal((await terminated)[0], 1006);
});

test("a fresh socket creates its credential, runs admission commands, and explicitly releases its seat", { timeout: 2000 }, async (t) => {
    const api = harness(t);
    const client = api.socket();
    await once(client, "open");
    client.send(JSON.stringify({ type: "create" }));
    const ready = await frame(client, function ready(value) { return value.type === "ready"; });
    assert.equal(ready.version, 2);
    assert.equal(ready.service, "pick-2");
    assert.match(ready.token, /^[A-Za-z0-9_-]{43}$/);
    client.send(JSON.stringify({ command: "create", data: { roomName: "Fresh Room", playerName: "Alice", playerLimit: 2 } }));
    const room = await frame(client, function joined(value) { return value.response?.data?.name === "Fresh Room"; });
    assert.equal(room.response.data.localPlayerName, "Alice");
    const closed = once(client, "close");
    client.send(JSON.stringify({ type: "release" }));
    assert.equal((await closed)[0], 4001);
    assert.equal(api.sessions.openStream(ready.token, 0, function send() {}, function close() {}).closeCode, 4001);
});
