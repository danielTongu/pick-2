"use strict";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Card } from "../core/Card.js";
import { Constants } from "../core/Constants.js";

const root = new URL("../", import.meta.url);

function metadataContent(html, identityName, identityValue) {
    return (
        html.match(new RegExp(`<meta\\s+${identityName}="${identityValue}"\\s+content="([^"]+)"\\s*\\/>`))?.[1] ?? null
    );
}

function linkTarget(html, relationship) {
    return html.match(new RegExp(`<link\\s+rel="${relationship}"\\s+href="([^"]+)"\\s*\\/>`))?.[1] ?? null;
}

test("the root page is the playable Pick 2 Home", () => {
    const html = readFileSync(new URL("index.html", root), "utf8");
    assert.match(html, /<body data-game="pick2" data-page="home">/);
    assert.match(html, /<main class="site-shell">/);
    assert.match(html, /src="index.js"/);
    assert.doesNotMatch(html, /game-tile|Coming soon|Poker|Yahtzee|Dice Games/);
    for (const match of html.matchAll(/<playing-card data-value="([^"]+)" data-suit="([^"]+)"/g)) {
        assert.doesNotThrow(() => new Card(match[1], match[2], 0));
    }
});

test("indexable pages expose aligned search, social, canonical, and structured metadata", () => {
    const pages = [["index.html", "https://danieltongu.github.io/pick-2/"]];

    for (const [page, canonicalUrl] of pages) {
        const html = readFileSync(new URL(page, root), "utf8");
        const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
        const description = metadataContent(html, "name", "description");
        const structuredData = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)?.[1];

        assert.ok(title, `${page}: missing title`);
        assert.ok(description, `${page}: missing description`);
        assert.equal(linkTarget(html, "canonical"), canonicalUrl);
        assert.equal(metadataContent(html, "property", "og:url"), canonicalUrl);
        assert.equal(metadataContent(html, "property", "og:title"), title);
        assert.equal(metadataContent(html, "name", "twitter:title"), title);
        assert.equal(metadataContent(html, "property", "og:description"), description);
        assert.equal(metadataContent(html, "name", "twitter:description"), description);
        assert.equal(JSON.parse(structuredData).url, canonicalUrl);
    }
});

test("the dynamic Room is excluded from search indexing and the sitemap", () => {
    const html = readFileSync(new URL("room.html", root), "utf8");
    const sitemap = readFileSync(new URL("sitemap.xml", root), "utf8");

    assert.equal(metadataContent(html, "name", "robots"), "noindex, nofollow");
    assert.doesNotMatch(html, /rel="canonical"/);
    assert.doesNotMatch(sitemap, /room\.html/);
});

test("Home and Room resolve their local assets and navigation under a subdirectory", () => {
    for (const page of ["index.html", "room.html"]) {
        const html = readFileSync(new URL(page, root), "utf8");
        for (const [, target] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
            if (/^(?:https?:|#)/.test(target)) continue;
            assert.ok(existsSync(new URL(target, new URL(page, root))), `${page}: missing ${target}`);
            const url = new URL(target, `https://example.test/pick-2/${page}`);
            assert.ok(url.pathname.startsWith("/pick-2/"), `${page}: lost base path`);
        }
    }
    const home = readFileSync(new URL("index.html", root), "utf8");
    assert.equal(home.match(/id="app-footer-navigation"/g)?.length, 1);
    assert.match(home, /rel="canonical" href="https:\/\/danieltongu.github.io\/pick-2\/"/);
});

/** Runs the real page entry point with a controlled transport and browser location. */
async function startRoomPage(basePath, mode, validIntent) {
    const state = { redirects: [], errors: [], cleared: false, closed: false, notice: null };
    let homeHandler;
    class FakeRoomController {
        setClient() {}
        setIntent() {}
        setReadyHandler() {}
        setHomeHandler(handler) {
            homeHandler = handler;
        }
        async initialize() {}
    }
    class FakeClient {
        open() {}
        close() {
            state.closed = true;
        }
    }
    const context = {
        Constants,
        URL,
        URLSearchParams,
        renderYear() {},
        document: { body: { dataset: { page: "room" } } },
        location: {
            href: `https://example.test${basePath}room.html?mode=${mode}`,
            search: `?mode=${mode}`,
            assign(url) {
                state.redirects.push({ method: "assign", url });
            },
            replace(url) {
                state.redirects.push({ method: "replace", url });
            }
        },
        window: { addEventListener() {} },
        console: {
            error(...args) {
                state.errors.push(args);
            }
        },
        PageState: {
            getMode() {
                return mode;
            },
            getIntent() {
                return validIntent ? { mode, command: Constants.COMMANDS.JOIN, data: { roomName: "Test" } } : null;
            },
            getHostedUrl() {
                return "wss://example.test/";
            },
            clearIntent() {
                state.cleared = true;
            },
            setNotice(notice) {
                state.notice = notice;
            }
        },
        ClientEvents: class {},
        HTMLElement: class {},
        DomUtils: {},
        NetworkConnectionController: class {}
    };
    const config = {
        createClient() {
            return new FakeClient();
        },
        homeUrl() {
            return new URL(`./index.html?mode=${mode}`, `https://example.test${basePath}`);
        },
        RoomControllerType: FakeRoomController,
        initializeGuide() {}
    };
    const source = readFileSync(new URL("ui/GameApplication.js", root), "utf8")
        .replace(/^import .+;\n/gm, "")
        .replaceAll("export ", "");
    context.config = config;
    await runInNewContext(`(async function () { ${source}; await startGameApplication(config); })()`, context);
    assert.deepEqual(state.errors, []);
    return { state, returnHome: homeHandler };
}

test("room exits, failed admissions, and missing intents return Home with mode and base path intact", async () => {
    for (const basePath of ["/", "/pick-2/"]) {
        for (const mode of ["direct", "hosted"]) {
            const url = `https://example.test${basePath}index.html?mode=${mode}`;
            const invalid = await startRoomPage(basePath, mode, false);
            assert.deepEqual(invalid.state.redirects, [{ method: "replace", url }]);

            const leaving = await startRoomPage(basePath, mode, true);
            leaving.returnHome(null);
            assert.deepEqual(leaving.state.redirects, [{ method: "assign", url }]);
            assert.equal(leaving.state.cleared, true);
            assert.equal(leaving.state.closed, true);

            const failed = await startRoomPage(basePath, mode, true);
            const notice = { status: "error", message: "Room not found" };
            failed.returnHome(notice);
            assert.deepEqual(failed.state.redirects, [{ method: "replace", url }]);
            assert.equal(failed.state.notice, notice);
            assert.equal(failed.state.cleared, true);
            assert.equal(failed.state.closed, true);
        }
    }
});
