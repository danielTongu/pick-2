import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ORIGIN = "https://game.example.test";

test("server entry point applies gateway environment policy and shuts down cleanly", { timeout: 10_000 }, async t => {
    const reservation = http.createServer();
    const reserved = once(reservation, "listening");
    reservation.listen(0, "127.0.0.1");
    await reserved;
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, ["server.js"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, PORT: String(port), WS_ALLOWED_ORIGINS: ORIGIN,
            WS_MAX_CONNECTIONS: "1", WS_MAX_CONNECTIONS_PER_IP: "1", WS_MAX_PAYLOAD_BYTES: "256" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stderr.on("data", data => { output += data.toString(); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
        }
    });
    await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`Server exited ${code}: ${output}`)));
        child.stdout.on("data", data => {
            output += data.toString();
            if (output.includes("Hosted server listening")) resolve();
        });
    });
    const url = `ws://127.0.0.1:${port}/`;
    async function rejected(origin) {
        const socket = new WebSocket(url, { origin });
        socket.on("error", () => {});
        return new Promise((resolve, reject) => {
            socket.once("unexpected-response", (_request, response) => {
                response.resume(); socket.terminate(); resolve(response.statusCode);
            });
            socket.once("open", () => { socket.terminate(); reject(new Error("Unexpectedly accepted")); });
            socket.once("error", reject);
        });
    }
    assert.equal(await rejected("https://evil.example.test"), 403);
    const socket = new WebSocket(url, { origin: ORIGIN });
    socket.on("error", () => {});
    await once(socket, "open");
    assert.equal(await rejected(ORIGIN), 503);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ data: "x".repeat(512) }));
    assert.equal((await closed)[0], 1009);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    assert.equal((await exited)[0], 0, output);
    assert.match(output, /Shutdown complete/);
});
