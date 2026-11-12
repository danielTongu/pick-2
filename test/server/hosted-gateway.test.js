import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { HostedGateway } from "../../server/HostedGateway.js";
import { Host } from "../../host/Host.js";

const ORIGIN = "https://game.example.test";

/** Creates real session authority without opening a listening socket. */
function harness(t, limits = {}, host = new Host("hosted", 0, false), trustedProxyIps = []) {
    const gateway = new HostedGateway(host, { allowedOrigins: [ORIGIN], trustedProxyIps, limits });
    t.after(async function cleanup() { await gateway.close(); await host.shutdown(); });
    return { gateway, host };
}

/** Creates a session and records its private handshake, events, and disconnects. */
function session(gateway, address = "127.0.0.1") {
    const actor = { frames: [], codes: [], token: null };
    const opened = gateway.createStream(address, function send(frame) {
        actor.frames.push(frame);
        if (frame.type === "ready") actor.token = frame.token;
    }, function disconnect(code) { actor.codes.push(code); });
    return { ...actor, ...opened };
}

/** Opens a retained session and records replay without acknowledging it. */
function reconnect(gateway, token, after = 0) {
    const frames = [];
    const codes = [];
    const opened = gateway.openStream(token, after, function send(frame) { frames.push(frame); },
        function disconnect(code) { codes.push(code); });
    return { ...opened, frames, codes };
}

test("sessions create a secret server identity and reject impersonated card commands", async (t) => {
    const { gateway } = harness(t);
    const owner = session(gateway);
    const attacker = session(gateway);
    assert.match(owner.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(owner.token, attacker.token);
    owner.stream.receive({ command: "create", data: { roomName: "Private Room", playerName: "Alice", tabId: "forged" } });
    await settle();
    attacker.stream.receive({ command: "draw", data: { roomName: "Private Room", playerName: "Alice", tabId: "forged" } });
    await settle();
    assert.ok(attacker.frames.some(function denied(frame) { return frame.response?.message?.status === "error"; }));
    assert.doesNotMatch(JSON.stringify(attacker.frames), new RegExp(owner.token));
    assert.equal(gateway.openStream("bad", 0, function send() {}, function close() {}).closeCode, 4001);
});

test("explicit release frees capacity and session-creation limits survive departure", async (t) => {
    const { gateway } = harness(t, { maxSessions: 2, maxSessionsPerIp: 1, maxSessionCreatesPerIp: 2 });
    const first = session(gateway);
    assert.equal(session(gateway).closeCode, 1013);
    assert.equal(session(gateway, "192.0.2.1").stream !== null, true);
    assert.equal(session(gateway, "192.0.2.2").closeCode, 1013);
    first.stream.release();
    assert.equal(reconnect(gateway, first.token).closeCode, 4001);
    assert.equal(session(gateway).closeCode, 1013, "creation attempts remain counted after release");
    await settle();
});

test("trusted proxies alone control forwarded client IPs; counter tables remain bounded", (t) => {
    const { gateway } = harness(t, { maxTrackedIps: 1 }, undefined, ["127.0.0.1"]);
    assert.equal(gateway.clientAddress({ remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "192.0.2.3" } }), "192.0.2.3");
    assert.equal(gateway.clientAddress({ remoteAddress: "192.0.2.8", headers: { "x-forwarded-for": "192.0.2.3" } }), "192.0.2.8");
    assert.equal(gateway.clientAddress({ remoteAddress: "::ffff:127.0.0.1", headers: { "x-forwarded-for": "invalid" } }), "127.0.0.1");
    assert.equal(session(gateway).stream !== null, true);
    assert.equal(session(gateway, "192.0.2.9").closeCode, 1013);
});

test("replay preserves missed events and a bad cursor retires its credential", async (t) => {
    const { gateway } = harness(t);
    const actor = session(gateway);
    await settle();
    const first = reconnect(gateway, actor.token);
    const events = first.frames.filter(function event(frame) { return frame.type === "event"; });
    assert.ok(events.length > 0);
    const cursor = events.at(-1).sequence;
    assert.deepEqual(reconnect(gateway, actor.token).frames.slice(1), events);
    const acknowledged = reconnect(gateway, actor.token, cursor);
    assert.equal(acknowledged.frames.length, 1);
    assert.equal(reconnect(gateway, actor.token, 0).closeCode, 4009);
    assert.equal(reconnect(gateway, actor.token, cursor).closeCode, 4001);
    for (const cursor of [-1, "0", 1.2, Number.MAX_SAFE_INTEGER + 1]) {
        const actor = session(gateway, "192.0.2.1");
        assert.equal(reconnect(gateway, actor.token, cursor).closeCode, 4009);
    }
});

