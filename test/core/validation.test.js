"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { ValidationUtils } from "../../core/ValidationUtils.js";

test("ValidationUtils validates integer categories without coercion", () => {
    assert.equal(ValidationUtils.integer(-2, "Count"), -2);
    assert.equal(ValidationUtils.nonNegativeInteger(0, "Count"), 0);
    assert.equal(ValidationUtils.nonNegativeInteger(3, "Count"), 3);

    assert.throws(() => ValidationUtils.integer(1.5, "Count"), /Count must be an integer/);
    assert.throws(() => ValidationUtils.integer("1", "Count"), /Count must be an integer/);
    assert.throws(() => ValidationUtils.nonNegativeInteger(-1, "Count"), /Count must be a non-negative integer/);
    assert.throws(() => ValidationUtils.nonNegativeInteger(1.5, "Count"), /Count must be a non-negative integer/);
});
