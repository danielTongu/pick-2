"use strict";

import { Game as Pick2Game } from "./core/Game.js";
import { WebSocketGateway } from "./runtime/WebSocketGateway.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

let network = null;
let shutdownPromise = null;

/**
 * Logs a server error and its stack when available.
 * @param {*} error - Server failure.
 */
function reportError(error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
}

/**
 * Creates the bounded graceful-shutdown timeout.
 * @returns {Promise<never>} Promise that rejects when shutdown times out.
 */
function createShutdownTimeout() {
    return new Promise(startShutdownTimer);
}

/**
 * Starts the graceful-shutdown timer.
 * @param {Function} _resolve - Unused promise resolver.
 * @param {Function} reject - Promise rejection callback.
 */
function startShutdownTimer(_resolve, reject) {
    const timeoutId = globalThis.setTimeout(rejectShutdownTimeout.bind(null, reject), SHUTDOWN_TIMEOUT_MS);
    timeoutId.unref();
}

/**
 * Rejects a timed-out shutdown.
 * @param {Function} reject - Promise rejection callback.
 */
function rejectShutdownTimeout(reject) {
    reject(new Error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms.`));
}

/**
 * Closes the gateway within the shutdown deadline.
 * @param {number} exitCode - Process exit code.
 * @param {string} reason - Shutdown reason for logging.
 * @returns {Promise<void>} Completion of shutdown handling.
 */
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

/**
 * Starts shutdown once and preserves an error exit code from later failures.
 * @param {number} exitCode - Process exit code.
 * @param {string} reason - Shutdown reason.
 * @returns {Promise<void>} Shared shutdown promise.
 */
function shutdown(exitCode, reason) {
    if (shutdownPromise === null) {
        shutdownPromise = performShutdown(exitCode, reason);
    } else if (exitCode !== 0) {
        process.exitCode = exitCode;
    }

    return shutdownPromise;
}

/**
 * Shuts down after a process signal.
 * @param {string} signal - Received signal name.
 */
function handleSignal(signal) {
    void shutdown(0, signal);
}

/**
 * Reports an uncaught exception and exits after cleanup.
 * @param {Error} error - Uncaught exception.
 */
function handleUncaughtException(error) {
    console.error("Uncaught exception:");
    reportError(error);
    void shutdown(1, "uncaught exception");
}

/**
 * Reports an unhandled rejection and exits after cleanup.
 * @param {*} reason - Rejection reason.
 */
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
    network = new WebSocketGateway(process.env.PORT ?? "8080", new Pick2Game());
} catch (error) {
    console.error("Hosted server startup failed:");
    reportError(error);
    process.exitCode = 1;
}
