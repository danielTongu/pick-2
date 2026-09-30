"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../core/Constants.js";
test("results dialog reads normalized knockout status without a nested match", async () => {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalButton = globalThis.HTMLButtonElement;
    const originalTableBody = globalThis.HTMLTableSectionElement;
    const originalCustomElements = globalThis.customElements;

    class FakeElement {
        children = [];
        elements = new Map();
        dataset = {};
        hidden = true;
        textContent = "";

        querySelector(selector) { return this.elements.get(selector) ?? null; }
        replaceChildren() { this.children = []; }
        appendChild(child) { this.children.push(child); }
        addEventListener() {}
        setAttribute() {}
    }

    class FakeButton extends FakeElement {}
    class FakeTableBody extends FakeElement {}

    const root = new FakeElement();
    const message = new FakeElement();
    const context = new FakeElement();
    root.elements.set("#results-message", message);
    root.elements.set("#results-context", context);
    root.elements.set("#actor-stats-body", new FakeTableBody());
    root.elements.set("#selected-actor-items", new FakeElement());
    root.elements.set("#results-dismiss-button", new FakeButton());

    globalThis.HTMLElement = FakeElement;
    globalThis.HTMLButtonElement = FakeButton;
    globalThis.HTMLTableSectionElement = FakeTableBody;
    globalThis.customElements = { get() { return undefined; }, define() {} };
    globalThis.document = {
        querySelector(selector) { return selector === "#results-dialog" ? root : null; },
        createElement() { return new FakeElement(); }
    };

    try {
        const { ResultsController } = await import("../ui/controllers/ResultsController.js");
        const controller = new ResultsController("#results-dialog");
        const actor = {
            name: "Alice", state: Constants.ACTOR_STATE.QUALIFIED,
            collection: { penalty: 0, itemCount: 0, items: [] }
        };
        const room = {
            localActorName: "Alice",
            match: {
                turnOrder: { actors: [actor] },
                isKnockout: true,
                isKnockoutComplete: false
            }
        };

        controller.show(room);
        assert.equal(message.textContent, "You qualified for the next match.");
        assert.equal(context.textContent, "Knockout match results");

        room.match.isKnockout = false;
        actor.state = Constants.ACTOR_STATE.WON;
        controller.show(room);
        assert.equal(message.textContent, "You won 🎉");
        assert.equal(context.textContent, "Statistics for this game");
    } finally {
        globalThis.document = originalDocument;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.HTMLButtonElement = originalButton;
        globalThis.HTMLTableSectionElement = originalTableBody;
        globalThis.customElements = originalCustomElements;
    }
});
