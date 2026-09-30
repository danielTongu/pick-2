"use strict";

import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import WebSocket, {WebSocketServer} from "ws";
import {Host} from "./host/Host.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** @type {Host|null} Authoritative Pick 2 host. */
let host = null;

/** @type {import("node:http").Server|null} HTTP asset and upgrade server. */
let httpServer = null;

/** @type {WebSocketServer|null} WebSocket request server. */
let webSocketServer = null;

/** @type {NodeJS.Timeout|null} Host maintenance interval. */
let maintenanceInterval = null;

/** @type {Promise<void>|null} Shared process-shutdown promise. */
let shutdownPromise = null;

/**
 * @param {number|string} port - Requested listening port.
 * @returns {number} Resolved port.
 */
function resolvePort(port) {
    const parsed = Number.parseInt(String(port), 10);
    return Number.isNaN(parsed) ? 8080 : parsed;
}

/**
 * @param {string} file - Absolute asset path.
 * @param {import("express").Request} _request - HTTP request.
 * @param {import("express").Response} response - HTTP response.
 */
function serveFile(file, _request, response) {
    response.sendFile(file);
}

/**
 * @param {import("express").Request} _request - HTTP request.
 * @param {import("express").Response} response - HTTP response.
 */
function serveHealth(_request, response) {
    response.status(200).send("OK");
}

/** @returns {import("express").Express} Static web application. */
function createApp() {
    const app = express();
    const repositoryPath = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(repositoryPath));
    app.get("/", serveFile.bind(null, path.join(repositoryPath, "index.html")));
    app.get("/health", serveHealth);
    return app;
}

/**
 * @param {WebSocket} socket - Destination socket.
 * @param {Object} response - Canonical Host response.
 */
function publish(socket, response) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
}

/**
 * @param {WebSocket} socket - Socket to close.
 * @param {number} [code] - Close code.
 * @param {string} [reason] - Close reason.
 */
function terminate(socket, code, reason) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
    }
}

/**
 * @param {import("./host/HostConnection.js").HostConnection} connection - Host connection.
 * @param {WebSocket.RawData} message - Inbound frame.
 */
function receive(connection, message) {
    let request = null;
    try {
        request = JSON.parse(String(message));
    } catch (_error) {
    }
    void connection.receive(request);
}

/** Absorbs socket errors because close events own connection cleanup. */
function ignoreSocketError() {
}

/** @param {WebSocket} socket - Accepted WebSocket connection. */
function connect(socket) {
    const connection = host.accept(publish.bind(null, socket), terminate.bind(null, socket));
    socket.on("message", receive.bind(null, connection));
    socket.on("close", connection.close.bind(connection));
    socket.on("error", ignoreSocketError);
}

/** Prunes Host throttles and pings open WebSocket clients. */
function maintain() {
    host.maintain();
    for (const socket of webSocketServer.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
}

/** Stops the maintenance interval. */
function stopMaintenance() {
    if (maintenanceInterval !== null) {
        globalThis.clearInterval(maintenanceInterval);
        maintenanceInterval = null;
    }
}

/**
 * @param {number} port - Active listening port.
 * @returns {string[]} Unique IPv4 LAN URLs.
 */
function getLanUrls(port) {
    const urls = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const address of entries ?? []) {
            if (address.family === "IPv4" && !address.internal) urls.push(`http://${address.address}:${port}`);
        }
    }
    return Array.from(new Set(urls));
}

/** @param {number} port - Listening port. */
function reportStarted(port) {
    console.log(`Hosted server listening on http://localhost:${port}`);
    for (const url of getLanUrls(port)) console.log(url);
}

/**
 * Starts the Node HTTP/WebSocket server and shared Host.
 * @param {number|string} port - HTTP/WebSocket listening port.
 */
function startServer(port) {
    const resolvedPort = resolvePort(port);
    host = new Host("hosted", 0, true);
    httpServer = http.createServer(createApp());
    webSocketServer = new WebSocketServer({server: httpServer});
    webSocketServer.on("connection", connect);
    httpServer.on("close", stopMaintenance);
    maintenanceInterval = globalThis.setInterval(maintain, 30_000);
    maintenanceInterval.unref?.();
    httpServer.listen(resolvedPort, "0.0.0.0", reportStarted.bind(null, resolvedPort));
}

/**
 * @param {import("node:http").Server|WebSocketServer} server - Server to close.
 * @returns {Promise<void>}
 */
function closeServer(server) {
    return new Promise(function finish(resolve, reject) {
        server.close(function closed(error) {
            if (error instanceof Error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
        });
    });
}

/** @returns {Promise<void>} Completion of HTTP, WebSocket, and Host cleanup. */
async function stopServer() {
    stopMaintenance();
    for (const socket of webSocketServer?.clients ?? []) socket.terminate();
    await host?.shutdown();
    await Promise.all([
        ...(webSocketServer === null ? [] : [closeServer(webSocketServer)]),
        ...(httpServer === null ? [] : [closeServer(httpServer)])
    ]);
    webSocketServer?.removeAllListeners();
    httpServer?.removeAllListeners();
    host = null;
    webSocketServer = null;
    httpServer = null;
}

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
 * Closes the hosted server within the shutdown deadline.
 * @param {number} exitCode - Process exit code.
 * @param {string} reason - Shutdown reason for logging.
 * @returns {Promise<void>} Completion of shutdown handling.
 */
async function performShutdown(exitCode, reason) {
    console.log(`\nShutting down: ${reason}`);
    process.exitCode = exitCode;

    try {
        if (host !== null || httpServer !== null || webSocketServer !== null) {
            await Promise.race([stopServer(), createShutdownTimeout()]);
        }

        console.log("Shutdown complete.");
    } catch (error) {
        console.error("Graceful shutdown failed:");
        reportError(error);
        process.exitCode = 1;
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
    startServer(process.env.PORT ?? "8080");
} catch (error) {
    console.error("Hosted server startup failed:");
    reportError(error);
    process.exitCode = 1;
}
