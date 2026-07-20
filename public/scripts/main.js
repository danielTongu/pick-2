// public/main.js

"use strict";

import { AppController } from "./controllers/AppController.js";
import { LobbyViewController } from "./controllers/LobbyViewController.js";
import { RoomViewController } from "./controllers/RoomViewController.js";
import { ConnectionService } from "./ConnectionService.js";

/**
 * Reports an unexpected application error.
 *
 * @param {*} error - Error to report.
 */
function reportError(error) {
    console.error("Application error:");

    if (error instanceof Error) {
        console.error(error);
        console.error(error.stack);
    } else {
        console.error(error);
    }
}

/**
 * Registers global error handlers.
 */
function registerGlobalErrorHandlers() {
    window.addEventListener("error", function (event) {
        reportError(event.error ?? event.message);
    });

    window.addEventListener("unhandledrejection", function (event) {
        reportError(event.reason);
    });
}

/**
 * Starts the application.
 *
 * @returns {Promise<void>}
 */
async function main() {
    const connection = new ConnectionService();
    const lobbyView = new LobbyViewController(connection);
    const roomView = new RoomViewController(connection);
    const app = new AppController(connection, lobbyView, roomView);

    await app.start();
}

registerGlobalErrorHandlers();

try {
    await main();
} catch (error) {
    reportError(error);
    throw error;
}
