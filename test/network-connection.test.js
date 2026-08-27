"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ClientStore } from "../src/client/ClientStore.js";

/** Installs the browser values used by ClientStore and restores them afterward. */
function useBrowserState(serverOrigin, callback) {
    const originals = new Map();
    const storage = new Map();
    const values = {
        document: {
            querySelector(selector) {
                return selector === 'meta[name="pick-2-server-origin"]'
                    ? {getAttribute: () => serverOrigin}
                    : null;
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
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
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

test("ClientStore normalizes configured and current Network hosts", () => {
    useBrowserState("", () => {
        assert.equal(ClientStore.getConfiguredServerOrigin(), null);
        assert.equal(ClientStore.getCurrentHostUrl(), "wss://example.test/");
        assert.equal(ClientStore.getNetworkUrl(), "wss://example.test/");
    });

    const cases = new Map([
        ["http://server.test:8080/game?old=1#part", "ws://server.test:8080/"],
        ["https://server.test/game", "wss://server.test/"],
        ["ws://server.test/socket", "ws://server.test/"],
        ["wss://server.test/socket", "wss://server.test/"]
    ]);

    for (const [origin, expectedUrl] of cases) {
        useBrowserState(`  ${origin}  `, () => {
            assert.equal(ClientStore.getConfiguredServerOrigin(), origin);
            assert.equal(ClientStore.resolveNetworkUrl(), expectedUrl);
        });
    }

    useBrowserState("ftp://server.test", () => {
        assert.throws(() => ClientStore.resolveNetworkUrl(), /Unsupported server protocol/);
    });
});

test("ClientStore stores and clears a verified Network host", () => {
    useBrowserState("https://server.test", () => {
        ClientStore.setNetworkUrl("wss://local.test/");
        assert.equal(ClientStore.getNetworkUrl(), "wss://local.test/");
        ClientStore.clearNetworkUrl();
        assert.equal(ClientStore.getNetworkUrl(), "wss://server.test/");
    });
});

test("the embedded Network view checks configured and current hosts", () => {
    const gameHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server/Server.js", import.meta.url), "utf8");
    const styles = readFileSync(
        new URL("../web/shared/styles/pick2-index.css", import.meta.url),
        "utf8"
    );
    const controller = readFileSync(
        new URL("../src/ui/NetworkConnectionController.js", import.meta.url),
        "utf8"
    );
    const transport = readFileSync(
        new URL("../src/client/WebSocketTransport.js", import.meta.url),
        "utf8"
    );
    const headerPattern = /<header id="app-header">\s*<a id="app-home-link"[\s\S]*?<h1 class="brand-mark"[\s\S]*?<aside class="brand-copy">[\s\S]*?<\/a>\s*<aside id="connection-status"/;
    const footerPattern = /<footer id="app-footer">[\s\S]*?id="app-footer-brand"[\s\S]*?id="app-footer-navigation"[\s\S]*?id="app-footer-note"/;

    assert.match(gameHtml, headerPattern);
    assert.match(gameHtml, footerPattern);
    assert.equal(gameHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(gameHtml.match(/id="app-footer"/g)?.length, 1);
    assert.match(gameHtml, /id="game-page-view"/);
    assert.match(gameHtml, /id="network-connection-view"[^>]+hidden/);
    assert.match(
        gameHtml,
        /id="network-connection-view"[\s\S]*?<section>\s*<i id="network-connection-indicator"[\s\S]*?<output id="network-connection-message"/
    );
    assert.match(gameHtml, /id="network-connection-retry-button" hidden>Retry<\/button>/);
    assert.match(gameHtml, /id="network-connection-use-host-button" hidden>Use this host<\/button>/);
    assert.doesNotMatch(gameHtml, /id="network-mode-input"[^>]+disabled/);
    assert.match(main, /new NetworkConnectionController\(\)/);
    assert.match(main, /DomUtils\.hide\(gamePageView\)/);
    assert.match(main, /networkController\.show\(\)/);
    assert.match(main, /history\.replaceState\(null, "", url\)/);
    assert.doesNotMatch(main, /NetworkStatus/);
    assert.doesNotMatch(main, /new URL\("network\//);
    assert.doesNotMatch(server, /network\/index\.html/);
    assert.match(
        controller,
        /this\.#resolveHosts\(\);[\s\S]*?NetworkConnectionController\.#check\(networkUrl\)/
    );
    assert.match(controller, /getConfiguredServerOrigin\(\)/);
    assert.match(controller, /ClientStore\.getCurrentHostUrl\(\)/);
    assert.match(controller, /#retryButton\.addEventListener\("click", \(\) => this\.connect\(this\.#retryUrl\)\)/);
    assert.match(controller, /#useHostButton\.addEventListener\("click", \(\) => this\.connect\(this\.#currentHostUrl\)\)/);
    assert.match(controller, /new WebSocket\(networkUrl\)/);
    assert.match(controller, /Constants\.NETWORK_CONNECTION_TIMEOUT_MS/);
    assert.match(controller, /this\.#connectedHandler\?\.\(networkUrl\)/);
    assert.match(main, /networkController\.setConnectedHandler\(\(networkUrl\) =>/);
    assert.match(main, /ClientStore\.setNetworkUrl\(networkUrl\)/);
    assert.match(main, /nextClient\.setStatusHandler\(\(status\) =>/);
    assert.match(main, /nextClient\.setSyncHandler\(\(view\) =>/);
    assert.match(main, /view !== Constants\.VIEWS\.GAME/);
    assert.match(controller, /reconnecting:[\s\S]*?Reconnecting to the table/);
    assert.match(controller, /disconnected:[\s\S]*?Network disconnected/);
    assert.match(
        styles,
        /#network-connection-view > section\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/
    );
    assert.match(transport, /isReconnecting \? "reconnecting" : "connecting"/);
    assert.match(transport, /this\.onStatus\?\.\("reconnecting", "Reconnecting…"\)/);
    assert.match(
        styles,
        /\[data-status="connecting"\][\s\S]*?\[data-status="reconnecting"\][\s\S]*?#network-connection-indicator[\s\S]*?animation:\s*network-connection-pulse/
    );
    assert.doesNotMatch(
        styles,
        /\[data-status="(?:connected|disconnected)"\][^{]*#network-connection-indicator\s*\{[^}]*animation:/
    );
    assert.doesNotMatch(main + controller, /markNetworkReady|takeNetworkReady/);
    assert.doesNotMatch(controller, /location\.(?:assign|replace)\(/);
});
