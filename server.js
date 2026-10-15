"use strict";

import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import { WebSocketGateway } from "./server/WebSocketGateway.js";
import {Host} from "./host/Host.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** @type {Host|null} Authoritative Pick 2 host. */
let host = null;

/** @type {import("node:http").Server|null} HTTP asset and upgrade server. */
let httpServer = null;

/** @type {WebSocketGateway|null} Protected WebSocket admission and transport. */
let webSocketGateway = null;

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

/** Prunes Host throttles and pings open WebSocket clients. */
function maintain() {
    host.maintain();
    webSocketGateway.maintain();
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
 * Reads a positive integer resource limit, rejecting invalid deployment configuration.
 * @param {string} name - Environment variable.
 * @param {number} fallback - Default bound.
 * @returns {number} Validated bound.
 */
function readLimit(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: expected a positive integer.`);
    return value;
}

/**
 * Parses a comma-separated origin or proxy allowlist.
 * @param {string} value - Deployment setting.
 * @returns {string[]} Nonempty trimmed entries.
 */
function parseList(value) {
    return value.split(",").map(function trimEntry(entry) { return entry.trim(); }).filter(Boolean);
}

/**
 * Constructs explicit browser-origin, proxy-trust, and resource policies for hosted play.
 * @param {number} port - Local listening port.
 * @returns {Object} Gateway policy.
 */
function createGatewayPolicy(port) {
    const defaults = ["https://danieltongu.github.io", `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`, ...getLanUrls(port)];
    return {
        allowedOrigins: process.env.WS_ALLOWED_ORIGINS === undefined ? defaults : parseList(process.env.WS_ALLOWED_ORIGINS),
        trustedProxyIps: parseList(process.env.WS_TRUSTED_PROXY_IPS ?? ""),
        limits: {
            maxConnections: readLimit("WS_MAX_CONNECTIONS", WebSocketGateway.MAX_CONNECTIONS),
            maxConnectionsPerIp: readLimit("WS_MAX_CONNECTIONS_PER_IP", WebSocketGateway.MAX_CONNECTIONS_PER_IP),
            maxPayloadBytes: readLimit("WS_MAX_PAYLOAD_BYTES", WebSocketGateway.MAX_PAYLOAD_BYTES),
            maxBufferedBytes: readLimit("WS_MAX_BUFFERED_BYTES", WebSocketGateway.MAX_BUFFERED_BYTES),
            maxUpgradesPerIp: readLimit("WS_MAX_UPGRADES_PER_IP", WebSocketGateway.MAX_UPGRADES_PER_IP),
            maxMessagesPerWindow: readLimit("WS_MAX_MESSAGES_PER_WINDOW", WebSocketGateway.MAX_MESSAGES_PER_WINDOW)
        }
    };
}

/**
 * Starts the Node HTTP/WebSocket server and shared Host.
 * @param {number|string} port - HTTP/WebSocket listening port.
 */
function startServer(port) {
    const resolvedPort = resolvePort(port);
    host = new Host("hosted", 0, true);
    httpServer = http.createServer({ headersTimeout: 10_000, requestTimeout: 15_000 }, createApp());
    httpServer.maxHeadersCount = 50;
    webSocketGateway = new WebSocketGateway(httpServer, host, createGatewayPolicy(resolvedPort));
    httpServer.on("close", stopMaintenance);
    maintenanceInterval = globalThis.setInterval(maintain, WebSocketGateway.HEARTBEAT_INTERVAL_MS);
    maintenanceInterval.unref?.();
    httpServer.listen(resolvedPort, "0.0.0.0", reportStarted.bind(null, resolvedPort));
}

/**
 * @param {import("node:http").Server} server - Server to close.
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
    await webSocketGateway?.close();
    await host?.shutdown();
    if (httpServer !== null) await closeServer(httpServer);
    httpServer?.removeAllListeners();
    host = null;
    webSocketGateway = null;
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
        if (host !== null || httpServer !== null || webSocketGateway !== null) {
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
