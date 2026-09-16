"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PageState } from "../ui/PageState.js";

/** Installs the browser values used by PageState and restores them afterward. */
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

test("PageState normalizes configured and current Network hosts", () => {
    useBrowserState("", () => {
        assert.equal(PageState.getModePreference(), null);
        assert.equal(PageState.getMode(), "direct");
        assert.equal(PageState.getConfiguredServerOrigin(), null);
        assert.equal(PageState.getCurrentHostUrl(), "wss://example.test/");
        assert.equal(PageState.getHostedUrl(), "wss://example.test/");
    });

    const cases = new Map([
        ["http://server.test:8080/game?old=1#part", "ws://server.test:8080/"],
        ["https://server.test/game", "wss://server.test/"],
        ["ws://server.test/socket", "ws://server.test/"],
        ["wss://server.test/socket", "wss://server.test/"]
    ]);

    for (const [origin, expectedUrl] of cases) {
        useBrowserState(`  ${origin}  `, () => {
            assert.equal(PageState.getConfiguredServerOrigin(), origin.trim());
            assert.equal(PageState.getHostedUrl(), expectedUrl);
        });
    }

    useBrowserState("ftp://server.test", () => {
        assert.throws(() => PageState.getHostedUrl(), /Unsupported server protocol/);
    });
});

test("PageState stores and clears a verified Network host", () => {
    useBrowserState("https://server.test", () => {
        PageState.setHostedUrl("wss://direct.test/");
        assert.equal(PageState.getHostedUrl(), "wss://direct.test/");
        PageState.clearHostedUrl();
        assert.equal(PageState.getHostedUrl(), "wss://server.test/");
    });
});

test("the embedded Network view checks configured and current hosts", () => {
    const homeHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const main =
        readFileSync(new URL("../index.js", import.meta.url), "utf8") +
        readFileSync(new URL("../ui/GameApplication.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../runtime/Network.js", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../ui/styles/home.css", import.meta.url), "utf8");
    const controller = readFileSync(
        new URL("../ui/controllers/NetworkConnectionController.js", import.meta.url),
        "utf8"
    );
    const networkClient = readFileSync(new URL("../runtime/NetworkClient.js", import.meta.url), "utf8");
    const headerPattern =
        /<header id="app-header">\s*<h1>\s*<a id="app-home-link"[\s\S]*?<span class="brand-mark"[\s\S]*?<span class="brand-copy"[^>]*>[\s\S]*?<\/h1>\s*<aside\s+[^>]*data-status="connecting"/;
    const footerPattern =
        /<footer id="app-footer">[\s\S]*?id="app-footer-brand"[\s\S]*?id="app-footer-navigation"[\s\S]*?id="app-footer-note"/;

    assert.match(homeHtml, headerPattern);
    assert.match(homeHtml, footerPattern);
    assert.equal(homeHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(homeHtml.match(/id="app-footer"/g)?.length, 1);
    assert.match(homeHtml, /id="home-view"/);
    assert.match(homeHtml, /id="network-connection-view"[^>]+hidden/);
    assert.match(
        homeHtml,
        /id="network-connection-view"[\s\S]*?id="network-connection-message"[\s\S]*?id="network-connection-origin"/
    );
    assert.match(homeHtml, /id="network-connection-form"/);
    assert.match(homeHtml, /id="network-connection-origin"[^>]*type="url"/);
    assert.match(homeHtml, /id="network-connection-connect-button" type="submit"/);
    assert.doesNotMatch(homeHtml, /network-connection-(?:retry|use-host)-button/);
    assert.doesNotMatch(homeHtml, /id="hosted-mode-input"[^>]+disabled/);
    assert.match(main, /new NetworkConnectionController\(\)/);
    assert.match(main, /DomUtils\.hide\(this\.#homeView\)/);
    assert.match(main, /networkController\.show\(\)/);
    assert.match(main, /history\.replaceState\(null, "", url\)/);
    assert.doesNotMatch(main, /new NetworkStatus/);
    assert.doesNotMatch(main, /new URL\("network\//);
    assert.doesNotMatch(network, /network\/index\.html/);
    assert.match(controller, /this\.#resolveHosts\(\);[\s\S]*?NetworkConnectionController\.#check\(networkUrl\)/);
    assert.match(controller, /getConfiguredServerOrigin\(\)/);
    assert.match(controller, /PageState\.getCurrentHostUrl\(\)/);
    assert.match(controller, /#form\.addEventListener\("submit"/);
    assert.match(controller, /PageState\.resolveHostedUrl\(origin\)/);
    assert.doesNotMatch(controller, /#(?:retryButton|useHostButton)/);
    assert.match(controller, /new WebSocket\(this\.#networkUrl\)/);
    assert.match(controller, /Constants\.NETWORK_CONNECTION_TIMEOUT_MS/);
    assert.match(controller, /this\.#connectedHandler\?\.\(networkUrl\)/);
    assert.match(main, /#networkController\.setConnectedHandler\(this\.#handleHostedConnected\.bind\(this\)\)/);
    assert.match(main, /PageState\.setHostedUrl\(networkUrl\)/);
    assert.match(main, /this\.#selectHosted\(true\)/);
    assert.match(main, /fallbackToDirect && !isAvailable/);
    assert.match(controller, /return false;/);
    assert.match(main, /statusHandler = this\.#handleNetworkStatus\.bind/);
    assert.match(main, /dataHandler = this\.#handleNetworkData\.bind/);
    assert.match(main, /view !== Constants\.VIEWS\.HOME/);
    assert.match(styles, /#network-connection-title\s*\{[\s\S]*?color:\s*var\(--connection-accent\)/);
    assert.match(styles, /#network-connection-title::before\s*\{[\s\S]*?display:\s*block/);
    assert.match(
        styles,
        /#network-connection-view\[data-status="error"\][\s\S]*?#network-connection-title::before\s*\{[\s\S]*?content:/
    );
    assert.match(
        styles,
        /#network-connection-view\[data-status="connecting"\][\s\S]*?#network-connection-message::before\s*\{[\s\S]*?content:/
    );
    assert.match(styles, /#network-connection-view\[data-status="reconnecting"\][\s\S]*?content:/);
    assert.match(styles, /#network-connection-view\[data-status="disconnected"\][\s\S]*?content:/);
    assert.match(controller, /this\.#messageOutput\.dataset\.detail/);
    assert.match(styles, /\.network-connection-field\s*\{[\s\S]*?display:\s*grid;/);
    assert.match(networkClient, /isReconnecting \? "reconnecting" : "connecting"/);
    assert.match(networkClient, /#events\.status\?\.\("reconnecting", "Reconnecting…"\)/);
    assert.match(
        styles,
        /\[data-status="connecting"\][\s\S]*?\[data-status="reconnecting"\][\s\S]*?#network-connection-indicator[\s\S]*?animation:\s*network-connection-pulse/
    );
    assert.match(
        styles,
        /#network-connection-view\[data-status="reconnecting"\]\s*\{[\s\S]*?--connection-accent:\s*var\(--orange\)/
    );
    assert.doesNotMatch(styles, /box-shadow:\s*[^;]*0\s+0\s+0\s+25px/);
    assert.doesNotMatch(
        styles,
        /\[data-status="(?:connected|disconnected)"\][^{]*#network-connection-indicator\s*\{[^}]*animation:/
    );
    assert.doesNotMatch(main + controller, /markNetworkReady|takeNetworkReady/);
    assert.doesNotMatch(controller, /location\.(?:assign|replace)\(/);
});
