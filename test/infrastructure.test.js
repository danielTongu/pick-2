"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CardCollection } from "../core/CardCollection.js";
import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";
import { Serializable } from "../core/Serializable.js";
import { StateMapper } from "../core/StateMapper.js";
import { UserNotification } from "../core/UserNotification.js";
import { RoomRowUtils } from "../ui/utilities/RoomRowUtils.js";
import { RateLimit } from "../runtime/RateLimit.js";
import { NotificationUtils } from "../ui/utilities/NotificationUtils.js";
import { OpponentUtils } from "../ui/utilities/OpponentUtils.js";
import { TemplateUtils } from "../ui/utilities/TemplateUtils.js";

const INDEX_HTML = readFileSync(new URL("../room.html", import.meta.url), "utf8");
const OVERLAYS_CSS = readFileSync(new URL("../ui/styles/dialogs.css", import.meta.url), "utf8");

test("browser controller, custom element, and template utility families share their intended APIs", async () => {
    const OriginalHTMLElement = globalThis.HTMLElement;
    const originalCustomElements = globalThis.customElements;
    const registeredElements = new Map();

    globalThis.HTMLElement = class {};
    globalThis.customElements = {
        define(name, Type) {
            registeredElements.set(name, Type);
        },
        get(name) {
            return registeredElements.get(name);
        }
    };

    try {
        const [
            { AlertController },
            { CountdownController },
            { ResultsController },
            { RoomController },
            { HomeController },
            { LocalPlayerController },
            { NetworkConnectionController },
            { SuitSelectionController },
            { ViewController },
            { PlayingCard }
        ] = await Promise.all([
            import("../ui/controllers/AlertController.js"),
            import("../ui/controllers/CountdownController.js"),
            import("../ui/controllers/ResultsController.js"),
            import("../ui/controllers/RoomController.js"),
            import("../ui/controllers/HomeController.js"),
            import("../ui/controllers/LocalPlayerController.js"),
            import("../ui/controllers/NetworkConnectionController.js"),
            import("../ui/controllers/SuitSelectionController.js"),
            import("../ui/controllers/ViewController.js"),
            import("../ui/PlayingCard.js")
        ]);
        const overlayTypes = [AlertController, CountdownController, ResultsController, SuitSelectionController];
        const viewTypes = [HomeController, NetworkConnectionController, RoomController];
        const playingCardMethods = ["update"];

        for (const Type of overlayTypes) {
            assert.equal(Type.prototype instanceof ViewController, true);
            assert.equal(typeof Type.prototype.show, "function");
            assert.equal(typeof Type.prototype.hide, "function");
        }

        for (const Type of viewTypes) {
            assert.equal(Type.prototype instanceof ViewController, true);
            assert.equal(typeof Type.prototype.initialize, "function");
            assert.equal(typeof Type.prototype.render, "function");
            assert.equal(typeof Type.prototype.show, "function");
            assert.equal(typeof Type.prototype.hide, "function");
        }

        for (const Type of [OpponentUtils, RoomRowUtils]) {
            assert.equal(Type.prototype instanceof TemplateUtils, true);
            assert.equal(typeof Type.load, "function");
            assert.equal(typeof Type.create, "function");
            assert.equal(typeof Type.updateElement, "function");
        }

        for (const method of playingCardMethods) {
            assert.equal(typeof PlayingCard.prototype[method], "function");
        }

        for (const property of ["value", "suit", "rank", "rotation", "isDragging", "isFaceUp"]) {
            const descriptor = Object.getOwnPropertyDescriptor(PlayingCard.prototype, property);
            assert.equal(typeof descriptor.get, "function", property);
            assert.equal(
                typeof descriptor.set,
                ["rotation", "isFaceUp"].includes(property) ? "function" : "undefined",
                property
            );
        }

        assert.equal(LocalPlayerController.prototype instanceof ViewController, true);
            assert.equal(typeof ViewController.prototype.bindDismissButton, "function");
            assert.equal(typeof ViewController.prototype.renderYear, "function");
        assert.equal(PlayingCard.prototype instanceof globalThis.HTMLElement, true);
        assert.equal(registeredElements.get(PlayingCard.elementName), PlayingCard);
        assert.equal(Object.getOwnPropertyDescriptor(PlayingCard.prototype, "card"), undefined);

        const players = [{ name: "Alice" }, { name: "Bob" }, { name: "Casey" }, { name: "Daniel" }];
        assert.deepEqual(
            ResultsController.localFirst(players, "Casey").map(function getName(player) {
                return player.name;
            }),
            ["Casey", "Daniel", "Alice", "Bob"]
        );
        assert.deepEqual(ResultsController.localFirst(players, null), players);
        assert.deepEqual(ResultsController.localFirst(players, "Unknown"), players);
        assert.deepEqual(ResultsController.localFirst(null, "Alice"), []);
    } finally {
        if (OriginalHTMLElement === undefined) {
            delete globalThis.HTMLElement;
        } else {
            globalThis.HTMLElement = OriginalHTMLElement;
        }

        if (originalCustomElements === undefined) {
            delete globalThis.customElements;
        } else {
            globalThis.customElements = originalCustomElements;
        }
    }
});

