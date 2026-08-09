
"use strict";

import { LobbyController } from "./LobbyController.js";
import { ServerAppController } from "./ServerAppController.js";
import { ServerRoomController } from "./ServerRoomController.js";
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
    const lobbyController = new LobbyController(connection);
    const roomController = new ServerRoomController(connection);
    const app = new ServerAppController(connection, lobbyController, roomController);

    await app.start();
}

registerGlobalErrorHandlers();

try {
    await main();
} catch (error) {
    reportError(error);
    throw error;
}
