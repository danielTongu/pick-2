"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { configuration } from "../../config.js";
import { Constants } from "../../shared/Constants.js";
import { HostedClient } from "../../ui/HostedClient.js";
import { HostedProtocol } from "../../shared/HostedProtocol.js";
import { installLiveSockets } from "../helpers/live-socket.js";
import { Session } from "../../ui/Session.js";
import { SessionState } from "../../ui/SessionState.js";

/** Installs the browser values used by SessionState and restores them afterward. */
function useBrowserState(serverOrigin, callback) {
    const originalOrigin = configuration.hostedOrigin;
    configuration.hostedOrigin = serverOrigin;
    const originals = new Map();
    const storage = new Map();
    const values = {
        document: {
            body: { dataset: { game: "pick2" } },
        },
        location: {
            href: "https://example.test/pick-2/network/",
            origin: "https://example.test",
            search: ""
        },
        sessionStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        }
    };

    for (const [key, value] of Object.entries(values)) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }

    try {
        return callback();
    } finally {
        configuration.hostedOrigin = originalOrigin;
        for (const [key, descriptor] of originals) {
            if (descriptor === undefined) {
                delete globalThis[key];
            } else {
                Object.defineProperty(globalThis, key, descriptor);
            }
        }
    }
}

test("SessionState resolves only the configured Hosted host", () => {
    useBrowserState("", () => {
        assert.equal(SessionState.getModePreference(), null);
        assert.equal(SessionState.getMode(), "direct");
        assert.equal(SessionState.getConfiguredServerOrigin(), null);
        assert.throws(() => SessionState.getHostedUrl(), /not configured/);
    });

    const cases = new Map([
        ["http://server.test:8080/game?old=1#part", "http://server.test:8080/"],
        ["https://server.test/game", "https://server.test/"],
        ["https://server.test:8080/", "https://server.test:8080/"]
    ]);

    for (const [origin, expectedUrl] of cases) {
        useBrowserState(`  ${origin}  `, () => {
            assert.equal(SessionState.getMode(), "hosted");
            assert.equal(SessionState.getConfiguredServerOrigin(), origin.trim());
            assert.equal(SessionState.getHostedUrl(), expectedUrl);
        });
    }

    useBrowserState("ftp://server.test", () => {
        assert.throws(() => SessionState.getHostedUrl(), /Unsupported server protocol/);
    });
    useBrowserState("", () => {
        assert.throws(() => SessionState.resolveHostedUrl("https://user:secret@server.test"), /cannot include credentials/);
    });
});

test("SessionState uses Direct for blank configuration and preserves explicit mode choices", () => {
    useBrowserState("   ", () => {
        assert.equal(SessionState.getMode(), "direct");
    });
    useBrowserState("https://server.test", () => {
        SessionState.setMode("direct");
        assert.equal(SessionState.getMode(), "direct");
        globalThis.location.search = "?mode=hosted";
        assert.equal(SessionState.getMode(), "hosted");
    });
});

test("SessionState resolves deployment configuration without storing a verified endpoint", () => {
    useBrowserState("https://server.test", () => {
        assert.equal(SessionState.getHostedUrl(), "https://server.test/");
        assert.throws(() => SessionState.resolveHostedUrl("/socket"), /Invalid URL/);
    });
});

