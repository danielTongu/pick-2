"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Constants } from "../../core/Constants.js";
import { NotificationUtils } from "../../ui/utilities/NotificationUtils.js";

test("NotificationUtils produces one canonical notification shape", () => {
    assert.deepEqual(NotificationUtils.normalize("Your turn."), {
        status: Constants.STATUS.INFO,
        title: "Notice",
        message: "Your turn."
    });
    assert.deepEqual(
        NotificationUtils.normalize({
            status: Constants.STATUS.WARNING,
            message: "Choose another card."
        }),
        {
            status: Constants.STATUS.WARNING,
            title: "Warning",
            message: "Choose another card."
        }
    );
    assert.deepEqual(
        NotificationUtils.normalize({
            status: Constants.STATUS.ERROR,
            title: "Server Error",
            message: "Try again."
        }),
        {
            status: Constants.STATUS.ERROR,
            title: "Server Error",
            message: "Try again."
        }
    );
    assert.deepEqual(NotificationUtils.normalize({ status: "unsupported" }), {
        status: Constants.STATUS.INFO,
        title: "Notice",
        message: ""
    });
    assert.equal(NotificationUtils.getDefaultTitle(Constants.STATUS.ERROR), "Error");
    assert.equal(NotificationUtils.normalizeStatus(null), Constants.STATUS.INFO);
});
