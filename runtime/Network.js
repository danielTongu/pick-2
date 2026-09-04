"use strict";

/** Node-only HTTP and WebSocket adapter for the shared Host. */

import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import { Host, HostChannel, HostConfig } from "./Host.js";

/** Explicit Node Network runtime configuration. */
export class NetworkConfig {
    /**
     * @param {number|string} port - HTTP/WebSocket listening port.
     * @param {Object} store - Persistent room-definition store.
     */
    constructor(port, store) {
        this.port = port;
        this.store = store;
        Object.freeze(this);
    }
}

/** Node-only HTTP and WebSocket boundary around the shared Host. */
export class Network {
    #host;
    #httpServer;
    #webSocketServer;
    #maintenanceInterval = null;

    /**
     * Creates and starts the Node HTTP/WebSocket runtime.
     * @param {NetworkConfig} config - Network runtime configuration.
     */
    constructor(config) {
        if (!(config instanceof NetworkConfig)) {
            throw new Error("Network requires a NetworkConfig instance.");
        }

        const port = Network.#resolvePort(config.port);
        this.#host = new Host(new HostConfig(
            "network",
            0,
            true,
            true,
            false,
            config.store
        ));
        this.#httpServer = http.createServer(Network.#createApp());
        this.#webSocketServer = new WebSocketServer({server: this.#httpServer});
        this.#webSocketServer.on("connection", this.#connect.bind(this));
        this.#httpServer.on("close", this.#stopMaintenance.bind(this));
        this.#startMaintenance();
        this.#httpServer.listen(port, "0.0.0.0", this.#reportStarted.bind(this, port));
    }

    /** Stops network infrastructure and the shared Host. @returns {Promise<void>} */
    async shutdown() {
        this.#stopMaintenance();

        for (const socket of this.#webSocketServer.clients) {
            socket.terminate();
        }

        await this.#host.shutdown();
        await Promise.all([
            Network.#close(this.#webSocketServer),
            Network.#close(this.#httpServer)
        ]);
        this.#webSocketServer.removeAllListeners();
        this.#httpServer.removeAllListeners();
    }

    /** @returns {number} Configured HTTP port. */
    static #resolvePort(port) {
        const parsed = Number.parseInt(String(port), 10);
        return Number.isNaN(parsed) ? 8080 : parsed;
    }

    /**
     * Builds the HTTP application for the shared Home and Room pages.
     *
     * @returns {import("express").Express} Static web application.
     */
    static #createApp() {
        const app = express();
        const repositoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
        app.use(express.static(repositoryPath));
        app.get("/", Network.#serveFile.bind(null, path.join(repositoryPath, "index.html")));
        app.get("/room.html", Network.#serveFile.bind(null, path.join(repositoryPath, "room.html")));
        app.get("/health", Network.#serveHealth);
        return app;
    }

    static #serveFile(file, _request, response) {
        response.sendFile(file);
    }

    static #serveHealth(_request, response) {
        response.status(200).send("OK");
    }

    #reportStarted(port) {
        console.log(`Network host listening on http://localhost:${port}`);

        for (const url of Network.#getLanUrls(port)) {
            console.log(url);
        }
    }

    /** Connects one WebSocket to one transport-neutral Host peer. */
    #connect(socket) {
        const peer = this.#host.open(new HostChannel(
            Network.#publish.bind(null, socket),
            Network.#terminate.bind(null, socket)
        ));

        socket.on("message", Network.#receive.bind(null, peer));
        socket.on("close", peer.close.bind(peer));
        socket.on("error", Network.#ignoreSocketError);
    }

    static #publish(socket, response) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(response));
        }
    }

    static #terminate(socket, code, reason) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(code, reason);
        }
    }

    static #receive(peer, message) {
        let request = null;

        try {
            request = JSON.parse(String(message));
        } catch (_error) {}

        void peer.request(request);
    }

    static #ignoreSocketError() {}

    #startMaintenance() {
        this.#maintenanceInterval = globalThis.setInterval(this.#maintain.bind(this), 30_000);
        this.#maintenanceInterval.unref?.();
    }

    #maintain() {
        this.#host.maintain();

        for (const socket of this.#webSocketServer.clients) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.ping();
            }
        }
    }

    #stopMaintenance() {
        if (this.#maintenanceInterval !== null) {
            globalThis.clearInterval(this.#maintenanceInterval);
            this.#maintenanceInterval = null;
        }
    }

    static #getLanUrls(port) {
        const urls = [];

        for (const entries of Object.values(os.networkInterfaces())) {
            for (const address of entries ?? []) {
                if (address.family === "IPv4" && !address.internal) {
                    urls.push(`http://${address.address}:${port}`);
                }
            }
        }

        return Array.from(new Set(urls));
    }

    static #close(server) {
        return new Promise(Network.#closeServer.bind(null, server));
    }

    static #closeServer(server, resolve, reject) {
        server.close(Network.#finishClose.bind(null, resolve, reject));
    }

    static #finishClose(resolve, reject, error) {
        if (error instanceof Error && error.code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
        } else {
            resolve();
        }
    }
}
