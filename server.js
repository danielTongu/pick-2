"use strict";

import { Network, NetworkConfig } from "./runtime/Network.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
let network = null;
let shutdownPromise = null;

function reportError(error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
}

function createShutdownTimeout() {
    return new Promise(startShutdownTimer);
}

function startShutdownTimer(_resolve, reject) {
    const timeoutId = globalThis.setTimeout(rejectShutdownTimeout.bind(null, reject), SHUTDOWN_TIMEOUT_MS);
    timeoutId.unref();
}

function rejectShutdownTimeout(reject) {
    reject(new Error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms.`));
}

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

function shutdown(exitCode, reason) {
    if (shutdownPromise === null) {
        shutdownPromise = performShutdown(exitCode, reason);
    } else if (exitCode !== 0) {
        process.exitCode = exitCode;
    }

    return shutdownPromise;
}

function handleSignal(signal) {
    void shutdown(0, signal);
}

function handleUncaughtException(error) {
    console.error("Uncaught exception:");
    reportError(error);
    void shutdown(1, "uncaught exception");
}

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
    network = new Network(new NetworkConfig(process.env.PORT ?? "8080", null));
} catch (error) {
    console.error("Network startup failed:");
    reportError(error);
    process.exitCode = 1;
}
