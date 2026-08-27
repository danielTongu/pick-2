"use strict";

import express from "express";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { UserNotification } from "../core/UserNotification.js";

import { Card } from "../core/Card.js";
import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { AIPlayer, Player } from "../core/Player.js";
import { Session } from "../core/Session.js";
import { StateMapper } from "../core/StateMapper.js";
import { ThrottleGuard } from "./ThrottleGuard.js";

/**
 * HTTP and WebSocket server for the card game.
 *
 * The Game lists Sessions. A client may view a Session, join as a Player,
 * and leave it. Session owns players and gameplay; Server owns connections,
 * viewers, notifications, and the session registry.
 */
export default class Server {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** @type {http.Server} */
    #httpServer;

    /** @type {WebSocketServer} */
    #webSocketServer;

    /** @type {number|null} */
    #heartbeatIntervalId = null;

    /** @type {Map<string, Session>} */
    #sessionsByKey = new Map();

    /** @type {Map<string, Set<string>>} */
    #sessionTabIdsBySessionKey = new Map();

    /** @type {Map<string, NodeJS.Timeout>} */
    #sessionClosureTimersBySessionKey = new Map();

    /** @type {Map<string, {tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}>} */
    #clientsByTabId = new Map();

    /** @type {Set<WebSocket>} */
    #gameConnections = new Set();

    /** @type {ThrottleGuard} */
    #throttleGuard = new ThrottleGuard();

    /**
     * Creates and starts the server.
     *
     * @param {{port?:number|string}} options - Server options.
     */
    constructor(options = {}) {
        const port = Server.#resolvePort(options);
        const app = Server.#createExpressApp();

        this.#httpServer = http.createServer(app);
        this.#webSocketServer = new WebSocketServer({ server: this.#httpServer });

        this.#attachWebSocketServer();
        this.#initializeDefaultSessions();
        this.#startHttpServer(port);
    }

    /**
     * Stops the server and releases all resources.
     *
     * @returns {Promise<void>} Resolves when shutdown completes.
     */
    async destroy() {
        await this.#destroy();
    }

    // -------------------------------------------------------------------------
    // Startup and infrastructure
    // -------------------------------------------------------------------------

    /**
     * Resolves the configured HTTP port.
     *
     * @param {{port?:number|string}} options - Server options.
     * @returns {number} Port number.
     */
    static #resolvePort(options) {
        const configuredPort = options.port || process.env.PORT || "8080";
        const parsedPort = Number.parseInt(String(configuredPort), 10);