test("all canonical commands share the authenticated stream and ignore forged tab identities", async (t) => {
    const received = [];
    const host = { accept() { return { receive(request) { received.push(request); }, async close() {} }; }, async shutdown() {} };
    const { gateway } = harness(t, {}, host);
    const actor = session(gateway);
    for (const command of ["list", "create", "join", "view", "leave", "start", "draw", "discard", "pass", "declare"]) {
        actor.stream.receive({ command, data: { tabId: "forged" } });
        await settle();
        assert.equal(received.at(-1).command, command);
        assert.notEqual(received.at(-1).data.tabId, "forged");
    }
    for (const request of [{ command: "constructor", data: {} }, { command: "draw", data: [] }]) {
        actor.stream.receive(request);
        assert.equal(actor.codes.at(-1), 1008);
    }
});

test("liveness does not change game activity and expiry removes retained membership", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    class CapturingHost extends Host {
        createRoomService(name, limit) { this.service = super.createRoomService(name, limit); return this.service; }
    }
    const host = new CapturingHost("hosted", 0, false);
    const { gateway } = harness(t, { sessionTtlMs: 1000 }, host);
    const actor = session(gateway);
    actor.stream.receive({ command: "create", data: { roomName: "Expiry Room", playerName: "Alice" } });
    await settle();
    const activity = host.service.room.lastActiveAt;
    t.mock.timers.tick(500);
    actor.stream.touch();
    assert.equal(host.service.room.lastActiveAt, activity);
    actor.stream.close();
    t.mock.timers.tick(1000);
    gateway.maintain();
    await settle();
    assert.equal(reconnect(gateway, actor.token).closeCode, 4001);
    assert.equal(host.service.room.hasPlayer("Alice"), false);
});

test("per-session command and pending-work budgets reject excess dispatch", async (t) => {
    const limited = harness(t, { maxCommandsPerWindow: 1 });
    const actor = session(limited.gateway);
    actor.stream.receive({ command: "list", data: {} });
    actor.stream.receive({ command: "list", data: {} });
    assert.equal(actor.codes.at(-1), 1008);
    let finish;
    const host = { accept() { return { receive() { return new Promise(function pending(resolve) { finish = resolve; }); }, async close() {} }; }, async shutdown() {} };
    const pending = harness(t, { maxInFlight: 1 }, host);
    const blocked = session(pending.gateway);
    blocked.stream.receive({ command: "list", data: {} });
    blocked.stream.receive({ command: "create", data: {} });
    assert.equal(blocked.codes.at(-1), 1008);
    finish();
    await settle();
});

test("event count and byte budgets release slow consumers; shutdown rejects creation", async (t) => {
    for (const limits of [{ maxEvents: 1 }, { maxEventBytes: 64 }]) {
        let publish;
        let closes = 0;
        const host = { accept(send) { publish = send; return { async close() { closes += 1; } }; }, async shutdown() {} };
        const { gateway } = harness(t, limits, host);
        const actor = session(gateway);
        publish({ message: "x".repeat(100) });
        publish({ message: "second" });
        await settle();
        assert.equal(reconnect(gateway, actor.token).closeCode, 4001);
        assert.equal(closes, 1);
        await gateway.close();
        assert.equal(session(gateway).closeCode, 1013);
    }
});

test("replacement ownership survives late close and release from the old stream", async (t) => {
    const { gateway } = harness(t);
    const first = session(gateway);
    const second = reconnect(gateway, first.token);
    first.stream.close();
    first.stream.release();
    second.stream.receive({ command: "create", data: { roomName: "Replacement Room", playerName: "Alice" } });
    await settle();
    assert.ok(second.frames.some(function room(frame) { return frame.response?.data?.name === "Replacement Room"; }));
});

test("failed Host admission rolls back capacity and invalid deployment policies fail", async (t) => {
    let fail = true;
    const host = { accept() { if (fail) throw new Error("Admission failed"); return { async close() {} }; }, async shutdown() {} };
    const { gateway } = harness(t, { maxSessions: 1 }, host);
    assert.throws(function rejected() { session(gateway); }, /Admission failed/);
    fail = false;
    assert.equal(session(gateway).stream !== null, true);
    for (const policy of [{ allowedOrigins: [] }, { allowedOrigins: ["https://example.test/path"] },
        { allowedOrigins: [ORIGIN], trustedProxyIps: ["proxy.example.test"] }, { allowedOrigins: [ORIGIN], limits: { maxSessions: 0 } }]) {
        assert.throws(function invalid() { new HostedGateway({}, policy); });
    }
});
