"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../core/Constants.js";
import { SuitSelectionController } from "../ui/controllers/SuitSelectionController.js";

test("suit selection timeout dismisses temporarily for the shared countdown duration", () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const OriginalHTMLElement = globalThis.HTMLElement;
    const OriginalHTMLButtonElement = globalThis.HTMLButtonElement;
    const OriginalHTMLInputElement = globalThis.HTMLInputElement;

    class FakeHTMLElement {
        hidden = true;
        children = new Map();

        querySelector(selector) {
            return this.children.get(selector) ?? null;
        }
    }

    class FakeButton extends FakeHTMLElement {
        listeners = new Map();

        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        }

        click() {
            this.listeners.get("click")?.({preventDefault() {}});
        }
    }

    class FakeInput extends FakeHTMLElement {}

    const root = new FakeHTMLElement();
    const timeoutButton = new FakeButton();
    const submitButton = new FakeButton();
    const timers = new Map();
    const clearedTimers = [];
    let nextTimerId = 1;
    let timeoutDelay = null;

    root.children.set("#suit-selection-timeout-button", timeoutButton);
    root.children.set("#suit-selection-submit-button", submitButton);

    globalThis.HTMLElement = FakeHTMLElement;
    globalThis.HTMLButtonElement = FakeButton;
    globalThis.HTMLInputElement = FakeInput;
    globalThis.document = {
        querySelector(selector) {
            return selector === "#suit-selection-dialog" ? root : null;
        }
    };
    globalThis.window = {
        setTimeout(callback, delay) {
            const id = nextTimerId;
            nextTimerId += 1;
            timeoutDelay = delay;
            timers.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            clearedTimers.push(id);
            timers.delete(id);
        }
    };

    try {
        const controller = new SuitSelectionController("#suit-selection-dialog");

        controller.show();
        assert.equal(root.hidden, false);

        timeoutButton.click();
        assert.equal(root.hidden, true);
        assert.equal(timeoutDelay, Constants.COUNTDOWN_SECONDS * 1000);

        controller.show();
        assert.equal(root.hidden, true);

        timers.get(1)?.();
        assert.equal(root.hidden, false);

        timeoutButton.click();
        controller.hide();
        assert.equal(root.hidden, true);
        assert.deepEqual(clearedTimers, [2]);
    } finally {
        restoreGlobal("document", originalDocument);
        restoreGlobal("window", originalWindow);
        restoreGlobal("HTMLElement", OriginalHTMLElement);
        restoreGlobal("HTMLButtonElement", OriginalHTMLButtonElement);
        restoreGlobal("HTMLInputElement", OriginalHTMLInputElement);
    }
});

/** Restores one global property after a test. */
function restoreGlobal(name, value) {
    if (value === undefined) {
        delete globalThis[name];
    } else {
        globalThis[name] = value;
    }
}
