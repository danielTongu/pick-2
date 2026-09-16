"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import { Card } from "../core/Card.js";

// Only the DOM surface used by PlayingCard; browser layout is checked separately.
class FakeElement extends EventTarget {
    attributes = new Map();
    children = [];
    captures = new Set();
    isConnected = false;
    renderedHeight = "140px";
    style = {
        values: new Map(),
        getPropertyValue(name) {
            return this.values.get(name) ?? "";
        },
        setProperty(name, value) {
            this.values.set(name, value);
        },
        removeProperty(name) {
            this.values.delete(name);
        }
    };

    constructor() {
        super();
        const element = this;
        this.dataset = new Proxy(
            {},
            {
                get(_target, key) {
                    return element.attributes.get(attributeName(key));
                },
                set(_target, key, value) {
                    element.setAttribute(attributeName(key), String(value));
                    return true;
                }
            }
        );
    }

    setAttribute(name, value) {
        const previous = this.getAttribute(name);
        this.attributes.set(name, String(value));
        if (this.constructor.observedAttributes?.includes(name)) {
            this.attributeChangedCallback(name, previous, String(value));
        }
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }
    hasAttribute(name) {
        return this.attributes.has(name);
    }
    removeAttribute(name) {
        this.attributes.delete(name);
    }
    querySelector(selector) {
        return this.children.find((child) => `.${child.className}` === selector) ?? null;
    }
    replaceChildren(...children) {
        this.children = children;
    }
    appendChild(child) {
        this.children.push(child);
        child.parent = this;
        child.isConnected = true;
        child.connectedCallback?.();
    }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
        this.isConnected = false;
        this.disconnectedCallback?.();
    }
    getBoundingClientRect() {
        return { left: 0, top: 0, right: 100, bottom: 140, height: 140 };
    }
    setPointerCapture(id) {
        this.captures.add(id);
    }
    hasPointerCapture(id) {
        return this.captures.has(id);
    }
    releasePointerCapture(id) {
        this.captures.delete(id);
    }
    cloneNode() {
        const clone = new this.constructor();
        for (const [name, value] of this.attributes) clone.setAttribute(name, value);
        for (const [name, value] of this.style.values) clone.style.setProperty(name, value);
        return clone;
    }
}

function attributeName(key) {
    return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function pointer(target, type, x = 10, y = 10) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
    target.dispatchEvent(event);
}

