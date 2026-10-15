"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../../core/Constants.js";
import { StateMapper } from "../../core/StateMapper.js";

test("StateMapper builds immutable response, message, Home, and detailed Game payloads", () => {
    const message = StateMapper.toMessage(Constants.STATUS.INFO, "Ready", "Take your turn.");
    const response = StateMapper.toResponse(Constants.VIEWS.ROOM, message, { version: 1 });
    const state = {
        name: "Mapped Room",
        playerLimit: 4,
        createdAt: "invalid",
        lastActiveAt: 0,
        viewers: ["one", "two"],
        match: {
            state: Constants.ROOM_STATE.ACTIVE,
        turnOrder: {
            playerCount: 1,
            ownerKey: "alice",
            direction: 1,
            players: [
                {
                    key: "alice",
                    name: "Alice",
                    collection: {
                        penalty: 5,
                        sortKey: Constants.CARD.SORT_OPTIONS[0],
                        items: [{ value: "5", suit: "clubs", rank: 5, rotation: 10 }]
                    },
                    drawAllowance: 2,
                    state: Constants.PLAYER_STATE.WON,
                    ws: {}
                }
            ]
        },
        collections: {
            play: { items: [{ value: "3", suit: "hearts", rank: 3, rotation: 20 }] },
            draw: { items: [{}, {}] }
        },
        pending: { command: Constants.COMMANDS.DECLARE, playerKey: "alice" },
        declaredSuit: Constants.CARD.SUIT.SPADES
        }
    };
    const room = { toJSON: () => state };

    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(response), true);
    assert.equal(response.message.title, "Ready");

    const home = StateMapper.toHomeData([room]);
    assert.equal(home.rooms[0].viewers, 2);
    assert.equal(home.rooms[0].match.isKnockout, false);
    assert.equal(Object.hasOwn(home.rooms[0], "state"), false);
    assert.equal(home.rooms[0].createdAt, "");

    const data = StateMapper.toRoomData(room, "Alice");
    assert.equal(Object.hasOwn(data, "turnOrder"), false);
    assert.equal(data.match.state, Constants.ROOM_STATE.ACTIVE);
    assert.equal(data.match.turnOrder.ownerKey, "alice");
    assert.equal(data.match.turnOrder.ownerKey, data.match.turnOrder.players[0].key);
    assert.equal(data.match.turnOrder.players[0].collection.items.length, 1);
    assert.equal(data.match.turnOrder.players[0].collection.penalty, 5);
    assert.equal(data.match.collections.play.items.length, 2);
    assert.deepEqual(data.match.collections.play.items[1], { suit: Constants.CARD.SUIT.SPADES, rotation: 0 });
    assert.equal(data.match.collections.draw.itemCount, 2);
});

test("StateMapper supplies safe defaults for incomplete game state", () => {
    const state = {
        name: "Empty",
        playerLimit: 2,
        createdAt: null,
        lastActiveAt: null,
        viewers: 3,
        match: {
            state: Constants.ROOM_STATE.WAITING,
        turnOrder: null,
        collections: null,
        pending: null,
        declaredSuit: null
        }
    };
    const room = { toJSON: () => state };
    const data = StateMapper.toRoomData(room, null);

    assert.equal(data.match.turnOrder.playerCount, 0);
    assert.equal(data.viewers, 3);
    assert.deepEqual(data.match.turnOrder.players, []);
    assert.deepEqual(data.match.collections.play.items, []);
    assert.equal(Object.hasOwn(data, "winners"), false);
    assert.equal(data.match.collections.draw.itemCount, 0);
    assert.equal(data.match.turnOrder.ownerKey, null);
});
