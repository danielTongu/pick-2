import assert from "node:assert/strict";
import test from "node:test";
import { Host } from "../../host/Host.js";
import { createConnection, latestGame } from "../helpers/host.js";

/** Keeps boundary tests small while exercising the production registration limit. */
class CapacityHost extends Host {
    static MAX_ROOMS = 6;
}

for (const mode of ["direct", "hosted"]) {
    test(`${mode} caps registered rooms, handles competing creates, and reuses freed capacity`, async t => {
        const host = new CapacityHost(mode, 0, false);
        t.after(() => host.shutdown());
        async function rooms() {
            const observer = createConnection(host);
            const responses = await observer.request("list");
            return responses.findLast(response => response.view === "home").data.rooms;
        }
        const initialCount = (await rooms()).length;
        const creators = [];
        for (let index = 0; index < CapacityHost.MAX_ROOMS - initialCount - 1; index++) {
            const client = createConnection(host, `creator-${index}`);
            const responses = await client.request("create", { roomName: `Room ${index}`, playerName: `Player ${index}`, playerLimit: 2 });
            assert.ok(latestGame(responses));
            creators.push(client);
        }
        const invalid = createConnection(host, "invalid");
        await invalid.request("create", { roomName: "Invalid Player Room", playerName: "!", playerLimit: 2 });
        assert.equal((await rooms()).length, CapacityHost.MAX_ROOMS - 1);

        const competitors = [createConnection(host, "race-one"), createConnection(host, "race-two")];
        const results = await Promise.all(competitors.map((client, index) => client.request("create", {
            roomName: `Final Room ${index}`, playerName: `Final Player ${index}`, playerLimit: 2
        })));
        const notices = results.map(responses => responses.findLast(response => response.message)?.message);
        assert.equal(notices.filter(notice => notice.status === "success").length, 1);
        const rejected = notices.find(notice => notice.status === "error");
        assert.match(rejected.message, new RegExp(`Room limit reached \\(${CapacityHost.MAX_ROOMS}\\)`));
        assert.equal((await rooms()).length, CapacityHost.MAX_ROOMS);

        const guest = createConnection(host, "guest");
        const joined = await guest.request("join", { roomName: "Room 0", playerName: "Guest" });
        assert.equal(latestGame(joined).localPlayerName, "Guest");
        const viewer = createConnection(host, "viewer");
        assert.ok(latestGame(await viewer.request("view", { roomName: "Room 0" })));

        await creators[1].connection.close();
        assert.equal((await rooms()).length, CapacityHost.MAX_ROOMS - 1);
        const replacement = createConnection(host, "replacement");
        assert.ok(latestGame(await replacement.request("create", {
            roomName: "Replacement Room", playerName: "Replacement Player", playerLimit: 2
        })));
        assert.equal((await rooms()).length, CapacityHost.MAX_ROOMS);
    });
}
