"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { RoomRowUtils } from "../../ui/utilities/RoomRowUtils.js";
import { PlayerUtils } from "../../ui/utilities/PlayerUtils.js";
import { TemplateUtils } from "../../ui/utilities/TemplateUtils.js";

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
            { ConnectionController },
            { SuitSelectionController },
            { ViewController },
            { PlayingCard }
        ] = await Promise.all([
            import("../../ui/controllers/AlertController.js"),
            import("../../ui/controllers/CountdownController.js"),
            import("../../ui/controllers/ResultsController.js"),
            import("../../ui/controllers/RoomController.js"),
            import("../../ui/controllers/HomeController.js"),
            import("../../ui/controllers/LocalPlayerController.js"),
            import("../../ui/controllers/ConnectionController.js"),
            import("../../ui/controllers/SuitSelectionController.js"),
            import("../../ui/controllers/ViewController.js"),
            import("../../ui/PlayingCard.js")
        ]);
        const overlayTypes = [AlertController, CountdownController, ResultsController, SuitSelectionController];
        const viewTypes = [HomeController, RoomController];
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

        assert.equal(ConnectionController.prototype instanceof ViewController, true);
        assert.equal(typeof ConnectionController.prototype.initialize, "function");
        assert.equal(typeof ConnectionController.prototype.render, "function");

        for (const Type of [PlayerUtils, RoomRowUtils]) {
            assert.equal(Type.prototype instanceof TemplateUtils, true);
            assert.equal(typeof Type.load, "function");
            assert.equal(typeof Type.create, "function");
            assert.equal(typeof Type.updateElement, "function");
        }

        for (const method of playingCardMethods) {
            assert.equal(typeof PlayingCard.prototype[method], "function");
        }

        for (const property of ["value", "suit", "rotation", "isDragging", "isFaceUp"]) {
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
