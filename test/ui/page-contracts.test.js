"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { elements, elementById } from "../helpers/html.js";
import { readFileSync } from "node:fs";
import { Constants } from "../../core/Constants.js";
import { Session } from "../../ui/Session.js";
import { Host } from "../../host/Host.js";

const homeHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const roomHtml = readFileSync(new URL("../../room.html", import.meta.url), "utf8");

for (const [name, html] of [["Home", homeHtml], ["Room", roomHtml]]) {
    test(`${name} has shared page landmarks, assets, FAQ, and dialogs`, () => {
        for (const id of ["site-shell", "app-header", "app-footer", "app-home-link", "alert-dialog", "alert-title", "alert-message", "alert-ok-button"]) {
            assert.ok(elementById(html, id), `${name}: missing ${id}`);
            assert.equal(elements(html, "[a-z][\\w-]*").filter(element => element.id === id).length, 1);
        }
        assert.equal(elementById(html, "app-home-link").href.replace(/^\.\//, ""), "index.html");
        assert.ok(elements(html, "script").some(script => script.src === "main.js"));
        const styles = elements(html, "link").filter(link => link.rel === "stylesheet").map(link => link.href.replace(/^\.\//, ""));
        for (const stylesheet of ["base.css", "table.css", "dialogs.css", "playing-card.css"]) {
            assert.ok(styles.includes(`ui/styles/${stylesheet}`));
        }
        assert.ok(styles.indexOf("ui/styles/table.css") < styles.indexOf(`ui/styles/${name.toLowerCase()}.css`));
        const faq = elementById(html, `${name.toLowerCase()}-faq`);
        assert.ok(faq);
        assert.equal(faq["aria-labelledby"], "faq-title");
        assert.equal(faq.open, undefined);
    });
}

test("Home exposes registration, room directory, and connection choices", () => {
    for (const id of ["registration-form", "list-table-body", "empty-row", "request-mode-control", "list-panel", "card-fan"]) {
        assert.ok(elementById(homeHtml, id), id);
    }
    for (const mode of ["direct", "hosted"]) {
        const input = elementById(homeHtml, `${mode}-mode-input`);
        assert.equal(input.type, "radio");
        assert.equal(input.value, mode);
        assert.equal(input.name, "connection-mode");
    }
    const connectionMode = elements(homeHtml, "aside").find(element => element["data-connection-status"]);
    assert.equal(connectionMode["data-connection-status"], "connecting");
    assert.equal(connectionMode.class, "toggle-switch");
    assert.equal(elementById(homeHtml, "request-mode-control").role, "radiogroup");
    assert.equal(elementById(homeHtml, "list-panel").hidden, undefined);
});

test("Room exposes membership, player state, drop area, and accessible player list", () => {
    assert.ok(elements(roomHtml, "[a-z][\\w-]*").some(element => element["data-membership"] === "viewer"));
    assert.equal(elementById(roomHtml, "player-commands")["data-match-state"], "active");
    assert.equal(elementById(roomHtml, "local-player-region")["data-player-state"], "ready");
    for (const id of ["player-hand", "player-summary", "table-play-area", "placeholder-row"]) assert.ok(elementById(roomHtml, id), id);
    assert.ok(elements(roomHtml, "span").some(element => element.class === "playing-card-area" && element["data-is-drag-over"] === "false"));
    assert.equal(elementById(roomHtml, "players-list")["aria-label"], "Other players");
    assert.equal(elementById(roomHtml, "players-list").role, undefined);
    assert.ok(roomHtml.indexOf('id="players-list"') < roomHtml.indexOf('id="table-play-area"'));
    assert.ok(roomHtml.indexOf('id="table-play-area"') < roomHtml.indexOf('id="local-player-region"'));
});

test("the finished dialog opens once per finish and clears for a new game", () => {
    const controller = readFileSync(new URL("../../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const playerController = readFileSync(
        new URL("../../ui/controllers/LocalPlayerController.js", import.meta.url),
        "utf8"
    );
    const resultsController = readFileSync(new URL("../../ui/controllers/ResultsController.js", import.meta.url), "utf8");

    assert.match(
        controller,
        /previousState !== Constants\.ROOM_STATE\.FINISHED[\s\S]*?nextState === Constants\.ROOM_STATE\.FINISHED[\s\S]*?#resultsController\.show\(room\)/
    );
    assert.match(
        controller,
        /nextState !== Constants\.ROOM_STATE\.FINISHED[\s\S]*?#resultsController\.hide\(\)/
    );
    assert.match(
        resultsController,
        /hide\(\)\s*\{[\s\S]*?#players = \[\];[\s\S]*?#statsBody\.replaceChildren\(\);[\s\S]*?#selectedPlayerItems\.replaceChildren\(\);[\s\S]*?super\.hide\(\)/
    );
    assert.match(
        controller,
        /ROOM_STATE\.WAITING \|\|[\s\S]*?ROOM_STATE\.FINISHED && !match\.isKnockout[\s\S]*?return true;/
    );
    assert.doesNotMatch(controller, /#handleCardReturn|COMMANDS\.RETURN/);
});

test("Start offers ordered match choices and room tables expose knockout mode", () => {
    const buttons = elements(roomHtml, "button");
    const one = buttons.findIndex(button => button.id === "play-one-button");
    const knockout = buttons.findIndex(button => button.id === "play-knockout-button");
    assert.ok(one >= 0 && knockout > one);
    for (const id of ["play-one-button", "play-knockout-button"]) {
        const button = elementById(roomHtml, id);
        assert.equal(button.class, "play-choice");
        assert.equal(button.type, "button");
    }
    assert.match(roomHtml, /One match/);
    assert.match(roomHtml, /Knockout/);
    for (const html of [homeHtml, roomHtml]) assert.match(html, /<th scope="col">Knockout<\/th>/);
    const rowHtml = readFileSync(new URL("../../ui/templates/room-row.html", import.meta.url), "utf8");
    assert.ok(elements(rowHtml, "td").some(cell => cell["data-knockout"] === "no"));
});
