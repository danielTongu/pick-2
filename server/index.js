// server/index.js

"use strict";

import Server from "./Server.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** @type {Server|null} */
let server = null;

/** @type {Promise<void>|null} */
let shutdownPromise = null;

/**
 * Reports an error with its stack trace when available.
 *
 * @param {*} error - Error to report.
 */
function reportError(error) {
    if (error instanceof Error) {
        console.error(error.stack || error.message);
    } else {
        console.error(error);
    }
}

/**
 * Creates a promise that rejects when graceful shutdown takes too long.
 *
 * @param {number} timeoutMs - Maximum shutdown duration.
 * @returns {Promise<never>} Timeout promise.
 */
function createShutdownTimeout(timeoutMs) {
    return new Promise((_, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
            reject(new Error(`Shutdown exceeded ${timeoutMs}ms.`));
        }, timeoutMs);

        timeoutId.unref();
    });
}

/**
 * Performs the server shutdown.
 *
 * @param {number} exitCode - Process exit code.
 * @param {string} reason - Shutdown reason.
 * @returns {Promise<void>}
 */
async function performShutdown(exitCode, reason) {
    console.log(`\nShutting down: ${reason}`);

    process.exitCode = exitCode;

    try {
        if (server !== null) {
            await Promise.race([
                server.destroy(),
                createShutdownTimeout(SHUTDOWN_TIMEOUT_MS)
            ]);
        }

        console.log("Shutdown complete.");
    } catch (error) {
        console.error("Graceful shutdown failed:");
        reportError(error);
        process.exitCode = 1;
    } finally {
        server = null;
    }
}

/**
 * Starts graceful shutdown once.
 *
 * Later calls wait for the shutdown already in progress.
 *
 * @param {number} exitCode - Process exit code.
 * @param {string} reason - Shutdown reason.
 * @returns {Promise<void>}
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
 * Handles an operating-system shutdown signal.
 *
 * @param {NodeJS.Signals} signal - Received signal.
 */
function handleSignal(signal) {
    void shutdown(0, signal);
}

/**
 * Handles an uncaught exception.
 *
 * The process must terminate because application state may be corrupted.
 *
 * @param {Error} error - Uncaught error.
 */
function handleUncaughtException(error) {
    console.error("Uncaught exception:");
    reportError(error);
    void shutdown(1, "uncaught exception");
}

/**
 * Handles an unhandled promise rejection.
 *
 * @param {*} reason - Rejection reason.
 */
function handleUnhandledRejection(reason) {
    console.error("Unhandled rejection:");
    reportError(reason);
    void shutdown(1, "unhandled rejection");
}

/**
 * Registers process lifecycle handlers.
 */
function registerProcessHandlers() {
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    process.once("uncaughtException", handleUncaughtException);
    process.once("unhandledRejection", handleUnhandledRejection);
}

/**
 * Starts the application.
 */
function start() {
    registerProcessHandlers();

    try {
        server = new Server();
    } catch (error) {
        console.error("Server startup failed:");
        reportError(error);
        process.exitCode = 1;
    }
}

start();