test("ValidationUtils validates integer categories without coercion", () => {
    assert.equal(ValidationUtils.integer(-2, "Count"), -2);
    assert.equal(ValidationUtils.nonNegativeInteger(0, "Count"), 0);
    assert.equal(ValidationUtils.nonNegativeInteger(3, "Count"), 3);

    assert.throws(() => ValidationUtils.integer(1.5, "Count"), /Count must be an integer/);
    assert.throws(() => ValidationUtils.integer("1", "Count"), /Count must be an integer/);
    assert.throws(() => ValidationUtils.nonNegativeInteger(-1, "Count"), /Count must be a non-negative integer/);
    assert.throws(() => ValidationUtils.nonNegativeInteger(1.5, "Count"), /Count must be a non-negative integer/);
});

test("Serializable handles nested models, dates, arrays, objects, maps, sets, and field filters", () => {
    const child = new Serializable({ value: 2 });
    const model = new Serializable({
        child,
        date: new Date("2026-01-02T03:04:05.000Z"),
        array: [child, new Set([3])],
        object: { child, omitted: undefined, method() {} },
        map: new Map([["child", child]]),
        set: new Set([child]),
        _private: "hidden",
        omitted: undefined,
        method() {}
    });

    assert.deepEqual(model.toJSON(), {
        child: { value: 2 },
        date: "2026-01-02T03:04:05.000Z",
        array: [{ value: 2 }, [3]],
        object: { child: { value: 2 } },
        map: { child: { value: 2 } },
        set: [{ value: 2 }]
    });
    assert.deepEqual(model.toJSON(["child", "date"], ["date"]), { child: { value: 2 } });
});

test("StateMapper builds immutable response, message, Home, and detailed Game payloads", () => {
    const message = StateMapper.toMessage(Constants.STATUS.INFO, "Ready", "Take your turn.");
    const response = StateMapper.toResponse(Constants.VIEWS.ROOM, message, { version: 1 });
    const state = {
        name: "Mapped Room",
        state: Constants.ROOM_STATE.ACTIVE,
        actorLimit: 4,
        createdAt: "invalid",
        lastActiveAt: 0,
        viewers: ["one", "two"],
        turnOrder: {
            actorCount: 1,
            ownerKey: "alice",
            direction: 1,
            actors: [
                {
                    key: "alice",
                    name: "Alice",
                    collection: {
                        penalty: 5,
                        sortKey: Constants.CARD.SORT_OPTIONS[0],
                        items: [{ value: "5", suit: "clubs", rank: 5, rotation: 10 }]
                    },
                    drawAllowance: 2,
                    state: Constants.ACTOR_STATE.WON,
                    ws: {}
                }
            ]
        },
        collections: {
            play: { items: [{ value: "3", suit: "hearts", rank: 3, rotation: 20 }] },
            draw: { items: [{}, {}] }
        },
        winners: ["Alice"],
        pending: { command: Constants.COMMANDS.DECLARE, actorKey: "alice" },
        declaredSuit: Constants.CARD.SUIT.SPADES
    };
    const room = { toJSON: () => state };

    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(response), true);
    assert.equal(response.message.title, "Ready");

    const home = StateMapper.toHomeData([room]);
    assert.equal(home.rooms[0].viewers, 2);
    assert.equal(home.rooms[0].createdAt, "");

    const data = StateMapper.toRoomData(room, "Alice");
    assert.equal(data.turnOrder.ownerKey, "alice");
    assert.equal(data.turnOrder.ownerKey, data.turnOrder.actors[0].key);
    assert.equal(data.turnOrder.actors[0].collection.items.length, 1);
    assert.equal(data.turnOrder.actors[0].collection.penalty, 5);
    assert.equal(data.collections.play.items.length, 2);
    assert.deepEqual(data.collections.play.items[1], { suit: Constants.CARD.SUIT.SPADES, rotation: 0 });
    assert.equal(data.collections.draw.itemCount, 2);
});

