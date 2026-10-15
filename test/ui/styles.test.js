"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { elementById } from "../helpers/html.js";
import { readFileSync } from "node:fs";

const OVERLAYS_CSS = readFileSync(new URL("../../ui/styles/dialogs.css", import.meta.url), "utf8");

test("the shared table stylesheet owns foundational row states", () => {
    const baseCss = readFileSync(new URL("../../ui/styles/base.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../../ui/styles/home.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../../ui/styles/room.css", import.meta.url), "utf8");
    const overlaysCss = readFileSync(new URL("../../ui/styles/dialogs.css", import.meta.url), "utf8");
    const tableCss = readFileSync(new URL("../../ui/styles/table.css", import.meta.url), "utf8");
    assert.doesNotMatch(baseCss, /^(?:table|th|td|tbody tr|\.table-container)\b/m);
    for (const componentCss of [homeCss, gameCss, overlaysCss]) {
        assert.doesNotMatch(componentCss, /\b(?:th|td)\s*\{[^}]*\bborder(?:-\w+)?:/);
        assert.doesNotMatch(
            componentCss,
            /tbody tr(?::is\([^)]*\)|:(?:hover|focus-visible)|\[aria-selected="true"\])\s*\{/
        );
    }
    assert.match(tableCss, /table:has\(> tbody:empty\)::after\s*\{/);
    assert.match(
        tableCss,
        /tr\s*\{[\s\S]*?border-top:\s*var\(--table-data-border\)/
    );
    assert.match(
        tableCss,
        /tbody tr:is\(:hover, :focus-visible\)\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--cyan\) 12%, transparent\)/
    );
    assert.match(tableCss, /tbody tr:focus-visible\s*\{[\s\S]*?outline-offset:\s*-3px/);
    assert.match(tableCss, /tbody tr\[aria-selected="true"\]\s*\{\s*color:\s*var\(--cyan\);\s*\}/);
    assert.match(
        tableCss,
        /th\s*\{[\s\S]*?color:\s*var\(--gray\);[\s\S]*?letter-spacing:\s*0\.1em;[\s\S]*?text-transform:\s*uppercase;/
    );
    assert.doesNotMatch(
        homeCss + gameCss + overlaysCss,
        /--table-heading-(?:color|font-size|font-weight|letter-spacing)/
    );
});

test("responsive styles are mobile-first with one tablet and desktop stage", () => {
    const styleNames = ["../../ui/styles/base.css", "../../ui/styles/home.css", "../../ui/styles/faq.css"];
    for (const styleName of styleNames) {
        const css = readFileSync(new URL(styleName, import.meta.url), "utf8");
        assert.doesNotMatch(css, /@media\s*\(max-width:/);
        assert.equal(css.match(/@media\s*\(min-width:\s*721px\)/g)?.length, 1);
    }
    const html = ["../../room.html"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    const baseCss = readFileSync(new URL("../../ui/styles/base.css", import.meta.url), "utf8");
    assert.doesNotMatch(html, /styles\/(?:tokens|app-footer|app-header)\.css/);
    assert.match(baseCss, /:root\s*\{[\s\S]*?--container-spacing:/);
    assert.match(baseCss, /#app-header\s*\{/);
    assert.match(baseCss, /#app-footer\s*\{/);
});

test("the shared game preserves touch-friendly card presentation", () => {
    const html = readFileSync(new URL("../../room.html", import.meta.url), "utf8");
    const cardCss =
        readFileSync(new URL("../../ui/styles/playing-card.css", import.meta.url), "utf8") +
        readFileSync(new URL("../../ui/styles/room.css", import.meta.url), "utf8");
    const gameCss = readFileSync(new URL("../../ui/styles/room.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../../ui/styles/home.css", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../../ui/controllers/LocalPlayerController.js", import.meta.url), "utf8");
    assert.match(controller, /"#player-hand > \.playing-card-area", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-player-name\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-item-count\]", HTMLSpanElement/);
    assert.match(controller, /this\.root, "\[data-draw-allowance\]", HTMLSpanElement/);
    assert.match(controller, /querySelector\("\[data-idle-seconds\]"\)/);
    assert.doesNotMatch(controller, /"#player-status"|"#draw-button > span"|"#player-idle-warning > em"/);
    assert.doesNotMatch(html, /id="card-size-range"/);
    assert.match(cardCss, /--card-height:\s*max\(100cqh, var\(--card-height-min\)\)/);
    assert.match(cardCss, /\.playing-card-drag-handle\s*\{[\s\S]*?width:\s*100%/);
    assert.match(gameCss, /@keyframes turn-owner-border-strobe/);
    assert.match(homeCss, /\.toggle-switch > label:has\(input:checked\) > span/);
    assert.doesNotMatch(html + controller + gameCss, /data-has-local-player|hasLocalPlayer/);
    assert.match(controller, /this\.#playerStatus\.dataset\.playerName = player\.name \?\? ""/);
    assert.match(controller, /this\.#playerStatus\.dataset\.playerName = ""/);
    assert.doesNotMatch(html + controller + gameCss, /data-is-player-view|isPlayerView/);
    assert.match(html, /id="players-list"[\s\S]*?id="table-play-area"[\s\S]*?id="local-player-region"/);
    assert.equal(elementById(html, "players-list")["aria-label"], "Other players");
    assert.match(html, /ui-fixture/);
    assert.doesNotMatch(html, /id="players-list"[^>]*role=/);
    assert.match(
        readFileSync(new URL("../../ui/templates/player.html", import.meta.url), "utf8"),
        /<li[^>]* data-player-name=/
    );
    assert.doesNotMatch(
        readFileSync(new URL("../../ui/templates/player.html", import.meta.url), "utf8"),
        /role="listitem"/
    );
    assert.match(gameCss, /\[data-membership="viewer"\] #game-region\s*\{[\s\S]*?--play-area-rows:/);
    assert.match(gameCss, /\[data-membership="viewer"\] #game-region > #local-player-region,[\s\S]*?\{\s*display:\s*none/);
    assert.doesNotMatch(gameCss, /\[data-membership="viewer"\] #game-region[^{]*#table-play-area[^{]*\{[^}]*--card-height/);
    assert.match(gameCss, /main\[data-connection-mode="direct"\] #game-region > #local-player-region #player-idle-warning/);
    assert.match(
        readFileSync(new URL("../../ui/controllers/RoomController.js", import.meta.url), "utf8"),
        /dataset\.connectionMode = room\.connectionMode/
    );
    assert.doesNotMatch(
        readFileSync(new URL("../../ui/controllers/RoomController.js", import.meta.url), "utf8"),
        /idleWarning\.hidden/
    );
    assert.doesNotMatch(controller, /#local-player|isTurnBound/);
});

test("the countdown strobes its box shadow and respects reduced motion", () => {
    assert.match(
        OVERLAYS_CSS,
        /#countdown-value\s*\{[\s\S]*?animation:\s*countdown-box-shadow-strobe 1s ease-in-out infinite/
    );
    assert.match(OVERLAYS_CSS, /@keyframes countdown-box-shadow-strobe/);
    assert.match(
        OVERLAYS_CSS,
        /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?#countdown-value[\s\S]*?animation:\s*none/
    );
});

test("dialog panels size within a shrinkable overlay grid column", () => {
    assert.match(OVERLAYS_CSS, /\.dialog-overlay\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(OVERLAYS_CSS, /\.dialog-panel\s*\{[^}]*width:\s*fit-content/);
    assert.match(OVERLAYS_CSS, /\.dialog-panel\s*\{[^}]*min-width:\s*min\(271px, 100%\)/);
    assert.match(OVERLAYS_CSS, /\.dialog-panel\s*\{[^}]*max-width:\s*min\(94vw, 100%\)/);
});
