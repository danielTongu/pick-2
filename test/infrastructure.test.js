"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CardSortUtils } from "../core/CardSortUtils.js";
import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";
import { Serializable } from "../core/Serializable.js";
import { StateMapper } from "../core/StateMapper.js";
import { TurnUtils } from "../core/TurnUtils.js";
import { UserNotification } from "../core/UserNotification.js";
import { RoomRowUtils } from "../ui/utilities/RoomRowUtils.js";
import { RateLimit } from "../runtime/RateLimit.js";
import { NotificationUtils } from "../ui/utilities/NotificationUtils.js";
import { OpponentUtils } from "../ui/utilities/OpponentUtils.js";
import { TemplateUtils } from "../ui/utilities/TemplateUtils.js";

const INDEX_HTML = readFileSync(new URL("../room.html", import.meta.url), "utf8");
const OVERLAYS_CSS = readFileSync(new URL("../web/shared/styles/overlays.css", import.meta.url), "utf8");

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
        const overlayTypes = [
            AlertController,
            CountdownController,
            ResultsController,
            SuitSelectionController
        ];
        const viewTypes = [HomeController, NetworkConnectionController, RoomController];
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

test("StateMapper builds immutable response, message, Home, and detailed Game payloads", () => {
    const message = StateMapper.toMessage(Constants.STATUS.INFO, "Ready", "Take your turn.");
    const response = StateMapper.toResponse(Constants.VIEWS.ROOM, message, {version: 1});
    const state = {
        name: "Mapped Room",
        status: Constants.STATUS.PLAYING,
        playerLimit: 4,
        createdAt: "invalid",
        lastActiveAt: 0,
        viewers: ["one", "two"],
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
    const room = {toJSON: () => state};

    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(response), true);
    assert.equal(response.message.title, "Ready");

    const home = StateMapper.toHomeData([room]);
    assert.equal(home.rooms[0].viewerCount, 2);
    assert.equal(home.rooms[0].createdAt, "");

    const data = StateMapper.toRoomData(room, "Alice");
    assert.equal(data.circle.turnOwnerKey, "alice");
    assert.equal(
        TurnUtils.isTurnOwner(data.circle.turnOwnerKey, data.circle.players[0].key),
        true
    );
    assert.equal(data.circle.players[0].hand.cards.length, 1);
    assert.equal(data.circle.players[0].hand.score, 5);
    assert.equal(data.discardPile.length, 2);
    assert.deepEqual(data.discardPile[1], {suit: Constants.CARD.SUIT.SPADES, rotation: 0});
    assert.equal(data.deckCount, 2);
    assert.deepEqual(data.scores, {Alice: 5});
});

test("StateMapper supplies safe defaults for incomplete game state", () => {
    const state = {
        name: "Empty",
        status: Constants.STATUS.WAITING,
        playerLimit: 2,
        createdAt: null,
        lastActiveAt: null,
        viewers: 3,
        circle: null,
        discardPile: null,
        deck: null,
        winners: null,
        scores: null,
        isAwaitingSuit: false,
        declaredSuit: null
    };
    const room = {toJSON: () => state};
    const data = StateMapper.toRoomData(room, null);

    assert.equal(data.playerCount, 0);
    assert.equal(data.viewerCount, 3);
    assert.deepEqual(data.circle.players, []);
    assert.deepEqual(data.discardPile, []);
    assert.deepEqual(data.winners, []);
    assert.deepEqual(data.scores, {});
    assert.equal(data.deckCount, 0);
    assert.equal(data.circle.turnOwnerKey, null);
});

test("RateLimit isolates scopes and supports reset, pruning, and validation", () => {
    const guard = new RateLimit();

    guard.enforceConnection({tabId: " tab "}, "sync", 1000);
    assert.throws(
        () => guard.enforceConnection({tabId: "tab"}, "sync", 1000),
        UserNotification
    );

    guard.reset("connection:tab");
    guard.enforceConnection({tabId: "tab"}, "sync", 1000);
    guard.enforcePlayerThrottle("player-tab", "move", 0);
    guard.enforceSessionThrottle("room-key", "start", 0);
    guard.prune(0);
    guard.resetAll();

    assert.throws(() => guard.enforcePlayerThrottle("", "move", 1), /cannot be empty/);
    assert.throws(() => guard.enforceSessionThrottle("room", "move", -1), /non-negative integer/);
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

test("the shared guide initializes canonical card-sort options", () => {
    const controller = readFileSync(new URL("../src/ui/GuideController.js", import.meta.url), "utf8");

    assert.match(INDEX_HTML, /<select id="card-sort-key-select"><\/select>/);
    assert.match(controller, /Constants\.CARD\.SORT_OPTIONS/);
    assert.match(controller, /PlayingCard\.create\(card, false\)/);
});

test("drag clones scale from the rendered card instead of the body container", () => {
    const playingCard = readFileSync(new URL("../src/ui/PlayingCard.js", import.meta.url), "utf8");

    assert.match(playingCard, /Constants\.CARD\.DRAG_CLONE_SCALE/);
    assert.match(playingCard, /bounds\.height \* scale/);
    assert.match(playingCard, /this\.#dragState\.offsetX \*= scale/);
    assert.match(playingCard, /this\.#dragState\.offsetY \*= scale/);
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