test("StateMapper supplies safe defaults for incomplete game state", () => {
    const state = {
        name: "Empty",
        state: Constants.ROOM_STATE.WAITING,
        actorLimit: 2,
        createdAt: null,
        lastActiveAt: null,
        viewers: 3,
        turnOrder: null,
        collections: null,
        winners: null,
        pending: null,
        declaredSuit: null
    };
    const room = { toJSON: () => state };
    const data = StateMapper.toRoomData(room, null);

    assert.equal(data.turnOrder.actorCount, 0);
    assert.equal(data.viewers, 3);
    assert.deepEqual(data.turnOrder.actors, []);
    assert.deepEqual(data.collections.play.items, []);
    assert.deepEqual(data.winners, []);
    assert.equal(data.collections.draw.itemCount, 0);
    assert.equal(data.turnOrder.ownerKey, null);
});

test("RateLimit isolates scopes and supports reset, pruning, and validation", () => {
    const guard = new RateLimit();

    guard.enforceConnection({ tabId: " tab " }, "sync", 1000);
    assert.throws(() => guard.enforceConnection({ tabId: "tab" }, "sync", 1000), UserNotification);

    guard.reset("connection:tab");
    guard.enforceConnection({ tabId: "tab" }, "sync", 1000);
    guard.enforcePlayerThrottle("player-tab", "move", 0);
    guard.enforceRoomThrottle("room-key", "start", 0);
    guard.prune(0);
    guard.resetAll();

    assert.throws(() => guard.enforcePlayerThrottle("", "move", 1), /cannot be empty/);
    assert.throws(() => guard.enforceRoomThrottle("room", "move", -1), /non-negative integer/);
});

test("CardCollection supports every sort mode without mutating the collection", () => {
    const cards = [
        { value: "k", suit: "clubs", rank: 13 },
        { value: "2", suit: "hearts", rank: 20 },
        { value: "5", suit: "diamonds", rank: 5 }
    ];

    const collection = new CardCollection(cards);
    assert.deepEqual(collection.sorted("none"), collection.items);
    assert.notEqual(collection.sorted("none"), collection.items);
    assert.deepEqual(
        collection.sorted("rank").map((card) => card.value),
        ["5", "k", "2"]
    );
    assert.deepEqual(
        collection.sorted("suit").map((card) => card.suit),
        ["clubs", "diamonds", "hearts"]
    );
    assert.throws(() => collection.sorted("score"), /Invalid card sort key/);
    assert.deepEqual(collection.items.map((card) => card.value), ["k", "2", "5"]);
    assert.throws(() => collection.sorted("unknown"), /Invalid card sort key/);
    assert.throws(() => collection.sorted("value"), /Invalid card sort key/);
});

test("the shared FAQ initializes canonical card-sort options", () => {
    const controller = readFileSync(new URL("../ui/controllers/FaqController.js", import.meta.url), "utf8");

    assert.match(INDEX_HTML, /<select id="sort-key-select"><\/select>/);
    assert.match(controller, /Constants\.CARD\.SORT_OPTIONS/);
    assert.match(controller, /PlayingCard\.create\(card\)/);
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

test("FAQ rank cells initialize from canonical card ranks", () => {
    const rankCells = Array.from(
        INDEX_HTML.matchAll(/<td data-card-value="([^"]+)" data-card-suit="([^"]+)">(\d+)<\/td>/g)
    );

    assert.equal(rankCells.length, 8);

    for (const [, value, suit, displayedRank] of rankCells) {
        assert.equal(Number(displayedRank), Constants.getCardRank(value, suit));
    }
});

test("NotificationUtils produces one canonical notification shape", () => {
    assert.deepEqual(NotificationUtils.normalize("Your turn."), {
        status: Constants.STATUS.INFO,
        title: "Notice",
        message: "Your turn."
    });
    assert.deepEqual(
        NotificationUtils.normalize({
            status: Constants.STATUS.WARNING,
            message: "Choose another card."
        }),
        {
            status: Constants.STATUS.WARNING,
            title: "Warning",
            message: "Choose another card."
        }
    );
    assert.deepEqual(
        NotificationUtils.normalize({
            status: Constants.STATUS.ERROR,
            title: "Server Error",
            message: "Try again."
        }),
        {
            status: Constants.STATUS.ERROR,
            title: "Server Error",
            message: "Try again."
        }
    );
    assert.deepEqual(NotificationUtils.normalize({ status: "unsupported" }), {
        status: Constants.STATUS.INFO,
        title: "Notice",
        message: ""
    });
    assert.equal(NotificationUtils.getDefaultTitle(Constants.STATUS.ERROR), "Error");
    assert.equal(NotificationUtils.normalizeStatus(null), Constants.STATUS.INFO);
});
