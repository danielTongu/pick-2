import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Constants } from "../core/Constants.js";

const mainSource = readFileSync(new URL("../main.js", import.meta.url), "utf8")
    .replace(/^import .+;\n/gm, "");

test("Home and Room remove every preview fixture before opening a real session", async () => {
    for (const page of ["home", "room"]) {
        const dataset = {page, uiPreview: "true"};
        const fixtures = [{removed: false}, {removed: false}];
        for (const fixture of fixtures) fixture.remove = function () { this.removed = true; };
        let started = false;
        const errors = [];
        class Session {
            async start() {
                assert.equal(dataset.uiPreview, "false");
                assert.ok(fixtures.every(fixture => fixture.removed));
                started = true;
            }
        }
        await runInNewContext(`(async function () { ${mainSource} })()`, {
            HomeSession: Session, RoomSession: Session, ConnectionSession: Session,
            Constants, URL,
            document: {body: {dataset}, baseURI: "https://example.test/index.html", querySelectorAll() {return fixtures;}},
            location: {href: "https://example.test/room.html"},
            window: {addEventListener() {}},
            console: {error(...args) {errors.push(args);}}
        });
        assert.equal(started, true);
        assert.deepEqual(errors, []);
    }
});

test("Room membership changes without duplicate permission attributes", () => {
    const source = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");
    const start = source.indexOf("    renderMatchCommands(localPlayer) {");
    const end = source.indexOf("    /**", start);
    const Controller = new Function(`return class {${source.slice(start, end)}}`)();
    const controller = new Controller();
    controller.root = {dataset: {}};
    controller.capabilities = {join: true, invite: false};
    controller.renderMatchCommands(null);
    assert.deepEqual(controller.root.dataset, {membership: "viewer"});
    controller.capabilities = {join: false, invite: true};
    controller.renderMatchCommands("Alice");
    assert.deepEqual(controller.root.dataset, {membership: "player"});
});
