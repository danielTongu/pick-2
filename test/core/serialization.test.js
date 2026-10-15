"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Serializable } from "../../core/Serializable.js";

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
