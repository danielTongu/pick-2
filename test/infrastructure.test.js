"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CardSortUtils } from "../src/core/CardSortUtils.js";
import { Constants } from "../src/core/Constants.js";
import { NormalizeUtils } from "../src/core/NormalizeUtils.js";
import { Serializable } from "../src/core/Serializable.js";
import { StateMapper } from "../src/core/StateMapper.js";
import { TurnUtils } from "../src/core/TurnUtils.js";
import { UserNotification } from "../src/core/UserNotification.js";
import { RoomRowUtils } from "../src/server/RoomRowUtils.js";
import { ThrottleGuard } from "../src/server/ThrottleGuard.js";
import { NotificationUtils } from "../src/ui/NotificationUtils.js";
import { OpponentUtils } from "../src/ui/OpponentUtils.js";
import { TemplateUtils } from "../src/ui/TemplateUtils.js";

const INDEX_HTML = readFileSync(new URL("../web/server/index.html", import.meta.url), "utf8");

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
            { GameEndController },
            { LobbyController },
            { LocalPlayerController },
            { ServerRoomController },
            { SuitSelectionController },
            { ViewController },
            { PlayingCard }
        ] = await Promise.all([
            import("../src/ui/AlertController.js"),
            import("../src/ui/CountdownController.js"),
            import("../src/ui/GameEndController.js"),
            import("../src/server/LobbyController.js"),
            import("../src/ui/LocalPlayerController.js"),
            import("../src/server/ServerRoomController.js"),
            import("../src/ui/SuitSelectionController.js"),
            import("../src/ui/ViewController.js"),
            import("../src/ui/PlayingCard.js")
        ]);
        const overlayTypes = [
            AlertController,
            CountdownController,
            GameEndController,
            SuitSelectionController
        ];
        const viewTypes = [LobbyController, ServerRoomController];
        const playingCardMethods = [
            "update",
            "getCard",
            "setRotation",
            "turnFaceUp",
            "turnFaceDown",
            "isFaceDown",
            "toggleFace"
        ];

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

        assert.equal(LocalPlayerController.prototype instanceof ViewController, true);
        assert.equal(typeof ViewController.prototype.bindDismissButton, "function");
        assert.equal(PlayingCard.prototype instanceof globalThis.HTMLElement, true);
        assert.equal(registeredElements.get(PlayingCard.elementName), PlayingCard);
        assert.equal(Object.getOwnPropertyDescriptor(PlayingCard.prototype, "card"), undefined);
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

test("NormalizeUtils validates integer categories without coercion", () => {
    assert.equal(NormalizeUtils.integer(-2, "Count"), -2);
    assert.equal(NormalizeUtils.nonNegativeInteger(0, "Count"), 0);
    assert.equal(NormalizeUtils.nonNegativeInteger(3, "Count"), 3);

    assert.throws(() => NormalizeUtils.integer(1.5, "Count"), /Count must be an integer/);
    assert.throws(() => NormalizeUtils.integer("1", "Count"), /Count must be an integer/);
    assert.throws(() => NormalizeUtils.nonNegativeInteger(-1, "Count"), /Count must be a non-negative integer/);
    assert.throws(() => NormalizeUtils.nonNegativeInteger(1.5, "Count"), /Count must be a non-negative integer/);
});

test("Serializable handles nested models, dates, arrays, objects, maps, sets, and field filters", () => {
    const child = new Serializable({value: 2});
    const model = new Serializable({
        child,
        date: new Date("2026-01-02T03:04:05.000Z"),
        array: [child, new Set([3])],
        object: {child, omitted: undefined, method() {}},
        map: new Map([["child", child]]),
        set: new Set([child]),
        _private: "hidden",
        omitted: undefined,
        method() {}
    });

    assert.deepEqual(model.toJSON(), {
        child: {value: 2},
        date: "2026-01-02T03:04:05.000Z",
        array: [{value: 2}, [3]],
        object: {child: {value: 2}},
        map: {child: {value: 2}},
        set: [{value: 2}]
    });
    assert.deepEqual(model.toJSON(["child", "date"], ["date"]), {child: {value: 2}});
});

test("StateMapper builds immutable response, message, lobby, and detailed room payloads", () => {
    const message = StateMapper.toMessage(Constants.STATUS.INFO, "Ready", "Take your turn.");
    const response = StateMapper.toResponse(Constants.VIEWS.ROOM, message, {version: 1});
    const state = {
        name: "Mapped Room",
        status: Constants.STATUS.PLAYING,
        capacity: 4,
        createdAt: "invalid",
        lastActiveAt: 0,
        visitors: ["one", "two"],
        session: {playerName: "Alice"},
        circle: {
            playerCount: 1,
            turnOwnerKey: "alice",
            direction: 1,
            players: [{
                key: "alice",
                name: "Alice",
                hand: {
                    score: 5,
                    sortKey: Constants.CARD.SORT_OPTIONS[0],
                    cards: [{value: "5", suit: "clubs", score: 5, rotation: 10}]
                },
                drawAllowance: 2,
                isWinner: true,
                ws: {}
            }]
        },
        discardPile: [{value: "3", suit: "hearts", score: 3, rotation: 20}],
        deck: {cards: [{}, {}]},
        winners: ["Alice"],
        scores: {Alice: 5},
        isAwaitingSuit: true,
        declaredSuit: Constants.CARD.SUIT.SPADES
    };
    const room = {
        setSessionPlayer(playerName) {
            state.session.playerName = playerName;
        },
        toJSON: () => state
    };

    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(response), true);
    assert.equal(response.message.title, "Ready");

    const lobby = StateMapper.toLobbyPayload([room]);
    assert.equal(lobby.rooms[0].visitorCount, 2);
    assert.equal(lobby.rooms[0].createdAt, "");

    const payload = StateMapper.toRoomPayload(room, "Alice");
    assert.equal(payload.circle.turnOwnerKey, "alice");
    assert.equal(
        TurnUtils.isTurnOwner(payload.circle.turnOwnerKey, payload.circle.players[0].key),
        true
    );
    assert.equal(payload.circle.players[0].hand.cards.length, 1);
    assert.equal(payload.circle.players[0].hand.score, 5);
    assert.equal(payload.discardPile.length, 2);
    assert.deepEqual(payload.discardPile[1], {suit: Constants.CARD.SUIT.SPADES, rotation: 0});
    assert.equal(payload.deckCount, 2);
    assert.deepEqual(payload.scores, {Alice: 5});
});

