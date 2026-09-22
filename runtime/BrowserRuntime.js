"use strict";

import { Endpoint } from "./Transport.js";
import { Host } from "./Host.js";

/** Composes the browser-owned Host and its in-process endpoint. */
export class BrowserRuntime {
    /** @type {Endpoint} Direct endpoint exposed to the browser Client. */
    endpoint;

    /** @param {import("../core/Game.js").Game} game - Game contract. */
    constructor(game) {
        this.endpoint = new Endpoint(new Host("direct", "fill", false, game));
    }
}
