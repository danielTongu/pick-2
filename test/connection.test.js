"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { ViewState } from "../ui/View.js";

/** Installs the browser values used by ViewState and restores them afterward. */
function useBrowserState(serverOrigin, callback) {
    const originals = new Map();
    const storage = new Map();
    const values = {
        document: {
            body: { dataset: { game: "pick2" } },
            querySelector(selector) {
                return selector === 'meta[name="game-server-origin"]' ? { getAttribute: () => serverOrigin } : null;
            }
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
        for (const [key, descriptor] of originals) {
            if (descriptor === undefined) {
                delete globalThis[key];
            } else {
                Object.defineProperty(globalThis, key, descriptor);
            }
        }
    }
}

test("ViewState normalizes configured and current Hosted hosts", () => {
    useBrowserState("", () => {
        assert.equal(ViewState.getModePreference(), null);
        assert.equal(ViewState.getMode(), "direct");
        assert.equal(ViewState.getConfiguredServerOrigin(), null);
        assert.equal(ViewState.getCurrentHostUrl(), "wss://example.test/");
        assert.equal(ViewState.getHostedUrl(), "wss://example.test/");
    });

    const cases = new Map([
        ["http://server.test:8080/game?old=1#part", "ws://server.test:8080/"],
        ["https://server.test/game", "wss://server.test/"],
        ["ws://server.test/socket", "ws://server.test/"],
        ["wss://server.test/socket", "wss://server.test/"]
    ]);

    for (const [origin, expectedUrl] of cases) {
        useBrowserState(`  ${origin}  `, () => {
            assert.equal(ViewState.getConfiguredServerOrigin(), origin.trim());
            assert.equal(ViewState.getHostedUrl(), expectedUrl);
        });
    }

    useBrowserState("ftp://server.test", () => {
        assert.throws(() => ViewState.getHostedUrl(), /Unsupported server protocol/);
    });
    useBrowserState("", () => {
        assert.throws(() => ViewState.resolveHostedUrl("https://user:secret@server.test"), /cannot include credentials/);
    });
});

test("ViewState stores and clears a verified Hosted host", () => {
    useBrowserState("https://server.test", () => {
        ViewState.setHostedUrl("wss://direct.test/");
        assert.equal(ViewState.getHostedUrl(), "wss://direct.test/");
        ViewState.clearHostedUrl();
        assert.equal(ViewState.getHostedUrl(), "wss://server.test/");
    });
});

test("the standalone Connection page verifies Hosted servers", () => {
    const homeHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const connectionHtml = readFileSync(new URL("../connection.html", import.meta.url), "utf8");
    const view = readFileSync(new URL("../ui/View.js", import.meta.url), "utf8");
    const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../ui/styles/connection.css", import.meta.url), "utf8");
    const controller = readFileSync(
        new URL("../ui/controllers/ConnectionController.js", import.meta.url), "utf8"
    );

    assert.doesNotMatch(homeHtml, /id="connection-view"/);
    assert.match(homeHtml, /href="\.\/connection\.html">Connection settings/);
    assert.match(connectionHtml, /<body data-game="pick2" data-page="connection">/);
    assert.match(connectionHtml, /id="connection-view"/);
    assert.match(connectionHtml, /id="connection-form"/);
    assert.match(connectionHtml, /id="connection-origin"[^>]*type="url"/);
    assert.match(connectionHtml, /id="connection-connect-button" type="submit"/);
    assert.match(connectionHtml, /id="connection-direct-link" href="\.\/index\.html\?mode=direct"/);
    assert.match(connectionHtml, /class="connection-actions">[\s\S]*?id="connection-connect-button"[\s\S]*?id="connection-direct-link"[\s\S]*?<\/div>[\s\S]*?<\/form>/);
    assert.match(connectionHtml, /href="\.\/ui\/styles\/connection\.css"/);
    assert.match(main, /new ConnectionView\(homeUrl\)\.start\(\)/);
    assert.match(view, /ViewState\.setHostedUrl\(endpoint\)/);
    assert.match(view, /location\.replace\(this\.#homeUrl\("hosted"\)\)/);
    assert.match(view, /isAutomatic && available === false/);
    assert.match(view, /new URL\("\.\/connection\.html", location\.href\)/);
    assert.match(view, /ViewState\.getCurrentHostUrl\(\)/);
    assert.match(view, /new WebSocket\(this\.#endpoint\)/);
    assert.match(view, /Constants\.CONNECTION_PROBE_TIMEOUT_MS/);
    assert.match(controller, /this\.root\.dataset\.elapsedMs/);
    assert.match(connectionHtml, /id="connection-diagnostics"/);
    assert.match(connectionHtml, /id="connection-endpoint"/);
    assert.match(connectionHtml, /id="connection-duration"/);
    assert.match(view, /#scheduleReconnect\(generation\)/);
    assert.match(styles, /#connection-title\s*\{[\s\S]*?color:\s*var\(--connection-accent\)/);
    assert.match(styles, /#connection-view\[data-status="error"\]/);
    assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 180px\), 1fr\)\)/);
    assert.match(styles, /@media \(max-width: 520px\)/);
    assert.doesNotMatch(styles, /#connection-view\[data-status="connecting"\],\s*#connection-indicator/);
});

test("Connection page navigates on success and only automatically falls back after a real failure", async () => {
    const viewSource = readFileSync(new URL("../ui/View.js", import.meta.url), "utf8");
    const source = viewSource.slice(
        viewSource.indexOf("/** One bounded browser WebSocket availability probe. */"),
        viewSource.indexOf("/** Coordinates Home controllers, transport selection, and Room navigation. */")
    ).replaceAll("export ", "")
        .replace('await import("./controllers/ConnectionController.js")', '{ConnectionController: FakeController}');

    async function run(outcome, search) {
        const state = { redirects: [], mode: null, hostedUrl: null, renders: [] };
        class FakeView { constructor(url) { this.url = url; } }
        class FakeController {
            initialize() {}
            renderYear() {}
            render(status, metrics) { state.renders.push({status, metrics}); }
        }
        class FakeWebSocket {
            constructor() { this.handlers = new Map(); }
            addEventListener(name, handler) {
                this.handlers.set(name, handler);
                if (name === "error" && (outcome === true || outcome === false)) {
                    queueMicrotask(() => this.handlers.get(outcome ? "open" : "error")());
                }
            }
            close() {}
        }
        const context = {
            URL, URLSearchParams,
            setTimeout, clearTimeout,
            View: FakeView,
            FakeController,
            WebSocket: FakeWebSocket,
            Constants: {
                CONNECTION_PROBE_TIMEOUT_MS: 5,
                CONNECTION_STATUS: {CONNECTING: "connecting", CONNECTED: "connected", ERROR: "error", UNCONFIGURED: "unconfigured"}
            },
            ViewState: {
                setMode(mode) { state.mode = mode; },
                setHostedUrl(url) { state.hostedUrl = url; },
                getConfiguredServerOrigin() { return "ws://server.test/"; },
                resolveHostedUrl(url) { return url; },
                getCurrentHostUrl() { return null; }
            },
            location: { search, replace(url) { state.redirects.push(url); } },
            window: { addEventListener(_name, handler) { if (outcome === null) queueMicrotask(handler); } }
        };
        await runInNewContext(
            `(async function () { ${source}; await new ConnectionView(new URL("https://example.test/index.html")).start(); })()`,
            context
        );
        return state;
    }

    const success = await run(true, "?auto=1");
    assert.equal(success.hostedUrl, "ws://server.test/");
    assert.equal(success.mode, "hosted");
    assert.deepEqual(success.redirects, ["https://example.test/index.html?mode=hosted"]);
    assert.equal(success.renders.at(-1).status, "connected");
    assert.equal(success.renders.at(-1).metrics.endpoint, "ws://server.test/");
    assert.equal(typeof success.renders.at(-1).metrics.elapsedMs, "number");

    const failed = await run(false, "?auto=1");
    assert.equal(failed.mode, "direct");
    assert.deepEqual(failed.redirects, ["https://example.test/index.html?mode=direct"]);
    assert.equal(failed.renders.at(-1).metrics.failure, "WebSocket handshake failed.");

    const timedOut = await run("timeout", "");
    assert.match(timedOut.renders.at(-1).metrics.failure, /Timed out after 5 ms/);

    assert.deepEqual((await run(null, "?auto=1")).redirects, []);
    assert.deepEqual((await run(false, "")).redirects, []);
});

test("ConnectionController renders diagnostics as text and data attributes", () => {
    const source = readFileSync(new URL("../ui/controllers/ConnectionController.js", import.meta.url), "utf8")
        .replace(/^import .+;\n/gm, "")
        .replaceAll("export ", "");
    class Element {
        constructor() { this.dataset = {}; this.value = ""; this.textContent = ""; }
        addEventListener(_name, handler) { this.handler = handler; }
        setAttribute(name, value) { this[name] = value; }
    }
    const elements = new Map();
    const context = {
        Constants: {
            CONNECTION_PROBE_TIMEOUT_MS: 3000,
            CONNECTION_STATUS: {CONNECTING: "connecting", CONNECTED: "connected", ERROR: "error", UNCONFIGURED: "unconfigured"}
        },
        DomUtils: {require(selector) {
            if (!elements.has(selector)) elements.set(selector, new Element());
            return elements.get(selector);
        }},
        ViewController: class {constructor(selector) {this.root = context.DomUtils.require(selector);}},
        HTMLElement: Element, HTMLInputElement: Element, HTMLButtonElement: Element, HTMLFormElement: Element
    };
    runInNewContext(`${source}; new ConnectionController().render("error", {
        endpoint: "wss://example.test/", attempt: 3, candidate: 2, candidateCount: 2,
        elapsedMs: 42, failure: "WebSocket handshake failed."
    });`, context);

    const root = elements.get("#connection-view");
    assert.equal(root.dataset.status, "error");
    assert.equal(root.dataset.endpoint, "wss://example.test/");
    assert.equal(root.dataset.attempt, "3");
    assert.equal(root.dataset.candidate, "2");
    assert.equal(root.dataset.elapsedMs, "42");
    assert.equal(root.dataset.timeoutMs, "3000");
    assert.equal(elements.get("#connection-attempt").textContent, "#3 · candidate 2 of 2");
    assert.equal(elements.get("#connection-duration").textContent, "42 ms");
    assert.equal(elements.get("#connection-failure").textContent, "WebSocket handshake failed.");
});
