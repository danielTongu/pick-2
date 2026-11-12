"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Serializable } from "../../model/Serializable.js";

test("Serializable handles nested models, dates, arrays, objects, maps, sets, and field filters", () => {
    const child = Object.assign(new Serializable(), { value: 2 });
    const model = Object.assign(new Serializable(), {
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

test("serialized record and map prototype keys remain ordinary data without prototype mutation", () => {
    const model = new Serializable();
    model.record = JSON.parse('{"__proto__":{"visible":true},"_label":"record data"}');
    model.index = new Map([["__proto__", { visible: true }]]);
    model._hidden = "model internals";
    const snapshot = model.toJSON();
    assert.equal(Object.hasOwn(snapshot, "_hidden"), false);
    assert.equal(snapshot.record._label, "record data");
    assert.equal(Object.hasOwn(snapshot.record, "__proto__"), true);
    assert.equal(Object.hasOwn(snapshot.index, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(snapshot.record), Object.prototype);
    assert.equal(Object.getPrototypeOf(snapshot.index), Object.prototype);
});