test("the standalone Connection page verifies Hosted servers", () => {
    const homeHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const connectionHtml = readFileSync(new URL("../../connection.html", import.meta.url), "utf8");
    const view = readFileSync(new URL("../../ui/Session.js", import.meta.url), "utf8");
    const main = readFileSync(new URL("../../main.js", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../ui/styles/connection.css", import.meta.url), "utf8");
    const controller = readFileSync(
        new URL("../../ui/controllers/ConnectionController.js", import.meta.url), "utf8"
    );

    assert.doesNotMatch(homeHtml, /id="connection-view"/);
    assert.doesNotMatch(homeHtml, /Connection settings/);
    assert.match(connectionHtml, /<main id="site-shell" data-connection-status="connecting">/);
    assert.match(connectionHtml, /id="connection-view"/);
    assert.match(connectionHtml, /id="connection-form"/);
    assert.match(connectionHtml, /<output id="connection-origin">/);
    assert.match(connectionHtml, /<details id="connection-details">/);
    assert.doesNotMatch(connectionHtml, /class="connection-status"|type="url"/);
    assert.match(connectionHtml, /id="connection-connect-button" type="submit"/);
    assert.match(connectionHtml, /id="connection-direct-link" href="\.\/index\.html\?mode=direct"/);
    assert.match(connectionHtml, /id="connection-actions">[\s\S]*?id="connection-connect-button"[\s\S]*?id="connection-direct-link"[\s\S]*?<\/div>[\s\S]*?<\/form>/);
    assert.match(connectionHtml, /href="\.\/ui\/styles\/connection\.css"/);
    assert.match(main, /new ConnectionSession\(homeUrl\)\.start\(\)/);
    assert.match(view, /new HostedClient\(endpoint/);
    assert.match(view, /location\.replace\(this\.#homeUrl\("hosted"\)\)/);
    assert.match(view, /url\.searchParams\.set\("failed", "1"\)/);
    assert.match(view, /new URL\("\.\/connection\.html", location\.href\)/);
    assert.doesNotMatch(view, /getCurrentHostUrl/);
    assert.doesNotMatch(view, /fetch\(|RestProbe/);
    assert.match(controller, /HostedProtocol\.CONNECTION_TIMEOUT_MS/);
    assert.match(controller, /this\.#durationOutput\.textContent/);
    assert.match(connectionHtml, /id="connection-diagnostics"/);
    assert.match(connectionHtml, /id="connection-endpoint"/);
    assert.match(connectionHtml, /id="connection-duration"/);
    assert.match(view, /#handleHostedExhausted\(\)/);
    assert.match(styles, /#connection-title\s*\{[\s\S]*?color:\s*var\(--connection-accent\)/);
    assert.match(styles, /\[data-connection-status="error"\] \.connection-state\.connection-error/);
    assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 180px\), 1fr\)\)/);
    assert.match(styles, /@media \(max-width: 520px\)/);
    assert.doesNotMatch(styles, /#connection-view\[data-status="connecting"\],\s*#connection-indicator/);
});

test("Connection page verifies a real socket session and keeps failures available for retry", async (t) => {
    const authority = { createStream(_address, send) {
        send({ type: "ready", service: "pick-2", version: 2, token: "a".repeat(43) });
        return { stream: { release() {}, close() {}, receive() {}, acknowledge() {} } };
    } };
    const network = installLiveSockets(t, authority);
    const view = readFileSync(new URL("../../ui/Session.js", import.meta.url), "utf8");
    const source = view.slice(view.indexOf("/** Coordinates the standalone Hosted Connection page. */"),
        view.indexOf("/** Coordinates Home controllers, transport selection, and Room navigation. */"))
        .replaceAll("export ", "")
        .replace('await import("./controllers/ConnectionController.js")', '{ConnectionController: FakeController}');
    for (const available of [true, false]) {
        network.available = available;
        const state = { redirects: [], renders: [], mode: null };
        class FakeController {
            initialize() {}
            renderYear() {}
            render(status, metrics) { state.renders.push({ status, metrics }); }
        }
        class FakeSession { constructor(url) { this.url = url; } }
        const context = { URL, URLSearchParams, Constants, HostedClient, FakeController, Session: FakeSession,
            SessionState: { getHostedUrl() { return "https://server.test/"; }, setMode(mode) { state.mode = mode; } },
            location: { search: "", replace(url) { state.redirects.push(url); } },
            window: { addEventListener() {} }
        };
        await runInNewContext(`(async function () { ${source};
            await new ConnectionSession(new URL("https://example.test/index.html")).start(); })()`, context);
        await new Promise(function flush(resolve) { setImmediate(resolve); });
        if (available) {
            assert.equal(state.mode, "hosted");
            assert.deepEqual(state.redirects, ["https://example.test/index.html?mode=hosted"]);
            assert.equal(state.renders.at(-1).status, "connected");
        } else {
            assert.deepEqual(state.redirects, []);
            assert.equal(state.renders.at(-1).status, "error");
            assert.equal(state.renders.at(-1).metrics.failure, "Live WebSocket connection failed.");
        }
    }
});

test("ConnectionController scopes status to the shared container and renders diagnostics as text", () => {
    const source = readFileSync(new URL("../../ui/controllers/ConnectionController.js", import.meta.url), "utf8")
        .replace(/^import .+;\n/gm, "")
        .replaceAll("export ", "");
    class Element {
        constructor() { this.dataset = {}; this.value = ""; this.textContent = ""; }
        addEventListener(_name, handler) { this.handler = handler; }
        setAttribute(name, value) { this[name] = value; }
    }
    const elements = new Map();
    const context = {
        HostedProtocol,
        Constants: {
            STATUS: {CONNECTING: "connecting", CONNECTED: "connected", ERROR: "error", UNCONFIGURED: "unconfigured"}
        },
        DomUtils: {require(selector) {
            if (!elements.has(selector)) elements.set(selector, new Element());
            return elements.get(selector);
        }},
        ViewController: class {constructor(selector) {this.root = context.DomUtils.require(selector);}},
        HTMLElement: Element, HTMLInputElement: Element, HTMLButtonElement: Element, HTMLFormElement: Element
    };
    runInNewContext(`${source}; new ConnectionController().render("error", {
        endpoint: "https://example.test/", attempt: 3, candidate: 2, candidateCount: 2,
        elapsedMs: 42, failure: "Live WebSocket connection failed."
    });`, context);

    assert.equal(elements.get("#site-shell").dataset.connectionStatus, "error");
    assert.equal(elements.get("#connection-attempt").textContent, "#3 · candidate 2 of 2");
    assert.equal(elements.get("#connection-duration").textContent, "42 ms");
    assert.equal(elements.get("#connection-failure").textContent, "Live WebSocket connection failed.");
    runInNewContext(`new ConnectionController().render("unconfigured");`, context);
    assert.equal(elements.get("#hosted-mode-input").checked, true);
    assert.equal(elements.get("#direct-mode-input").checked, false);
    assert.equal(elements.get("#connection-connect-button").disabled, true);
    assert.equal(elements.get("#connection-connect-button").textContent, "Retry Live");
    assert.equal(elements.get("#connection-endpoint").textContent, "Not configured");
});

for (const departure of ["local", "pagehide"]) {
    for (const outcome of ["success", "failure"]) {
        test(`Home cancels a pending socket on ${departure} and ignores late ${outcome}`, async (t) => {
            const state = { redirects: [], mode: null, modeHandler: null, pagehide: null };
            class FakeHomeController {
                async initialize() {}
                renderYear() {}
                setModeHandler(handler) { state.modeHandler = handler; }
                setRoomHandler() {}
                selectMode(mode) { state.mode = mode; }
                setSession() {}
            }
            class LocalHost {
                accept() { return { close() {} }; }
                shutdown() {}
            }
            const network = installLiveSockets(t, {});
            const source = readFileSync(new URL("../../ui/Session.js", import.meta.url), "utf8")
                .replace(/^import .+;\n/gm, "")
                .replace('await import("./controllers/HomeController.js")', '{HomeController: FakeHomeController}')
                .replaceAll("export ", "");
            const context = {
                URL, URLSearchParams, AbortController, structuredClone, queueMicrotask, setTimeout, clearTimeout,
                Constants, HostedClient, FakeHomeController, Host: LocalHost,
                ValidationUtils: { requiredString(value) { return value; } },
                SessionState: {
                    getMode() { return "direct"; }, takeNotice() { return null; },
                    setMode() {}, getHostedUrl() { return "https://server.test/"; }
                },
                location: { href: "https://example.test/pick-2/index.html", assign(url) { state.redirects.push(url); } },
                history: { replaceState() {} },
                window: { addEventListener(_name, handler) { state.pagehide = handler; } },
            };
            await runInNewContext(`(async function () { ${source};
                await new HomeSession(new URL("https://example.test/pick-2/room.html")).start(); })()`, context);
            state.modeHandler("hosted");
            const socket = network.sockets[0];
            assert.equal(socket.readyState, 0);
            if (departure === "local") state.modeHandler("direct");
            else state.pagehide();
            assert.equal(socket.readyState, 3);
            if (outcome === "success") {
                socket.emit("message", { data: JSON.stringify({ type: "ready", service: "pick-2", version: 2, token: "a".repeat(43) }) });
            } else socket.emit("error", {});
            await new Promise(function flush(resolve) { setImmediate(resolve); });
            assert.deepEqual(state.redirects, []);
            if (departure === "local") assert.equal(state.mode, "direct");
            state.pagehide();
        });
    }
}
