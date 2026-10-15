import assert from "node:assert/strict";
import test from "node:test";
import { AlertController } from "../../ui/controllers/AlertController.js";

test("Alert requires a nonempty status attribute and renders subsequent status changes", t => {
    const names = ["document", "HTMLElement", "HTMLButtonElement"];
    const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    t.after(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    class FakeElement {
        dataset = {};
        children = new Map();
        hidden = true;
        textContent = "";
        querySelector(selector) { return this.children.get(selector) ?? null; }
        addEventListener() {}
    }
    class FakeButton extends FakeElement {}
    const root = new FakeElement();
    root.children.set("#alert-title", new FakeElement());
    root.children.set("#alert-message", new FakeElement());
    root.children.set("#alert-ok-button", new FakeButton());
    globalThis.document = { querySelector() { return root; } };
    globalThis.HTMLElement = FakeElement;
    globalThis.HTMLButtonElement = FakeButton;

    assert.throws(() => new AlertController("#alert-dialog"), /Alert data-status must be a string/);
    for (const status of ["", "   "]) {
        root.dataset.status = status;
        assert.throws(() => new AlertController("#alert-dialog"), /Alert data-status cannot be empty/);
    }
    root.dataset.status = "info";
    const controller = new AlertController("#alert-dialog");
    for (const status of ["success", "error", "warning", "info"]) {
        controller.show({ status, title: "+ 1", message: "Card added" });
        assert.equal(root.dataset.status, status);
        assert.equal(root.children.get("#alert-title").textContent, "+ 1");
        assert.equal(root.children.get("#alert-message").textContent, "Card added");
        assert.equal(root.hidden, false);
    }
});
