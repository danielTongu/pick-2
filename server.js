"use strict";

import { Game as Pick2Game } from "./core/Game.js";
import { WebSocketGateway, WebSocketGatewayOptions } from "./runtime/WebSocketGateway.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

let network = null;
let shutdownPromise = null;

/** Manages report error. */
function reportError(error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
}

/** Creates shutdown timeout. */
function createShutdownTimeout() {
    return new Promise(startShutdownTimer);
}

/** Manages start shutdown timer. */
function startShutdownTimer(_resolve, reject) {
    const timeoutId = globalThis.setTimeout(rejectShutdownTimeout.bind(null, reject), SHUTDOWN_TIMEOUT_MS);
    timeoutId.unref();
}

/** Manages reject shutdown timeout. */
function rejectShutdownTimeout(reject) {
    reject(new Error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms.`));
}

/** Manages perform shutdown. */
async function performShutdown(exitCode, reason) {
    console.log(`\nShutting down: ${reason}`);
    process.exitCode = exitCode;

    try {
        if (network !== null) {
            await Promise.race([network.shutdown(), createShutdownTimeout()]);
        }

        console.log("Shutdown complete.");
    } catch (error) {
        console.error("Graceful shutdown failed:");
        reportError(error);
        process.exitCode = 1;
    } finally {
        network = null;
    }
}

/** Manages shutdown. */
function shutdown(exitCode, reason) {
    if (shutdownPromise === null) {
        shutdownPromise = performShutdown(exitCode, reason);
    } else if (exitCode !== 0) {
        process.exitCode = exitCode;
    }

    return shutdownPromise;
}

/** Handles signal. */
function handleSignal(signal) {
    void shutdown(0, signal);
}

/** Handles uncaught exception. */
function handleUncaughtException(error) {
    console.error("Uncaught exception:");
    reportError(error);
    void shutdown(1, "uncaught exception");
}

/** Handles unhandled rejection. */
function handleUnhandledRejection(reason) {
    console.error("Unhandled rejection:");
    reportError(reason);
    void shutdown(1, "unhandled rejection");
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);
process.once("uncaughtException", handleUncaughtException);
process.once("unhandledRejection", handleUnhandledRejection);

try {
    network = new WebSocketGateway(new WebSocketGatewayOptions(process.env.PORT ?? "8080"), new Pick2Game());
} catch (error) {
    console.error("Hosted server startup failed:");
    reportError(error);
    process.exitCode = 1;
}
