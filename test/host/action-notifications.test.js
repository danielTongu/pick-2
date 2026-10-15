"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Host } from "../../host/Host.js";
import { NotificationUtils } from "../../ui/utilities/NotificationUtils.js";
import { createConnection } from "../helpers/host.js";
import { Constants } from "../../core/Constants.js";

for (const mode of ["direct", "hosted"]) {
    test(`${mode} returns action notifications to the initiating player`, async (t) => {
        const host = new Host(mode, 0, false);
        t.after(() => host.shutdown());
        const responses = [];
        const connection = host.accept((response) => responses.push(response), () => {});
        async function request(command, data = {}) {
            responses.length = 0;
            await connection.receive({ command, data: { tabId: "notifications", ...data } });
            return responses.findLast((response) => response.message)?.message;
        }
        const created = await request("create", { roomName: "Notice Room", playerName: "Alice", playerLimit: 2 });
        assert.equal(created.status, "success");
        assert.equal(created.title, "Room created");
        const drawn = await request("draw");
        assert.deepEqual(drawn, { status: "success", title: "+ 1", message: "Card added" });
        assert.deepEqual(NotificationUtils.normalize(drawn), drawn);
        const failed = await request("join", { roomName: "Missing Room", playerName: "Alice" });
        assert.equal(failed.status, "error");
        assert.equal(failed.title, "Join Room");
        assert.match(failed.message, /Room not found/);
        const left = await request("leave");
        assert.equal(left.status, "success");
        assert.equal(left.title, "Left room");
        const guest = createConnection(host, "guest");
        await guest.request("create", { roomName: "Joined Room", playerName: "Bob", playerLimit: 2 });
        const joined = await request("join", { roomName: "Joined Room", playerName: "Alice" });
        assert.deepEqual(joined, { status: "success", title: "Player Joined", message: "Welcome, Alice !!" });
        const viewerResponses = [];
        const viewer = host.accept((response) => viewerResponses.push(response), () => {});
        await viewer.receive({ command: "view", data: { tabId: "viewer", roomName: "Joined Room" } });
        assert.deepEqual(viewerResponses.findLast((response) => response.message)?.message, {
            status: "success", title: "Viewer Entered", message: "Welcome viewer. See FAQ to learn more."
        });
        const started = await request("start");
        assert.equal(started, undefined);
        assert.ok(responses.some((response) => response.data?.match?.state === Constants.ROOM_STATE.ACTIVE));
        const viewerOffset = viewerResponses.length;
        await viewer.receive({ command: "start", data: { tabId: "viewer" } });
        const failedStart = viewerResponses.slice(viewerOffset).findLast((response) => response.message)?.message;
        assert.equal(failedStart.status, "error");
        assert.equal(failedStart.title, "Start Match");
    });
}

test("card additions use a count title and reserve emoji for draw effects", async (t) => {
    const host = new Host("hosted", 0, false);
    t.after(() => host.shutdown());
    for (const [command, state, count, effect] of [
        ["draw", Constants.ROOM_STATE.WAITING, 1, false],
        ["draw", Constants.ROOM_STATE.ACTIVE, 1, false],
        ["draw", Constants.ROOM_STATE.ACTIVE, 2, true],
        ["pass", Constants.ROOM_STATE.ACTIVE, 2, true]
    ]) {
        const room = { match: { state }, perform: async () => Array(count).fill({}) };
        const notice = await host.executeMatchCommand(room, "Alice", command, {});
        assert.equal(notice.status, "success");
        assert.equal(notice.title, `+ ${count}`);
        const detail = `${count === 1 ? "Card" : "Cards"} added`;
        if (effect) {
            assert.ok(["😈", "😂", "😝", "🙃", "🤪"].some((emoji) => notice.message === `${detail} ${emoji}`));
        } else {
            assert.equal(notice.message, detail);
        }
    }
});

test("playing a card identifies its value and suit, including plays that draw cards", async (t) => {
    const host = new Host("hosted", 0, false);
    t.after(() => host.shutdown());
    for (const drawn of [[], [{}]]) {
        const room = { match: { state: Constants.ROOM_STATE.ACTIVE }, perform: async () => drawn };
        const notice = await host.executeMatchCommand(room, "Alice", "discard", { card: { value: "7", suit: "hearts" } });
        assert.deepEqual(notice, { status: "success", title: "Card played", message: "7-hearts" });
    }
});