        return Number.isNaN(parsedPort) ? 8080 : parsedPort;
    }

    /**
     * Creates the Express application.
     *
     * @returns {import("express").Express} Express application.
     */
    static #createExpressApp() {
        const app = express();
        const filename = fileURLToPath(import.meta.url);
        const dirname = path.dirname(filename);
        const repositoryPath = path.join(dirname, "../..");
        const webPath = path.join(repositoryPath, "web");
        const sharedPath = path.join(webPath, "shared");
        const sourcePath = path.join(repositoryPath, "src");
        const indexPath = path.join(repositoryPath, "index.html");
        const sessionIndexPath = path.join(repositoryPath, "session/index.html");

        app.use("/shared", express.static(sharedPath));
        app.use("/web", express.static(webPath));
        app.use("/src", express.static(sourcePath));

        app.get("/", (_request, response) => {
            response.sendFile(indexPath);
        });

        app.get(["/session", "/session/", "/session/index.html"], (_request, response) => {
            response.sendFile(sessionIndexPath);
        });

        app.get("/health", (_request, response) => {
            response.status(200).send("OK");
        });

        return app;
    }

    /**
     * Attaches WebSocket lifecycle handlers.
     */
    #attachWebSocketServer() {
        this.#webSocketServer.on("connection", this.#handleWebSocketConnection.bind(this));
        this.#httpServer.on("close", this.#stopHeartbeat.bind(this));
        this.#startHeartbeat();
    }

    /**
     * Starts periodic server maintenance.
     */
    #startHeartbeat() {
        this.#heartbeatIntervalId = globalThis.setInterval(this.#heartbeat.bind(this), 30_000);
    }

    /**
     * Performs periodic server maintenance.
     */
    #heartbeat() {
        this.#throttleGuard.prune(5 * 60 * 1000);
        this.#pingWebSocketClients();
    }

    /**
     * Sends a ping to every connected client.
     */
    #pingWebSocketClients() {
        for (const ws of this.#webSocketServer.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }
    }

    /**
     * Clears the heartbeat interval.
     */
    #stopHeartbeat() {
        if (this.#heartbeatIntervalId !== null) {
            globalThis.clearInterval(this.#heartbeatIntervalId);
            this.#heartbeatIntervalId = null;
        }
    }

    // -------------------------------------------------------------------------
    // Session registry and state publication
    // -------------------------------------------------------------------------

    /**
     * Creates the default sessions and AI players.
     */
    #initializeDefaultSessions() {
        for (const sessionConfig of Constants.DEFAULT_SESSIONS) {
            const sessionKey = this.#normalizeSessionKey(sessionConfig.name);
            const session = this.#registerSession(sessionConfig.name, sessionConfig.capacity, sessionKey);

            for (let index = 0; index < sessionConfig.aiCount; index += 1) {
                const suffix = index === 0 ? "" : `-${index + 1}`;
                void session.join(`AI-Player${suffix}`, true);
            }
        }
    }

    /**
     * Builds a normalized key from a name.
     *
     * @param {string} name - Name.
     * @returns {string} Normalized key.
     */
    #normalizeSessionKey(name) {
        return Player.normalizeKey(name);
    }

    /**
     * Creates and registers a session.
     *
     * @param {string} sessionName - Session name.
     * @param {number} capacity - Player capacity.
     * @param {string} sessionKey - Session key.
     * @returns {Session} Registered session.
     */
    #registerSession(sessionName, capacity, sessionKey) {
        const session = new Session(sessionName, capacity);

        session.onAnyChange = () => {
            this.#broadcastSessionSync(sessionKey);
        };

        session.onPlayerIdle = (_changedSession, playerName) => {
            void this.#moveIdlePlayerToView(sessionKey, playerName);
        };

        this.#sessionsByKey.set(sessionKey, session);
        this.#sessionTabIdsBySessionKey.set(sessionKey, new Set());

        return session;
    }

    /**
     * Removes server callbacks from a session.
     *
     * @param {Session} session - Session instance.
     */
    #clearSessionCallbacks(session) {
        session.onAnyChange = null;
        session.onPlayerIdle = null;
    }

    /**
     * Gets a registered session.
     *
     * @param {string} sessionKey - Session key.
     * @returns {Session} Session instance.
     * @throws {Error}
     */
    #requireSessionByKey(sessionKey) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;

        if (session === null) {
            throw new UserNotification("Session not found.");
        }

        return session;
    }

    /**
     * Broadcasts current Session state to every connected client.
     *
     * @param {string} sessionKey - Session key.
     */
    #broadcastSessionSync(sessionKey) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;

        if (session !== null) {
            const sessionTabIds = this.#sessionTabIdsBySessionKey.get(sessionKey);

            if (sessionTabIds !== undefined) {
                for (const tabId of sessionTabIds) {
                    const client = this.#clientsByTabId.get(tabId);

                    if (client !== undefined && client.ws.readyState === WebSocket.OPEN) {
                        this.#sendSessionSync(client.ws, session, this.#resolveClientPlayerName(session, client));
                    }
                }
            }

            if (session.status === Constants.STATUS.FINISHED) {
                session.status = Constants.STATUS.WAITING;
            }
        }
    }

    /**
     * Resolves a client's player name against current session membership.
     *
     * @param {Session} session - Session instance.
     * @param {{playerName:string|null}} client - Session client.
     * @returns {string|null} Valid player name or null.
     */
    #resolveClientPlayerName(session, client) {
        let playerName = null;

        if (client.playerName !== null && session.isPlayerPresent(client.playerName)) {
            playerName = client.playerName;
        }

        return playerName;
    }

    /**
     * Sends session state to one client.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Session} session - Session instance.
     * @param {string|null} playerName - Session player name.
     */
    #sendSessionSync(ws, session, playerName) {
        this.#sendViewSync(ws, Constants.VIEWS.SESSION, Object.freeze({
            ...StateMapper.toSessionPayload(session, playerName),
            ...Server.#getModeData(),
            isBusy: false
        }));
    }

    /**
     * Registers a socket as currently viewing the game.
     *
     * @param {WebSocket} ws - Client WebSocket.
     */
    #registerGameConnection(ws) {
        if (ws.readyState === WebSocket.OPEN) {
            this.#gameConnections.add(ws);
        }
    }

    /**
     * Removes a socket from game tracking.
     *
     * @param {WebSocket} ws - Client WebSocket.
     */
    #unregisterGameConnection(ws) {
        this.#gameConnections.delete(ws);
    }

    /**
     * Broadcasts the current game synchronization payload.
     *
     * @param {{sessions:Object[]}|null} gameSync - Optional prebuilt game payload.
     */
    #broadcastGameSync(gameSync = null) {
        const resolvedGameSync = gameSync ?? this.#createGameSync();

        for (const ws of Array.from(this.#gameConnections)) {
            if (ws.readyState === WebSocket.OPEN) {
                this.#sendViewSync(ws, Constants.VIEWS.GAME, resolvedGameSync);
            } else {
                this.#gameConnections.delete(ws);
            }
        }
    }

    /**
     * Creates the game synchronization payload.
     *
     * @returns {{sessions:Object[]}} Game payload.
     */
    #createGameSync() {
        return Object.freeze({
            ...StateMapper.toGamePayload(this.#sessionsByKey.values()),
            ...Server.#getModeData()
        });
    }

    /** @returns {Object} Shared Network-mode metadata. */
    static #getModeData() {
        return Object.freeze({
            mode: "network",
            capabilities: Object.freeze({
                create: true,
                join: true,
                view: true,
                invite: true,
                aiFill: false,
                restart: false
            })
        });
    }

    /**
     * Sends a normal transition to the game.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {{sessions:Object[]}|null} gameSync - Optional prebuilt game payload.
     */
    #sendGameTransition(ws, gameSync = null) {
        const resolvedGameSync = gameSync ?? this.#createGameSync();

        this.#registerGameConnection(ws);
        this.#sendViewSync(ws, Constants.VIEWS.GAME, resolvedGameSync);
    }

    /**
     * Sends a forced session-exit notification and Game state.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {string} title - Warning title.
     * @param {string} message - Warning message.
     * @param {{sessions:Object[]}|null} gameSync - Optional prebuilt game payload.
     */
    #sendInvoluntaryGameTransition(ws, title, message, gameSync = null) {
        const resolvedGameSync = gameSync ?? this.#createGameSync();

        this.#registerGameConnection(ws);
        this.#sendResponse(ws, StateMapper.toResponse(
            Constants.VIEWS.GAME,
            StateMapper.toMessage(Constants.STATUS.WARNING, title, message),
            resolvedGameSync
        ));
    }

    // -------------------------------------------------------------------------
    // Client sessions and membership transitions
    // -------------------------------------------------------------------------

    /**
     * Registers a client with a session.
     *
     * @param {string} tabId - Tab ID.
     * @param {WebSocket} ws - Client WebSocket.
     * @param {string} sessionKey - Session key.
     * @param {string|null} playerName - Player name.
     * @returns {{tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}} Registered client.
     */
    #registerClient(tabId, ws, sessionKey, playerName) {
        const existingClient = this.#clientsByTabId.get(tabId);

        if (existingClient !== undefined && existingClient.ws !== ws) {
            this.#closeWebSocket(existingClient.ws, 1008, "Session replaced");
        }

        this.#unregisterGameConnection(ws);

        const client = { tabId, ws, sessionKey, playerName };

        this.#clientsByTabId.set(tabId, client);
        ws.tabId = tabId;

        let sessionTabIds = this.#sessionTabIdsBySessionKey.get(sessionKey);

        if (sessionTabIds === undefined) {
            sessionTabIds = new Set();
            this.#sessionTabIdsBySessionKey.set(sessionKey, sessionTabIds);
        }

        sessionTabIds.add(tabId);

        return client;
    }

    /**
     * Unregisters a client from a session.
     *
     * This does not mutate Session membership or move the socket to the game.
     *
     * @param {string} tabId - Tab ID.
     * @param {WebSocket} ws - Client WebSocket.
     */
    #unregisterClient(tabId, ws) {
        const client = this.#clientsByTabId.get(tabId);

        if (client !== undefined && client.ws === ws) {
            const sessionTabIds = this.#sessionTabIdsBySessionKey.get(client.sessionKey);

            if (sessionTabIds !== undefined) {
                sessionTabIds.delete(tabId);

                if (sessionTabIds.size === 0) {
                    this.#sessionTabIdsBySessionKey.delete(client.sessionKey);
                }
            }

            this.#clientsByTabId.delete(tabId);
        }

        this.#throttleGuard.reset(`player:${tabId}`);
        this.#throttleGuard.reset(`socket:${tabId}`);

        if (ws.tabId === tabId) {
            delete ws.tabId;
        }
    }

    /**
     * Finds a session client by player name.
     *
     * @param {string} sessionKey - Session key.
     * @param {string} playerName - Player name.
     * @returns {{tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}|null} Matching client.
     */
    #findClientByPlayer(sessionKey, playerName) {
        let matchingClient = null;

        for (const client of this.#clientsByTabId.values()) {
            if (matchingClient === null && client.sessionKey === sessionKey && client.playerName === playerName) {
                matchingClient = client;
            }
        }

        return matchingClient;
    }

    /**
     * Finds a session client by WebSocket.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @returns {{tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}|null} Matching client.
     */
    #findClientBySocket(ws) {
        let matchingClient = null;

        for (const client of this.#clientsByTabId.values()) {
            if (matchingClient === null && client.ws === ws) {
                matchingClient = client;
            }
        }

        return matchingClient;
    }

    /**
     * Checks whether a captured session client is still current.
     *
     * @param {{tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}} client - Captured client.
     * @returns {boolean} True when still current.
     */
    #isCurrentClient(client) {
        return this.#clientsByTabId.get(client.tabId) === client;
    }

    /**
     * Moves an idle player back to viewing state.
     *
     * @param {string} sessionKey - Session key.
     * @param {string} playerName - Idle player name.
     * @returns {Promise<void>}
     */
    async #moveIdlePlayerToView(sessionKey, playerName) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;
        const client = this.#findClientByPlayer(sessionKey, playerName);

        if (session !== null && client !== null) {
            const removedPlayer = await session.movePlayerToView(playerName, client.tabId);

            if (removedPlayer !== null) {
                if (this.#isCurrentClient(client)) {
                    client.playerName = null;

                    this.#sendResponse(client.ws, StateMapper.toResponse(
                        Constants.VIEWS.SESSION, StateMapper.toMessage(
                            Constants.STATUS.WARNING,
                            "Moved to viewers",
                            "You were idle."
                        ),
                        StateMapper.toSessionPayload(session, null)
                    ));

                    this.#scheduleSessionClosureIfEmpty(sessionKey);
                    await this.#continueAutomatedTurn(sessionKey);
                } else {
                    session.leaveViewer(client.tabId);
                    await this.#continueOrCloseSession(sessionKey);
                }
            }
        }
    }

    /**
     * Removes one session client.
     *
     * @param {{tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}} client - Session client.
     * @param {Session} session - Session instance.
     * @returns {Promise<void>}
     */
    async #leaveClient(client, session) {
        const sessionKey = await this.#removeClient(client, session);

        await this.#continueOrCloseSession(sessionKey);
    }

    /**
     * Removes one occupant without waiting for subsequent automated turns.
     *
     * @param {{tabId:string, ws:WebSocket, sessionKey:string, playerName:string|null}} client - Session client.
     * @param {Session} session - Session instance.
     * @returns {Promise<string>} Removed occupant's session key.
     */
    async #removeClient(client, session) {
        const sessionKey = client.sessionKey;
        const playerName = client.playerName;

        this.#unregisterClient(client.tabId, client.ws);

        if (playerName !== null) {
            await session.leavePlayer(playerName);
        } else {
            session.leaveViewer(client.tabId);
        }

        return sessionKey;
    }

    // -------------------------------------------------------------------------
    // Session closure and game continuation
    // -------------------------------------------------------------------------

    /**
     * Continues the game or closes the session if no players remain.
     *
     * @param {string} sessionKey - Session key.
     * @returns {Promise<boolean>} True when the session closed.
     */
    async #continueOrCloseSession(sessionKey) {
        const isSessionClosed = this.#closeSessionIfNoPlayersRemain(sessionKey);

        if (!isSessionClosed) {
            await this.#continueAutomatedTurn(sessionKey);
        }

        return isSessionClosed;
    }

    /**
     * Closes a session when no players remain.
     *
     * @param {string} sessionKey - Session key.
     * @returns {boolean} True when the session closed.
     */
    #closeSessionIfNoPlayersRemain(sessionKey) {
        let isSessionClosed = false;

        if (this.#isSessionEmpty(sessionKey) && !this.#sessionClosureTimersBySessionKey.has(sessionKey)) {
            this.#closeSession(sessionKey);
            isSessionClosed = true;
        }

        return isSessionClosed;
    }

    /**
     * Schedules a second empty-session check after the idle-player notification
     * grace period when the session is currently empty.
     *
     * @param {string} sessionKey - Session key.
     */
    #scheduleSessionClosureIfEmpty(sessionKey) {
        if (this.#isSessionEmpty(sessionKey)) {
            this.#cancelScheduledSessionClosure(sessionKey);

            const timeoutId = globalThis.setTimeout(() => {
                this.#sessionClosureTimersBySessionKey.delete(sessionKey);
                this.#closeSessionIfNoPlayersRemain(sessionKey);
            }, Constants.MAX_IDLE_MS);

            timeoutId.unref?.();
            this.#sessionClosureTimersBySessionKey.set(sessionKey, timeoutId);
        }
    }

    /**
     * Checks whether a registered session currently has no players.
     *
     * @param {string} sessionKey - Session key.
     * @returns {boolean} True when the session exists and has no players.
     */
    #isSessionEmpty(sessionKey) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;

        return session !== null && session.isEmpty();
    }

    /**
     * Cancels a pending empty-session closure check.
     *
     * @param {string} sessionKey - Session key.
     */
    #cancelScheduledSessionClosure(sessionKey) {
        const timeoutId = this.#sessionClosureTimersBySessionKey.get(sessionKey);

        if (timeoutId !== undefined) {
            globalThis.clearTimeout(timeoutId);
            this.#sessionClosureTimersBySessionKey.delete(sessionKey);
        }
    }

    /**
     * Closes a session and returns every viewer to the Game.
     *
     * @param {string} sessionKey - Session key.
     */
    #closeSession(sessionKey) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;

        if (session !== null) {
            this.#cancelScheduledSessionClosure(sessionKey);

            const sessionTabIds = Array.from(this.#sessionTabIdsBySessionKey.get(sessionKey) ?? []);
            const viewingClients = [];

            this.#clearSessionCallbacks(session);
            this.#sessionsByKey.delete(sessionKey);
            this.#sessionTabIdsBySessionKey.delete(sessionKey);
            this.#throttleGuard.reset(`session:${sessionKey}`);

            for (const tabId of sessionTabIds) {
                const client = this.#clientsByTabId.get(tabId);

                if (client !== undefined) {
                    viewingClients.push(client);
                    this.#unregisterClient(client.tabId, client.ws);
                }
            }

            const gameSync = this.#createGameSync();

            this.#broadcastGameSync(gameSync);

            for (const client of viewingClients) {
                this.#sendInvoluntaryGameTransition(
                    client.ws,
                    "Session closed",
                    "No players remain.",
                    gameSync
                );
            }
        }
    }

    /**
     * Continues AI turn processing while the session remains active.
     *
     * @param {string} sessionKey - Session key.
     * @returns {Promise<void>}
     */
    async #continueAutomatedTurn(sessionKey) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;

        if (session !== null && session.isActive()) {
            await this.#runAutomatedTurn(sessionKey);
        }
    }

    // -------------------------------------------------------------------------
    // Network transport and request routing
    // -------------------------------------------------------------------------

    /**
     * Starts the HTTP server.
     *
     * @param {number} port - Port.
     */
    #startHttpServer(port) {
        this.#httpServer.listen(port, "0.0.0.0", () => {
            console.log(`Server listening on http://localhost:${port}`);

            for (const url of Server.#getLanUrls(port)) {
                console.log(url);
            }
        });
    }

    /**
     * Gets available LAN URLs.
     *
     * @param {number} port - Port.
     * @returns {string[]} URLs.
     */
    static #getLanUrls(port) {
        const urls = [];
        const networks = os.networkInterfaces();

        for (const name of Object.keys(networks)) {
            const entries = networks[name] || [];

            for (const networkAddress of entries) {
                if (networkAddress !== null && networkAddress !== undefined && networkAddress.family === "IPv4" && !networkAddress.internal) {
                    urls.push(`http://${networkAddress.address}:${port}`);
                }
            }
        }

        return Array.from(new Set(urls));
    }

    /**
     * Handles a new WebSocket connection.
     *
     * @param {WebSocket} ws - Client WebSocket.
     */
    #handleWebSocketConnection(ws) {
        this.#registerGameConnection(ws);
        this.#sendViewSync(ws, Constants.VIEWS.GAME, this.#createGameSync());

        ws.on("message", (message) => {
            void this.#handleWebSocketMessage(ws, message);
        });

        ws.on("close", () => {
            void this.#handleWebSocketDisconnect(ws);
        });

        ws.on("error", () => {});
    }

    /**
     * Handles an inbound WebSocket message.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Buffer|string} message - Raw message.
     * @returns {Promise<void>}
     */
    async #handleWebSocketMessage(ws, message) {
        try {
            const parsed = this.#parseActionRequest(message);

            this.#throttleGuard.enforceSocketThrottle(ws, parsed.type);
            await this.#routeAction(ws, parsed.type, parsed.payload);
        } catch (error) {
            if (error instanceof UserNotification) {
                this.#sendErrorNotification(ws, error.message);
            } else {
                this.#sendErrorNotification(ws, "Server error occurred.");
                throw error;
            }
        }
    }

    /**
     * Parses an inbound client message.
     *
     * @param {Buffer|string} message - Raw message.
     * @returns {{type:string, payload:Object}} Parsed message.
     * @throws {Error}
     */
    #parseActionRequest(message) {
        let parsed;

        try {
            parsed = JSON.parse(String(message));
        } catch (error) {
            throw new Error("Invalid message.", {cause: error});
        }
        let payload = {};

        if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
            throw new Error("Invalid message.");
        }

        if (typeof parsed.payload === "object" && parsed.payload !== null) {
            payload = parsed.payload;
        }

        return {
            type: parsed.type,
            payload
        };
    }

    /**
     * Routes an action to its handler.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {string} type - Action type.
     * @param {Object} payload - Action payload.
     * @returns {Promise<void>}
     */
    async #routeAction(ws, type, payload) {
        const handlers = {
            [Constants.ACTIONS.LIST]: this.#list,
            [Constants.ACTIONS.CREATE]: this.#create,
            [Constants.ACTIONS.VIEW]: this.#view,
            [Constants.ACTIONS.JOIN]: this.#join,
            [Constants.ACTIONS.LEAVE]: this.#leave,
            [Constants.ACTIONS.START]: this.#start,
            [Constants.ACTIONS.DRAW]: this.#draw,
            [Constants.ACTIONS.DISCARD]: this.#discard,
            [Constants.ACTIONS.PASS]: this.#pass,
            [Constants.ACTIONS.DECLARE]: this.#declare
        };

        const handler = handlers[type];

        if (typeof handler !== "function") {
            throw new Error(`Unknown action: ${type}`);
        }

        await handler.call(this, ws, payload);
    }

    /**
     * Handles a disconnected WebSocket.
     *
     * Session clients are silently removed.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @returns {Promise<void>}
     */
    async #handleWebSocketDisconnect(ws) {
        this.#unregisterGameConnection(ws);

        const client = this.#findClientBySocket(ws);

        if (client !== null) {
            const session = this.#sessionsByKey.get(client.sessionKey) ?? null;

            if (session !== null) {
                await this.#leaveClient(client, session);
            } else {
                this.#unregisterClient(client.tabId, ws);
            }
        }
    }

    /**
     * Sends a server response.
     *
     * @param {WebSocket|null|undefined} ws - Client WebSocket.
     * @param {Object} response - Response payload.
     */
    #sendResponse(ws, response) {
        if (ws instanceof WebSocket && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
        }
    }

    /**
     * Sends a view synchronization response.
     *
     * @param {WebSocket|null|undefined} ws - Client WebSocket.
     * @param {string|null} view - View name.
     * @param {Object|null} sync - View payload.
     */
    #sendViewSync(ws, view, sync) {
        this.#sendResponse(ws, StateMapper.toResponse(view, null, sync));
    }

    /**
     * Sends an error response.
     *
     * @param {WebSocket|null|undefined} ws - Client WebSocket.
     * @param {string} message - Error message.
     */
    #sendErrorNotification(ws, message) {
        this.#sendUserNotification(ws, Constants.STATUS.ERROR, "Error", message);
    }

    /**
     * Sends a message response.
     *
     * @param {WebSocket|null|undefined} ws - Client WebSocket.
     * @param {string} status - Message status.
     * @param {string} title - Message title.
     * @param {string} message - Message text.
     */
    #sendUserNotification(ws, status, title, message) {
        this.#sendResponse(ws, StateMapper.toResponse(null, StateMapper.toMessage(status, title, message), null));
    }

    /**
     * Welcomes a new viewer.
     *
     * @param {WebSocket} ws - Viewer WebSocket.
     */
    #sendViewerWelcome(ws) {
        this.#sendUserNotification(
            ws,
            Constants.STATUS.INFO,
            "Welcome",
            "Enjoy the show or join in."
        );
    }

    /**
     * Welcomes a newly joined player and identifies their play area.
     *
     * @param {WebSocket} ws - Player WebSocket.
     * @param {string} playerName - Joined player name.
     */
    #sendPlayerWelcome(ws, playerName) {
        this.#sendUserNotification(
            ws,
            Constants.STATUS.INFO,
            `Welcome, ${playerName}!`,
            "Your hand is below the discard pile.\nGood luck!"
        );
    }

    /**
     * Sends a card-draw notification.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {number} count - Number of cards drawn.
     * @param {boolean} [isMocked=false] - True to add mock emoji to mock the move.
     */
    #sendDrawNotification(ws, count, isMocked = false) {
        if (count > 0) {
            const emoji = isMocked ? `\n\n${Constants.EMOJIS.silly.random}` : "";
            this.#sendUserNotification(ws, Constants.STATUS.INFO, "Cards Drawn", `+${count} ${emoji}`);
        }
    }

    // -------------------------------------------------------------------------
    // Client action handlers and their shared requirements
    // -------------------------------------------------------------------------

    /**
     * Handles LIST.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @returns {Promise<void>}
     */
    async #list(ws) {
        if (this.#findClientBySocket(ws) !== null) {
            throw new UserNotification("Exit the current session before viewing the game.");
        }

        this.#registerGameConnection(ws);
        this.#sendViewSync(ws, Constants.VIEWS.GAME, this.#createGameSync());
    }

    /**
     * Handles CREATE.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #create(ws, payload) {
        const tabId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const sessionName = NormalizeUtils.requiredString(payload.sessionName, "Session name");
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");
        const sessionKey = this.#normalizeSessionKey(sessionName);
        const capacity = this.#normalizeSessionCapacity(payload.capacity);

        this.#throttleGuard.enforcePlayerThrottle(tabId, Constants.ACTIONS.CREATE, 500);

        if (this.#clientsByTabId.has(tabId)) {
            throw new UserNotification("Exit the current session before creating another session.");
        }

        if (this.#sessionsByKey.has(sessionKey)) {
            throw new UserNotification(`Session already exists: ${sessionName}`);
        }

        const session = this.#registerSession(sessionName, capacity, sessionKey);

        try {
            const player = await session.join(playerName, false);

            this.#registerClient(tabId, ws, sessionKey, player.name);
            this.#sendSessionSync(ws, session, player.name);
            this.#sendPlayerWelcome(ws, player.name);
            this.#broadcastGameSync();
        } catch (error) {
            this.#clearSessionCallbacks(session);
            this.#sessionsByKey.delete(sessionKey);
            this.#sessionTabIdsBySessionKey.delete(sessionKey);

            throw error;
        }
    }

    /**
     * Resolves session capacity.
     *
     * @param {*} value - Raw capacity.
     * @returns {number} Capacity.
     */
    #normalizeSessionCapacity(value) {
        const parsedCapacity = Number(value || Constants.SESSION_MAX_CAPACITY);

        return Number.isInteger(parsedCapacity) ? parsedCapacity : Constants.SESSION_MAX_CAPACITY;
    }

    /**
     * Handles VIEW.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #view(ws, payload) {
        const {tabId, sessionKey, session, existingClient} = this.#requireSessionContext(
            ws, payload, Constants.ACTIONS.VIEW, 300
        );

        if (existingClient !== null && existingClient.sessionKey !== sessionKey) {
            throw new UserNotification("Exit the current session before viewing another session.");
        }

        if (existingClient === null) {
            session.view(tabId);
            this.#registerClient(tabId, ws, sessionKey, null);
            this.#sendSessionSync(ws, session, null);
            this.#sendViewerWelcome(ws);
        } else {
            this.#sendSessionSync(ws, session, this.#resolveClientPlayerName(session, existingClient));
        }
    }

    /** Joins a session as a player, whether it is already being viewed or not. */
    async #join(ws, payload) {
        const {tabId, sessionKey, session, existingClient} = this.#requireSessionContext(
            ws, payload, Constants.ACTIONS.JOIN, 500
        );
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");

        this.#assertPlayerNameAvailable(session, playerName);

        if (existingClient !== null && existingClient.sessionKey !== sessionKey) {
            throw new UserNotification("Leave the current session before joining another session.");
        }

        if (existingClient !== null && existingClient.playerName !== null) {
            throw new UserNotification("You already joined this session.");
        }

        const player = await session.join(playerName, false, existingClient === null ? null : tabId);

        if (existingClient === null) {
            this.#registerClient(tabId, ws, sessionKey, player.name);
        } else {
            existingClient.playerName = player.name;
        }

        const currentClient = this.#clientsByTabId.get(tabId);

        if (currentClient !== undefined && currentClient.ws === ws && currentClient.sessionKey === sessionKey) {
            currentClient.playerName = player.name;
            this.#sendSessionSync(ws, session, player.name);
            this.#sendPlayerWelcome(ws, player.name);
        }
    }

    /**
     * Resolves the shared context for viewing or joining a session.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Session payload.
     * @param {string} action - Session action.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,sessionKey:string,session:Session,existingClient:Object|null}} Session context.
     */
    #requireSessionContext(ws, payload, action, throttleMs) {
        const tabId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const {sessionKey, session} = this.#requirePayloadSession(payload);
        const existingClient = this.#clientsByTabId.get(tabId) ?? null;

        this.#throttleGuard.enforcePlayerThrottle(tabId, action, throttleMs);

        if (existingClient !== null && existingClient.ws !== ws) {
            throw new UserNotification("Your connection expired. Rejoin the session.");
        }

        return {tabId, sessionKey, session, existingClient};
    }

    /**
     * Resolves a required session from an action payload.
     *
     * @param {Object} payload - Action payload.
     * @returns {{sessionKey:string,session:Session}} Session context.
     */
    #requirePayloadSession(payload) {
        const sessionName = NormalizeUtils.requiredString(payload.sessionName, "Session name");
        const sessionKey = this.#normalizeSessionKey(sessionName);

        return {sessionKey, session: this.#requireSessionByKey(sessionKey)};
    }

    /**
     * Requires a player name that is not already present in a session.
     *
     * @param {Session} session - Target session.
     * @param {string} playerName - Requested player name.
     */
    #assertPlayerNameAvailable(session, playerName) {
        if (session.isPlayerPresent(playerName)) {
            throw new UserNotification(`Player already exists: ${playerName}`);
        }
    }

    /** Leaves the viewed or joined session. */
    async #leave(ws, payload) {
        const context = this.#requireThrottledClient(
            ws, payload, Constants.ACTIONS.LEAVE, 300
        );
        const session = this.#sessionsByKey.get(context.client.sessionKey) ?? null;

        if (session !== null) {
            const sessionKey = await this.#removeClient(context.client, session);

            this.#sendGameTransition(ws);
            await this.#continueOrCloseSession(sessionKey);
        } else {
            this.#unregisterClient(context.tabId, ws);
            this.#sendGameTransition(ws);
        }
    }

    /**
     * Requires a client currently viewing or playing in a session.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {{tabId:string, client:Object}} Client context.
     * @throws {Error}
     */
    #requireClient(ws, payload) {
        const tabId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const client = this.#clientsByTabId.get(tabId) ?? null;

        if (client === null || client.ws !== ws) {
            throw new UserNotification("Your connection expired. Rejoin the session.");
        }

        return { tabId, client };
    }

    /**
     * Requires a session client and applies its action throttle.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Action payload.
     * @param {string} action - Client action.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,client:Object}} Throttled client context.
     */
    #requireThrottledClient(ws, payload, action, throttleMs) {
        const context = this.#requireClient(ws, payload);

        this.#throttleGuard.enforcePlayerThrottle(context.tabId, action, throttleMs);

        return context;
    }

    /**
     * Requires a valid player session.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {{tabId:string, client:Object, sessionKey:string, session:Session, playerName:string}} Player session.
     * @throws {Error}
     */
    #requirePlayerSession(ws, payload) {
        const context = this.#requireClient(ws, payload);
        const client = context.client;

        if (client.playerName === null) {
            throw new UserNotification("Join the game before making a move.");
        }

        const session = this.#requireSessionByKey(client.sessionKey);

        if (!session.isPlayerPresent(client.playerName)) {
            throw new UserNotification("Your player session has expired. Rejoin the game.");
        }

        return {
            tabId: context.tabId,
            client,
            sessionKey: client.sessionKey,
            session,
            playerName: client.playerName
        };
    }

    /**
     * Requires a player session and applies player and optional session throttles.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Action payload.
     * @param {string} action - Player action.
     * @param {number} playerThrottleMs - Player throttle window.
     * @param {number|null} [sessionThrottleMs=null] - Optional session throttle window.
     * @returns {{tabId:string,client:Object,sessionKey:string,session:Session,playerName:string}} Player session.
     */
    #requireThrottledPlayerSession(ws, payload, action, playerThrottleMs, sessionThrottleMs = null) {
        const context = this.#requirePlayerSession(ws, payload);

        this.#throttleGuard.enforcePlayerThrottle(context.tabId, action, playerThrottleMs);

        if (sessionThrottleMs !== null) {
            this.#throttleGuard.enforceSessionThrottle(context.sessionKey, action, sessionThrottleMs);
        }

        return context;
    }

    /**
     * Handles START.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #start(ws, payload) {
        const context = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.START, 1000, 500
        );

        await context.session.start();
        await this.#runAutomatedTurn(context.sessionKey);
    }

    /**
     * Handles DRAW.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #draw(ws, payload) {
        const context = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.DRAW, 400, 100
        );

        const drawn = await context.session.drawCards(context.playerName, payload.sortKey);
        const count = drawn.length;

        this.#sendDrawNotification(ws, count, context.session.status === Constants.STATUS.PLAYING && count > 1);
        await this.#continueAutomatedTurn(context.sessionKey);
    }

    /**
     * Handles DISCARD.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #discard(ws, payload) {
        const context = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.DISCARD, 250, 100
        );
        const card = Card.from(payload.card);

        const drawn = await context.session.discardCard(context.playerName, card.value, card.suit, payload.sortKey);

        this.#sendDrawNotification(ws, drawn.length, true);
        await this.#continueAutomatedTurn(context.sessionKey);
    }

    /**
     * Handles PASS.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #pass(ws, payload) {
        const context = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.PASS, 250, 100
        );

        const drawn = await context.session.passTurn(context.playerName, payload.sortKey);

        this.#sendDrawNotification(ws, drawn.length, true);
        await this.#continueAutomatedTurn(context.sessionKey);
    }

    /**
     * Handles DECLARE.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #declare(ws, payload) {
        const context = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.DECLARE, 250, 100
        );
        const suit = this.#requireSuit(payload.suit);

        await context.session.declareSuit(suit);
        await this.#continueAutomatedTurn(context.sessionKey);
    }

    /**
     * Requires a standard card suit.
     *
     * @param {*} value - Suit value.
     * @returns {string} Normalized suit.
     * @throws {Error}
     */
    #requireSuit(value) {
        return Constants.normalizeStandardSuit(NormalizeUtils.requiredString(value, "Suit"));
    }

    /**
     * Handles AI turns and suit declarations.
     *
     * @param {string} sessionKey - Session key.
     * @returns {Promise<void>}
     */
    async #runAutomatedTurn(sessionKey) {
        const session = this.#sessionsByKey.get(sessionKey) ?? null;

        if (session !== null) {
            if (session.status === Constants.STATUS.PENDING) {
                const turnOwner = session.circle.getTurnOwner();

                if (turnOwner instanceof AIPlayer) {
                    await turnOwner.chooseSuit(session);
                    await this.#runAutomatedTurn(sessionKey);
                }
            } else if (session.status === Constants.STATUS.PLAYING) {
                const turnOwner = session.circle.getTurnOwner();

                if (turnOwner instanceof AIPlayer) {
                    await turnOwner.takeTurn(session);
                    await this.#runAutomatedTurn(sessionKey);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Socket cleanup
    // -------------------------------------------------------------------------

    /**
     * Closes a WebSocket safely.
     *
     * @param {WebSocket|null|undefined} ws - Client WebSocket.
     * @param {number} code - Close code.
     * @param {string} reason - Close reason.
     */
    #closeWebSocket(ws, code = 1000, reason = "Closed") {
        if (ws instanceof WebSocket) {
            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close(code, reason);
                }
            } catch (_error) {
                ws.terminate();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Shutdown implementation
    // -------------------------------------------------------------------------

    /**
     * Stops the server and releases all resources.
     *
     * @returns {Promise<void>} Resolves when shutdown completes.
     */
    async #destroy() {
        this.#stopHeartbeat();

        for (const timeoutId of this.#sessionClosureTimersBySessionKey.values()) {
            globalThis.clearTimeout(timeoutId);
        }

        this.#sessionClosureTimersBySessionKey.clear();

        for (const session of this.#sessionsByKey.values()) {
            this.#clearSessionCallbacks(session);
        }

        this.#sessionsByKey.clear();
        this.#sessionTabIdsBySessionKey.clear();
        this.#clientsByTabId.clear();
        this.#gameConnections.clear();
        this.#throttleGuard.resetAll();

        for (const ws of Array.from(this.#webSocketServer.clients)) {
            try {
                ws.terminate();
            } catch (error) {
                console.error("Failed to terminate WebSocket client:", error);
            }
        }

        const results = await Promise.allSettled([
            this.#closeWebSocketServer(),
            this.#closeHttpServer()
        ]);

        this.#webSocketServer.removeAllListeners();
        this.#httpServer.removeAllListeners();

        const errors = [];

        for (const result of results) {
            if (result.status === "rejected") {
                errors.push(result.reason);
            }
        }

        if (errors.length > 0) {
            throw new AggregateError(errors, "Server shutdown failed.");
        }
    }

    /**
     * Stops the WebSocket server.
     *
     * @returns {Promise<void>} Resolves when closed.
     */
    #closeWebSocketServer() {
        return new Promise((resolve, reject) => {
            this.#webSocketServer.close((error) => {
                if (error instanceof Error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Stops the HTTP server.
     *
     * @returns {Promise<void>} Resolves when closed.
     */
    #closeHttpServer() {
        return new Promise((resolve, reject) => {
            this.#httpServer.close((error) => {
                if (error instanceof Error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
}
