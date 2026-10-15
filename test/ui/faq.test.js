"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { Constants } from "../../core/Constants.js";

const INDEX_HTML = readFileSync(new URL("../../room.html", import.meta.url), "utf8");

test("the shared FAQ initializes canonical card-sort options", () => {
    const controller = readFileSync(new URL("../../ui/controllers/FaqController.js", import.meta.url), "utf8");

    assert.match(INDEX_HTML, /<select id="sort-key-select">[\s\S]*?<option[\s\S]*?<\/select>/);
    assert.match(controller, /Constants\.CARD\.SORT_OPTIONS/);
    assert.match(controller, /PlayingCard\.create\(card\)/);
});

test("FAQ rank cells initialize from canonical card ranks", () => {
    const rankCells = [...INDEX_HTML.matchAll(/<td\b([^>]*)>(\d+)<\/td>/g)]
        .map(([, attributes, rank]) => ({
            value: attributes.match(/data-card-value="([^"]+)"/)?.[1],
            suit: attributes.match(/data-card-suit="([^"]+)"/)?.[1],
            rank: Number(rank)
        })).filter(cell => cell.value && cell.suit);
    assert.equal(rankCells.length, 8);
    for (const cell of rankCells) {
        assert.equal(cell.rank, Constants.getCardRank(cell.value, cell.suit));
    }
});
