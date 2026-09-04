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

test("PageState normalizes configured and current Network hosts", () => {
    useBrowserState("", () => {
        assert.equal(PageState.getConfiguredServerOrigin(), null);
        assert.equal(PageState.getCurrentHostUrl(), "wss://example.test/");
        assert.equal(PageState.getNetworkUrl(), "wss://example.test/");
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
            assert.equal(PageState.getNetworkUrl(), expectedUrl);
        });
    }

    useBrowserState("ftp://server.test", () => {
        assert.throws(() => PageState.getNetworkUrl(), /Unsupported server protocol/);
    });
});

test("PageState stores and clears a verified Network host", () => {
    useBrowserState("https://server.test", () => {
        PageState.setNetworkUrl("wss://local.test/");
        assert.equal(PageState.getNetworkUrl(), "wss://local.test/");
        PageState.clearNetworkUrl();
        assert.equal(PageState.getNetworkUrl(), "wss://server.test/");
    });
});

test("the embedded Network view checks configured and current hosts", () => {
    const homeHtml = readFileSync(new URL("../room.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const network = readFileSync(new URL("../src/runtime/Network.js", import.meta.url), "utf8");
    const styles = readFileSync(
        new URL("../web/shared/styles/home.css", import.meta.url),
        "utf8"
    );
    const controller = readFileSync(
        new URL("../src/ui/NetworkConnectionController.js", import.meta.url),
        "utf8"
    );
    const networkClient = readFileSync(
        new URL("../src/runtime/NetworkClient.js", import.meta.url),
        "utf8"
    );
    const headerPattern = /<header id="app-header">\s*<h1>\s*<a id="app-home-link"[\s\S]*?<span class="brand-mark"[\s\S]*?<span class="brand-copy">[\s\S]*?<\/h1>\s*<aside id="connection-status"/;
    const footerPattern = /<footer id="app-footer">[\s\S]*?id="app-footer-brand"[\s\S]*?id="app-footer-navigation"[\s\S]*?id="app-footer-note"/;

    assert.match(homeHtml, headerPattern);
    assert.match(homeHtml, footerPattern);
    assert.equal(homeHtml.match(/id="app-header"/g)?.length, 1);
    assert.equal(homeHtml.match(/id="app-footer"/g)?.length, 1);
    assert.match(homeHtml, /id="home-view"/);
    assert.match(homeHtml, /id="network-connection-view"[^>]+hidden/);
    assert.match(
        homeHtml,
        /id="network-connection-view"[\s\S]*?<section>\s*<i id="network-connection-indicator"[\s\S]*?<output id="network-connection-message"/
    );
    assert.match(homeHtml, /id="network-connection-retry-button" hidden>Retry<\/button>/);
    assert.match(homeHtml, /id="network-connection-use-host-button" hidden>Use this host<\/button>/);
    assert.doesNotMatch(homeHtml, /id="network-mode-input"[^>]+disabled/);
    assert.match(main, /new NetworkConnectionController\(\)/);
    assert.match(main, /DomUtils\.hide\(this\.#homeView\)/);
    assert.match(main, /networkController\.show\(\)/);
    assert.match(main, /history\.replaceState\(null, "", url\)/);
    assert.doesNotMatch(main, /new NetworkStatus/);
    assert.doesNotMatch(main, /new URL\("network\//);
    assert.doesNotMatch(network, /network\/index\.html/);
    assert.match(
        controller,
        /this\.#resolveHosts\(\);[\s\S]*?NetworkConnectionController\.#check\(networkUrl\)/
    );
    assert.match(controller, /getConfiguredServerOrigin\(\)/);
    assert.match(controller, /PageState\.getCurrentHostUrl\(\)/);
    assert.match(controller, /#retryButton\.addEventListener\("click"/);
    assert.match(controller, /#useHostButton\.addEventListener\("click"/);
    assert.match(controller, /new WebSocket\(this\.#networkUrl\)/);
    assert.match(controller, /Constants\.NETWORK_CONNECTION_TIMEOUT_MS/);
    assert.match(controller, /this\.#connectedHandler\?\.\(networkUrl\)/);
    assert.match(main, /#networkController\.setConnectedHandler\(this\.#handleNetworkConnected\.bind\(this\)\)/);
    assert.match(main, /PageState\.setNetworkUrl\(networkUrl\)/);
    assert.match(main, /statusHandler = this\.#handleNetworkStatus\.bind/);
    assert.match(main, /dataHandler = this\.#handleNetworkData\.bind/);
    assert.match(main, /view !== Constants\.VIEWS\.HOME/);
    assert.match(controller, /reconnecting:[\s\S]*?Reconnecting to the table/);
    assert.match(controller, /disconnected:[\s\S]*?Network disconnected/);
    assert.match(
        styles,
        /#network-connection-view > section\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/
    );
    assert.match(networkClient, /isReconnecting \? "reconnecting" : "connecting"/);
    assert.match(networkClient, /#events\.status\?\.\("reconnecting", "Reconnecting…"\)/);
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
