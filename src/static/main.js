"use strict";

import { StaticAppController } from "./StaticAppController.js";
import { StaticRoomController } from "./StaticRoomController.js";
import { LocalGameService } from "./LocalGameService.js";

/** Reports an unexpected application error. */
function reportError(error) {
    console.error("Application error:", error);
}

window.addEventListener("error", (event) => reportError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportError(event.reason));

try {
    const gameService = new LocalGameService();
    const roomController = new StaticRoomController(gameService);
    const app = new StaticAppController(gameService, roomController);
    await app.start();
} catch (error) {
    reportError(error);
    throw error;
}
