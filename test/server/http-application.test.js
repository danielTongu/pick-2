import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";

import { createApplication } from "../../server/HttpApplication.js";

const ORIGIN = "https://game.example.test";

/** Drives the real Express/Node request pipeline over memory streams without a listening port. */
function request(application, method, path, body = "", headers = {}) {
    return new Promise(function dispatch(resolve, reject) {
        const chunks = [];
        const socket = new Duplex({
            read() {},
            write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); }
        });
        socket.remoteAddress = "127.0.0.1";
        const incoming = new IncomingMessage(socket);
        incoming.method = method;
        incoming.url = path;
        incoming.httpVersion = "1.1";
        incoming.complete = true;
        incoming.headers = { host: "localhost", origin: ORIGIN, "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)), ...headers };
        const outgoing = new ServerResponse(incoming);
        outgoing.assignSocket(socket);
        outgoing.on("error", reject);
        outgoing.on("finish", function finished() {
            const raw = Buffer.concat(chunks).toString();
            const payload = raw.slice(raw.indexOf("\r\n\r\n") + 4);
            resolve({ status: outgoing.statusCode, headers: outgoing.getHeaders(), body: payload });
            socket.destroy();
        });
        application(incoming, outgoing);
        if (body) incoming.push(Buffer.from(body));
        incoming.push(null);
    });
}

test("HTTP serves health/assets and has no session, admission, or command resources", async () => {
    const app = createApplication();
    assert.equal((await request(app, "GET", "/health")).body, "OK");
    assert.match((await request(app, "GET", "/")).body, /<!doctype html>/i);
    for (const path of ["/api/health", "/api/sessions", "/api/rooms", "/api/membership", "/live"]) {
        assert.equal((await request(app, "GET", path)).status, 404);
        assert.equal((await request(app, "POST", path, "{")).status, 404);
    }
});

test("Static routes serve browser assets and reject repository internals and traversal", async (t) => {
    const app = createApplication();
    for (const asset of ["/index.html", "/room.html", "/connection.html", "/main.js", "/config.js",
        "/model/Card.js", "/service/RoomService.js", "/host/Host.js", "/shared/Constants.js",
        "/ui/Session.js", "/ui/controllers/HomeController.js", "/ui/utilities/TemplateUtils.js",
        "/ui/styles/base.css", "/ui/templates/player.html", "/sitemap.xml"]) {
        assert.equal((await request(app, "GET", asset)).status, 200, asset);
    }
    assert.equal((await request(app, "HEAD", "/main.js")).status, 200);
    for (const asset of ["/README.md", "/package.json", "/package-lock.json", "/AGENTS.md", "/.env",
        "/.git/config", "/server/main.js", "/server/HttpApplication.js", "/test/architecture.test.js",
        "/docs/README.md", "/node_modules/express/package.json", "/ui/", "/model/",
        "/ui/../server/main.js", "/ui/%2e%2e/server/main.js", "/%73erver/main.js",
        "/ui/styles/../../package.json", "/ui/styles/base.css/../../package.json"]) {
        assert.equal((await request(app, "GET", asset)).status, 404, asset);
    }
});

test("Public configuration is a noncached module with a validated deployment endpoint", async (t) => {
    for (const origin of ["https://live.example.test", "http://localhost:9000", ""]) {
        const result = await request(createApplication(origin), "GET", "/config.js");
        assert.equal(result.status, 200);
        assert.equal(result.headers["cache-control"], "no-store");
        assert.match(result.headers["content-type"], /javascript/);
        const module = await import(`data:text/javascript;base64,${Buffer.from(result.body).toString("base64")}`);
        assert.equal(module.configuration.hostedOrigin, origin);
    }
    for (const origin of ["javascript:alert(1)", "ftp://live.example.test", "https://user:secret@live.example.test",
        "https://live.example.test/path", "https://live.example.test/?token=secret", "https://live.example.test/#fragment", "not a URL"]) {
        assert.throws(function invalidConfiguration() { createApplication(origin); }, Error);
    }
});
