"use strict";

/** Node-only HTTP and WebSocket adapter for the shared Host. */

import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import { Host, HostOptions } from "./Host.js";
import { PeerChannel } from "./Transport.js";

/** Explicit Node hosted-server configuration. */
export class WebSocketGatewayOptions {
    /** @type {number|string} Requested listening port. */
    port;

    /** @param {number|string} port - HTTP/WebSocket listening port. */
    constructor(port) {
        this.port = port;
        Object.freeze(this);
    }
}

/** Node-only HTTP and WebSocket boundary around the shared Host. */
export class WebSocketGateway {
    /** @type {Host} Authoritative Pick 2 host. */
    #host;

    /** @type {import("node:http").Server} HTTP server serving assets and upgrades. */
    #httpServer;

    /** @type {WebSocketServer} WebSocket server carrying Host requests and responses. */
    #webSocketServer;

    /** @type {NodeJS.Timeout|null} Interval that prunes throttles and pings clients. */
    #maintenanceInterval = null;

    /**
     * Creates and starts the Node HTTP/WebSocket runtime.
     * @param {WebSocketGatewayOptions} config - Gateway configuration.
     * @param {import("../core/Game.js").Game} game - Hosted game contract.
     */
    constructor(config, game) {
        if (!(config instanceof WebSocketGatewayOptions)) {
            throw new Error("WebSocketGateway requires WebSocketGatewayOptions.");
        }

        const port = WebSocketGateway.#resolvePort(config.port);
        this.#host = new Host(new HostOptions({ mode: "hosted", customBots: 0, trackIdle: true }), game);
        this.#httpServer = http.createServer(WebSocketGateway.#createApp());
        this.#webSocketServer = new WebSocketServer({ server: this.#httpServer });
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
        await Promise.all([WebSocketGateway.#close(this.#webSocketServer), WebSocketGateway.#close(this.#httpServer)]);
        this.#webSocketServer.removeAllListeners();
        this.#httpServer.removeAllListeners();
    }

    /** @param {number|string} port - Requested port. @returns {number} Configured HTTP port. */
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
        app.get("/", WebSocketGateway.#serveFile.bind(null, path.join(repositoryPath, "index.html")));
        app.get("/health", WebSocketGateway.#serveHealth);
        return app;
    }

    /** @param {string} file - Absolute asset path. @param {import("express").Request} _request - HTTP request. @param {import("express").Response} response - HTTP response. */
    static #serveFile(file, _request, response) {
        response.sendFile(file);
    }

    /** @param {import("express").Request} _request - HTTP request. @param {import("express").Response} response - HTTP response. */
    static #serveHealth(_request, response) {
        response.status(200).send("OK");
    }

    /** @param {number} port - Active listening port. */
    #reportStarted(port) {
        console.log(`WebSocket gateway listening on http://localhost:${port}`);

        for (const url of WebSocketGateway.#getLanUrls(port)) {
            console.log(url);
        }
    }

    /** @param {WebSocket} socket - Accepted WebSocket connection. */
    #connect(socket) {
        const peer = this.#host.accept(
            new PeerChannel(WebSocketGateway.#publish.bind(null, socket), WebSocketGateway.#terminate.bind(null, socket))
        );

        socket.on("message", WebSocketGateway.#receive.bind(null, peer));
        socket.on("close", peer.close.bind(peer));
        socket.on("error", WebSocketGateway.#ignoreSocketError);
    }

    /** @param {WebSocket} socket - Destination socket. @param {Object} response - Canonical Host response. */
    static #publish(socket, response) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(response));
        }
    }

    /** @param {WebSocket} socket - Socket to close. @param {number} [code] - Close code. @param {string} [reason] - Close reason. */
    static #terminate(socket, code, reason) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(code, reason);
        }
    }

    /** @param {import("./Session.js").HostPeer} peer - Host connection handle. @param {WebSocket.RawData} message - Inbound frame. */
    static #receive(peer, message) {
        let request = null;

        try {
            request = JSON.parse(String(message));
        } catch (_error) {}

        void peer.receive(request);
    }

    /** Absorbs socket errors because close events own connection cleanup. */
    static #ignoreSocketError() {}

    /** Starts the unreferenced maintenance interval used by the Node host. */
    #startMaintenance() {
        this.#maintenanceInterval = globalThis.setInterval(this.#maintain.bind(this), 30_000);
        this.#maintenanceInterval.unref?.();
    }

    /** Prunes Host throttles and pings every open WebSocket client. */
    #maintain() {
        this.#host.maintain();

        for (const socket of this.#webSocketServer.clients) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.ping();
            }
        }
    }

    /** Stops and clears the maintenance interval. */
    #stopMaintenance() {
        if (this.#maintenanceInterval !== null) {
            globalThis.clearInterval(this.#maintenanceInterval);
            this.#maintenanceInterval = null;
        }
    }

    /** @param {number} port - Active listening port. @returns {string[]} Unique IPv4 LAN URLs. */
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

    /** @param {import("node:http").Server|WebSocketServer} server - Server to close. @returns {Promise<void>} */
    static #close(server) {
        return new Promise(WebSocketGateway.#closeServer.bind(null, server));
    }

    /** @param {import("node:http").Server|WebSocketServer} server - Server to close. @param {function(): void} resolve - Promise resolver. @param {function(Error): void} reject - Promise rejecter. */
    static #closeServer(server, resolve, reject) {
        server.close(WebSocketGateway.#finishClose.bind(null, resolve, reject));
    }

    /** @param {function(): void} resolve - Promise resolver. @param {function(Error): void} reject - Promise rejecter. @param {Error|undefined} error - Close result. */
    static #finishClose(resolve, reject, error) {
        if (error instanceof Error && error.code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
        } else {
            resolve();
        }
    }
}
