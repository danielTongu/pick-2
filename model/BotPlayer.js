"use strict";

import { Player } from "./Player.js";

/** Seated automated player identity and hand; BotService executes its turns. */
export class BotPlayer extends Player {
    /**
     * Creates an automated participant with normal match state.
     * @param {string} name - Validated player display name.
     */
    constructor(name) {
        super(name, { drawAllowance: 1 });
    }
}
