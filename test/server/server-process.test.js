import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ORIGIN = "https://game.example.test";

test("Hosted process applies WebSocket admission policies, frame limits, and graceful shutdown", { timeout: 10000 }, async (t) => {
    const reservation = http.createServer();
    const listening = once(reservation, "listening");
    reservation.listen(0, "127.0.0.1");
    await listening;
    const port = reservation.address().port;
    await new Promise(function close(resolve) { reservation.close(resolve); });
    const child = spawn(process.execPath, ["server/main.js"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, PORT: String(port), WS_ALLOWED_ORIGINS: ORIGIN,
            GAME_SERVER_ORIGIN: "https://live.example.test", WS_MAX_SESSIONS: "1", WS_MAX_SESSIONS_PER_IP: "1", WS_MAX_PAYLOAD_BYTES: "256",
            WS_MAX_CONNECTIONS: "1", WS_MAX_CONNECTIONS_PER_IP: "1" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stderr.on("data", function stderr(data) { output += data.toString(); });
    t.after(async function cleanup() {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
        }
    });
    await new Promise(function ready(resolve, reject) {
        child.once("error", reject);
        child.once("exit", function earlyExit(code) { reject(new Error(`Server exited ${code}: ${output}`)); });
        child.stdout.on("data", function stdout(data) {
            output += data.toString();
            if (output.includes("Hosted server listening")) resolve();
        });
    });
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal(await (await fetch(`${origin}/health`)).text(), "OK");
    const configurationResponse = await fetch(`${origin}/config.js`);
    assert.equal(configurationResponse.headers.get("cache-control"), "no-store");
    assert.match(await configurationResponse.text(), /"hostedOrigin":"https:\/\/live.example.test"/);
    assert.equal((await fetch(`${origin}/server/main.js`)).status, 404);
    const image = await fetch(`${origin}/ui/images/joker.png`);
    assert.equal(image.status, 200);
    assert.ok((await image.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(`${origin}/api/sessions`, { method: "POST", body: "{}" })).status, 404);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, { origin: ORIGIN });
    socket.on("error", function ignoreError() {});
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "create" }));
    const session = JSON.parse((await ready)[0].toString());
    assert.equal(session.type, "ready");
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    const refused = new WebSocket(`ws://127.0.0.1:${port}/live`, { origin: ORIGIN });
    refused.on("error", function ignoreError() {});
    const [_request, denied] = await once(refused, "unexpected-response");
    assert.equal(denied.statusCode, 503);
    denied.resume();
    refused.terminate();
    const disconnected = once(socket, "close");
    socket.send(JSON.stringify({ type: "release" }));
    assert.equal((await disconnected)[0], 4001);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    assert.equal((await exited)[0], 0, output);
    assert.match(output, /Shutdown complete/);
});