test("PlayingCard properties and pointer lifecycle", async (t) => {
    const originals = new Map(
        ["HTMLElement", "customElements", "document", "window"].map((name) => [name, globalThis[name]])
    );
    const registered = new Map();
    globalThis.HTMLElement = FakeElement;
    globalThis.customElements = {
        define(name, Type) {
            registered.set(name, Type);
        },
        get(name) {
            return registered.get(name);
        }
    };
    globalThis.document = new EventTarget();
    document.body = new FakeElement();
    document.createElement = function (name) {
        return new (registered.get(name) ?? FakeElement)();
    };
    globalThis.window = {
        setTimeout,
        clearTimeout,
        getComputedStyle(element) {
            return { height: element.renderedHeight };
        }
    };

    try {
        const { PlayingCard } = await import("../ui/PlayingCard.js");
        const model = new Card("a", "spades", 15);

        await t.test("shares model properties and keeps derived values read-only", () => {
            const element = PlayingCard.create(model);
            for (const name of ["value", "suit", "rank", "score", "rotation"]) {
                assert.equal(element[name], model[name]);
            }
            for (const name of ["value", "suit", "rank", "score", "isDragging"]) {
                assert.throws(() => {
                    element[name] = 0;
                }, TypeError);
            }
            assert.equal(element.isDragging, false);
            assert.equal(element.isFaceUp, true);
        });

        await t.test("updates are validated before changing identity or rotation", () => {
            const element = PlayingCard.create(model);
            element.isFaceUp = false;
            for (const source of [
                { value: "2", suit: "clubs", rotation: NaN },
                { value: "joker", suit: "hearts" }
            ]) {
                assert.throws(() => element.update(source));
                assert.equal(element.value, "a");
                assert.equal(element.rotation, 15);
                assert.equal(element.isFaceUp, false);
            }
            element.update({ value: "2", suit: "clubs", score: -1, rank: -1 });
            assert.equal(element.score, -1);
            assert.equal(element.rank, new Card("2", "clubs", 0).rank);
            assert.equal(element.isFaceUp, false);
            assert.equal(element.rotation, null);
            element.update({ suit: "hearts" });
            assert.equal(element.value, "");
            assert.equal(element.rank, null);
            assert.equal(element.score, null);
            assert.throws(() => element.update({ suit: "purple" }), /Invalid card suit/);
        });

        await t.test("rotation validates without losing its previous value and can use CSS", () => {
            const element = PlayingCard.create(model);
            for (const value of [NaN, Infinity, "20"]) {
                assert.throws(() => {
                    element.rotation = value;
                }, /finite number/);
                assert.equal(element.rotation, 15);
            }
            element.rotation = -30;
            assert.equal(element.style.getPropertyValue("--card-rotation"), "-30deg");
            element.rotation = null;
            assert.equal(element.rotation, null);
            assert.equal(element.style.getPropertyValue("--card-rotation"), "");
        });

        await t.test("face setters, attributes, click, and keyboard update accessibility", () => {
            const element = PlayingCard.create(model, new FakeElement());
            element.isFaceUp = false;
            document.body.appendChild(element);
            assert.equal(element.isFaceUp, false);
            assert.equal(element.dataset.isFaceUp, "false");
            assert.equal(element.getAttribute("aria-label"), "a of spades, face down");
            element.dispatchEvent(new Event("click"));
            assert.equal(element.isFaceUp, true);
            const key = new Event("keydown", { cancelable: true });
            Object.assign(key, { key: " " });
            element.dispatchEvent(key);
            assert.equal(element.isFaceUp, false);
            assert.equal(key.defaultPrevented, true);
            element.dataset.isFaceUp = "true";
            assert.equal(element.getAttribute("aria-label"), "a of spades, face up");
            element.isFaceUp = false;
            element.isFaceUp = true;
            assert.equal(element.isFaceUp, true);
            for (const property of ["isFaceUp"]) {
                assert.throws(() => {
                    element[property] = "false";
                }, /boolean/);
            }
            element.remove();
        });

        await t.test("static cards omit interaction markup and ignore click and keyboard", () => {
            const element = PlayingCard.create(model);
            document.body.appendChild(element);
            assert.equal(element.querySelector(".playing-card-drag-handle"), null);
            assert.equal(element.getAttribute("role"), "img");
            assert.equal(element.hasAttribute("tabindex"), false);
            assert.equal(element.hasAttribute("data-is-dragging"), false);
            assert.equal(element.hasAttribute("data-is-draggable"), false);
            element.dispatchEvent(new Event("click"));
            const key = new Event("keydown", { cancelable: true });
            Object.assign(key, { key: "Enter" });
            element.dispatchEvent(key);
            assert.equal(element.isFaceUp, true);
            assert.equal(key.defaultPrevented, false);
            element.isFaceUp = false;
            assert.equal(element.getAttribute("aria-label"), "a of spades, face down");
            element.remove();
            assert.equal(element.hasAttribute("data-is-dragging"), false);
            for (const target of [true, false, "#discard-pile", {}]) {
                assert.throws(() => PlayingCard.create(model, target), /destination/);
            }
        });

        await t.test("updates, cancellation, and removal release the active card", () => {
            for (const end of ["update", "cancel", "remove"]) {
                const element = PlayingCard.create(model, new FakeElement());
                document.body.appendChild(element);
                const handle = element.querySelector(".playing-card-drag-handle");
                pointer(handle, "pointerdown");
                pointer(document, "pointermove", 30);
                assert.equal(element.isDragging, true);
                if (end === "update") element.update({ suit: "hearts" });
                if (end === "cancel") pointer(document, "pointercancel");
                if (end === "remove") element.remove();
                assert.equal(element.isDragging, false);
                assert.equal(handle.hasPointerCapture(1), false);
                if (end !== "remove") element.remove();
                assert.equal(document.body.children.length, 0);
            }
        });

        await t.test("a completed drag preserves face state and emits only card identity", () => {
            const target = new FakeElement();
            const drops = [];
            target.addEventListener("card_drop", (event) => drops.push(event.detail));
            const element = PlayingCard.create(model, target);
            element.isFaceUp = false;
            document.body.appendChild(element);
            pointer(element.querySelector(".playing-card-drag-handle"), "pointerdown");
            pointer(document, "pointermove", 30);
            const clone = document.body.children.find((child) => child !== element);
            assert.equal(clone.isFaceUp, false);
            assert.equal(clone.rotation, 15);
            assert.equal(clone.hasAttribute("data-is-dragging"), false);
            assert.equal(clone.querySelector(".playing-card-drag-handle"), null);
            assert.equal(target.dataset.isDragOver, "true");
            pointer(document, "pointerup", 30);
            assert.equal(drops.length, 1);
            assert.deepEqual(drops[0].card, { value: "a", suit: "spades" });
            assert.equal(drops[0].source, element);
            assert.equal(element.isDragging, false);
            assert.equal(target.dataset.isDragOver, "false");
            assert.equal(document.body.children.length, 1);
            element.dispatchEvent(new Event("click"));
            assert.equal(element.isFaceUp, false);
            element.remove();
        });

        await t.test("drag previews retain source layout height, even with rotated bounds or later resizing", () => {
            const element = PlayingCard.create(model, new FakeElement());
            document.body.appendChild(element);
            const handle = element.querySelector(".playing-card-drag-handle");
            // The transformed bounding height is 140px, independently of layout height.
            for (const height of ["123.5px", "91px", "205.75px"]) {
                element.renderedHeight = height;
                pointer(handle, "pointerdown");
                pointer(document, "pointermove", 30);
                const clone = document.body.children.find((child) => child !== element);
                assert.equal(clone.style.getPropertyValue("--card-height"), height);
                assert.equal(clone.style.left, "20px");
                assert.equal(clone.style.top, "0px");
                element.renderedHeight = "300px";
                pointer(document, "pointermove", 60, 40);
                assert.equal(clone.style.getPropertyValue("--card-height"), height);
                assert.equal(clone.style.left, "50px");
                assert.equal(clone.style.top, "30px");
                pointer(document, "pointercancel");
                assert.equal(element.isDragging, false);
                assert.equal(document.body.children.length, 1);
                assert.equal(element.style.getPropertyValue("--card-height"), "");
            }
            element.remove();
        });

        await t.test("each card uses its own destination and ignores a release outside it", () => {
            const left = new FakeElement();
            const right = new FakeElement();
            right.getBoundingClientRect = () => ({ left: 200, top: 0, right: 300, bottom: 140, height: 140 });
            let leftDrops = 0;
            let rightDrops = 0;
            left.addEventListener("card_drop", () => {
                leftDrops += 1;
            });
            right.addEventListener("card_drop", () => {
                rightDrops += 1;
            });
            const first = PlayingCard.create(model, left);
            const second = PlayingCard.create(model, right);
            document.body.appendChild(first);
            document.body.appendChild(second);
            for (const [element, x] of [
                [first, 30],
                [second, 30],
                [second, 250]
            ]) {
                pointer(element.querySelector(".playing-card-drag-handle"), "pointerdown");
                pointer(document, "pointermove", x);
                assert.equal(element.isDragging, true);
                pointer(document, "pointerup", x);
                assert.equal(element.isDragging, false);
                assert.equal(document.body.children.length, 2);
            }
            assert.equal(leftDrops, 1);
            assert.equal(rightDrops, 1);
            first.remove();
            second.remove();
        });
    } finally {
        for (const [name, value] of originals) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    }
});