test("StateMapper supplies safe defaults for incomplete room state", () => {
    const state = {
        name: "Empty",
        status: Constants.STATUS.WAITING,
        capacity: 2,
        createdAt: null,
        lastActiveAt: null,
        visitors: 3,
        session: {playerName: null},
        circle: null,
        discardPile: null,
        deck: null,
        winners: null,
        scores: null,
        isAwaitingSuit: false,
        declaredSuit: null
    };
    const room = {setSessionPlayer() {}, toJSON: () => state};
    const payload = StateMapper.toRoomPayload(room);

    assert.equal(payload.playerCount, 0);
    assert.equal(payload.visitorCount, 3);
    assert.deepEqual(payload.circle.players, []);
    assert.deepEqual(payload.discardPile, []);
    assert.deepEqual(payload.winners, []);
    assert.deepEqual(payload.scores, {});
    assert.equal(payload.deckCount, 0);
    assert.equal(payload.circle.turnOwnerKey, null);
});

test("ThrottleGuard isolates scopes and supports reset, pruning, and validation", () => {
    const guard = new ThrottleGuard();

    guard.enforceSocketThrottle({tabId: " tab "}, "sync", 1000);
    assert.throws(
        () => guard.enforceSocketThrottle({tabId: "tab"}, "sync", 1000),
        UserNotification
    );

    guard.reset("socket:tab");
    guard.enforceSocketThrottle({tabId: "tab"}, "sync", 1000);
    guard.enforcePlayerThrottle("player-tab", "move", 0);
    guard.enforceRoomThrottle("room-key", "start", 0);
    guard.prune(0);
    guard.resetAll();

    assert.throws(() => guard.enforcePlayerThrottle("", "move", 1), /cannot be empty/);
    assert.throws(() => guard.enforceRoomThrottle("room", "move", -1), /non-negative integer/);
});

test("CardSortUtils supports every sort mode without mutating its input", () => {
    const cards = [
        {value: "k", suit: "clubs", score: 13},
        {value: "2", suit: "hearts", score: 20},
        {value: "5", suit: "diamonds", score: 5}
    ];

    assert.deepEqual(CardSortUtils.sorted(cards, "none"), cards);
    assert.notEqual(CardSortUtils.sorted(cards, "none"), cards);
    assert.deepEqual(CardSortUtils.sorted(cards, "rank").map((card) => card.value), ["2", "5", "k"]);
    assert.deepEqual(CardSortUtils.sorted(cards, "value").map((card) => card.value), ["2", "5", "k"]);
    assert.deepEqual(CardSortUtils.sorted(cards, "suit").map((card) => card.suit), ["clubs", "diamonds", "hearts"]);
    assert.deepEqual(CardSortUtils.sorted(cards, "score").map((card) => card.value), ["5", "k", "2"]);
    assert.throws(() => CardSortUtils.sorted(cards, "unknown"), /Invalid card sort key/);
});

test("card-sort HTML initializes every canonical option", () => {
    const selectMarkup = INDEX_HTML.match(/<select id="card-sort-key-select">([\s\S]*?)<\/select>/)?.[1] ?? "";
    const optionValues = Array.from(selectMarkup.matchAll(/<option value="([^"]+)">/g), function (match) {
        return match[1];
    });

    assert.deepEqual(optionValues.sort(), [...Constants.CARD.SORT_OPTIONS].sort());
});

test("game-guide score cells initialize from canonical card scores", () => {
    const scoreCells = Array.from(
        INDEX_HTML.matchAll(/<td data-card-value="([^"]+)" data-card-suit="([^"]+)">(\d+)<\/td>/g)
    );

    assert.equal(scoreCells.length, 8);

    for (const [, value, suit, displayedScore] of scoreCells) {
        assert.equal(Number(displayedScore), Constants.getCardScore(value, suit));
    }
});

test("NotificationUtils produces one canonical notification shape", () => {
    assert.deepEqual(NotificationUtils.normalize("Your turn."), {
        status: Constants.STATUS.INFO,
        title: "Notice",
        message: "Your turn."
    });
    assert.deepEqual(NotificationUtils.normalize({
        status: Constants.STATUS.WARNING,
        message: "Choose another card."
    }), {
        status: Constants.STATUS.WARNING,
        title: "Warning",
        message: "Choose another card."
    });
    assert.deepEqual(NotificationUtils.normalize({
        status: Constants.STATUS.ERROR,
        title: "Server Error",
        message: "Try again."
    }), {
        status: Constants.STATUS.ERROR,
        title: "Server Error",
        message: "Try again."
    });
    assert.deepEqual(NotificationUtils.normalize({status: "unsupported"}), {
        status: Constants.STATUS.INFO,
        title: "Notice",
        message: ""
    });
    assert.equal(NotificationUtils.getDefaultTitle(Constants.STATUS.ERROR), "Error");
    assert.equal(NotificationUtils.normalizeStatus(null), Constants.STATUS.INFO);
});
