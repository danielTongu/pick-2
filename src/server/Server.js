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
import { Room } from "../core/Room.js";
import { StateMapper } from "../core/StateMapper.js";
import { ThrottleGuard } from "./ThrottleGuard.js";

/**
 * HTTP and WebSocket server for the card game.
 *
 * Membership transitions:
 * - Outside -> Visitor: admit
 * - Outside -> Player: admit
 * - Visitor -> Player: promote
 * - Player -> Visitor: demote
 * - Visitor -> Outside: evict
 * - Player -> Outside: evict
 *
 * Room owns room membership and game state.
 * Server owns sockets, sessions, notifications, and room registration.
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

    /** @type {Map<string, Room>} */
    #roomsByKey = new Map();

    /** @type {Map<string, Set<string>>} */
    #roomTabIdsByRoomKey = new Map();

    /** @type {Map<string, NodeJS.Timeout>} */
    #roomClosureTimersByRoomKey = new Map();

    /** @type {Map<string, {tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}>} */
    #roomSessionsByTabId = new Map();

    /** @type {Set<WebSocket>} */
    #lobbyConnections = new Set();

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
        this.#initializeDefaultRooms();
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
        const publicPath = path.join(repositoryPath, "web/server");
        const sharedPath = path.join(repositoryPath, "web/shared");
        const sourcePath = path.join(repositoryPath, "src");
        const indexPath = path.join(publicPath, "index.html");

        app.use("/shared", express.static(sharedPath));
        app.use("/src", express.static(sourcePath));
        app.use(express.static(publicPath));

        app.get("/", (_request, response) => {
            response.sendFile(indexPath);
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
    // Room registry and state publication
    // -------------------------------------------------------------------------

    /**
     * Creates the default rooms and AI players.
     */
    #initializeDefaultRooms() {
        for (const [roomIndex, roomName] of Constants.DEFAULT_ROOM_NAMES.entries()) {
            const roomKey = this.#normalizeRoomKey(roomName);
            const room = this.#registerRoom(roomName, Constants.ROOM_MAX_CAPACITY, roomKey);

            void room.admitPlayer("AI-Player", true);

            if (roomIndex < Constants.DEFAULT_DUAL_AI_ROOM_COUNT) {
                void room.admitPlayer("AI-Player-2", true);
            }
        }
    }

    /**
     * Builds a normalized key from a name.
     *
     * @param {string} name - Name.
     * @returns {string} Normalized key.
     */
    #normalizeRoomKey(name) {
        return Player.normalizeKey(name);
    }

    /**
     * Creates and registers a room.
     *
     * @param {string} roomName - Room name.
     * @param {number} capacity - Player capacity.
     * @param {string} roomKey - Room key.
     * @returns {Room} Registered room.
     */
    #registerRoom(roomName, capacity, roomKey) {
        const room = new Room(roomName, capacity);

        room.onAnyChange = () => {
            this.#broadcastRoomSync(roomKey);
        };

        room.onPlayerDemotionRequested = (_changedRoom, playerName) => {
            void this.#demoteIdlePlayerToVisitor(roomKey, playerName);
        };

        this.#roomsByKey.set(roomKey, room);
        this.#roomTabIdsByRoomKey.set(roomKey, new Set());

        return room;
    }

    /**
     * Removes server callbacks from a room.
     *
     * @param {Room} room - Room instance.
     */
    #clearRoomCallbacks(room) {
        room.onAnyChange = null;
        room.onPlayerDemotionRequested = null;
    }

    /**
     * Gets a registered room.
     *
     * @param {string} roomKey - Room key.
     * @returns {Room} Room instance.
     * @throws {Error}
     */
    #requireRoomByKey(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room === null) {
            throw new UserNotification("Room not found.");
        }

        return room;
    }

    /**
     * Broadcasts current room state to every room occupant.
     *
     * @param {string} roomKey - Room key.
     */
    #broadcastRoomSync(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            const roomTabIds = this.#roomTabIdsByRoomKey.get(roomKey);

            if (roomTabIds !== undefined) {
                for (const tabId of roomTabIds) {
                    const roomSession = this.#roomSessionsByTabId.get(tabId);

                    if (roomSession !== undefined && roomSession.ws.readyState === WebSocket.OPEN) {
                        this.#sendRoomSync(roomSession.ws, room, this.#resolveRoomSessionPlayerName(room, roomSession));
                    }
                }
            }

            if (room.status === Constants.STATUS.FINISHED) {
                room.status = Constants.STATUS.WAITING;
            }
        }
    }

    /**
     * Resolves a room session's player name against current membership.
     *
     * @param {Room} room - Room instance.
     * @param {{playerName:string|null}} roomSession - Room session.
     * @returns {string|null} Valid player name or null.
     */
    #resolveRoomSessionPlayerName(room, roomSession) {
        let playerName = null;

        if (roomSession.playerName !== null && room.isPlayerPresent(roomSession.playerName)) {
            playerName = roomSession.playerName;
        }

        return playerName;
    }

    /**
     * Sends room state to one client.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Room} room - Room instance.
     * @param {string|null} playerName - Session player name.
     */
    #sendRoomSync(ws, room, playerName) {
        this.#sendViewSync(ws, Constants.VIEWS.ROOM, StateMapper.toRoomPayload(room, playerName));
    }

    /**
     * Registers a socket as currently viewing the lobby.
     *
     * @param {WebSocket} ws - Client WebSocket.
     */
    #registerLobbyConnection(ws) {
        if (ws.readyState === WebSocket.OPEN) {
            this.#lobbyConnections.add(ws);
        }
    }

    /**
     * Removes a socket from lobby tracking.
     *
     * @param {WebSocket} ws - Client WebSocket.
     */
    #unregisterLobbyConnection(ws) {
        this.#lobbyConnections.delete(ws);
    }

    /**
     * Broadcasts the current lobby synchronization payload.
     *
     * @param {{rooms:Object[]}|null} lobbySync - Optional prebuilt lobby payload.
     */
    #broadcastLobbySync(lobbySync = null) {
        const resolvedLobbySync = lobbySync ?? this.#createLobbySync();

        for (const ws of Array.from(this.#lobbyConnections)) {
            if (ws.readyState === WebSocket.OPEN) {
                this.#sendViewSync(ws, Constants.VIEWS.LOBBY, resolvedLobbySync);
            } else {
                this.#lobbyConnections.delete(ws);
            }
        }
    }

    /**
     * Creates the lobby synchronization payload.
     *
     * @returns {{rooms:Object[]}} Lobby payload.
     */
    #createLobbySync() {
        return StateMapper.toLobbyPayload(this.#roomsByKey.values());
    }

    /**
     * Sends a normal transition to the lobby.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {{rooms:Object[]}|null} lobbySync - Optional prebuilt lobby payload.
     */
    #sendLobbyTransition(ws, lobbySync = null) {
        const resolvedLobbySync = lobbySync ?? this.#createLobbySync();

        this.#registerLobbyConnection(ws);
        this.#sendViewSync(ws, Constants.VIEWS.LOBBY, resolvedLobbySync);
    }

    /**
     * Sends an involuntary eviction notification and lobby state.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {string} title - Warning title.
     * @param {string} message - Warning message.
     * @param {{rooms:Object[]}|null} lobbySync - Optional prebuilt lobby payload.
     */
    #sendInvoluntaryLobbyTransition(ws, title, message, lobbySync = null) {
        const resolvedLobbySync = lobbySync ?? this.#createLobbySync();

        this.#registerLobbyConnection(ws);
        this.#sendResponse(ws, StateMapper.toResponse(
            Constants.VIEWS.LOBBY,
            StateMapper.toMessage(Constants.STATUS.WARNING, title, message),
            resolvedLobbySync
        ));
    }

    // -------------------------------------------------------------------------
    // Client sessions and membership transitions
    // -------------------------------------------------------------------------

    /**
     * Registers a client room session.
     *
     * @param {string} tabId - Tab ID.
     * @param {WebSocket} ws - Client WebSocket.
     * @param {string} roomKey - Room key.
     * @param {string|null} playerName - Player name.
     * @returns {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}} Registered room session.
     */
    #registerRoomSession(tabId, ws, roomKey, playerName) {
        const existingRoomSession = this.#roomSessionsByTabId.get(tabId);

        if (existingRoomSession !== undefined && existingRoomSession.ws !== ws) {
            this.#closeWebSocket(existingRoomSession.ws, 1008, "Session replaced");
        }

        this.#unregisterLobbyConnection(ws);

        const roomSession = { tabId, ws, roomKey, playerName };

        this.#roomSessionsByTabId.set(tabId, roomSession);
        ws.tabId = tabId;

        let roomTabIds = this.#roomTabIdsByRoomKey.get(roomKey);

        if (roomTabIds === undefined) {
            roomTabIds = new Set();
            this.#roomTabIdsByRoomKey.set(roomKey, roomTabIds);
        }

        roomTabIds.add(tabId);

        return roomSession;
    }

    /**
     * Unregisters a client room session.
     *
     * This does not mutate Room membership or move the socket to the lobby.
     *
     * @param {string} tabId - Tab ID.
     * @param {WebSocket} ws - Client WebSocket.
     */
    #unregisterRoomSession(tabId, ws) {
        const roomSession = this.#roomSessionsByTabId.get(tabId);

        if (roomSession !== undefined && roomSession.ws === ws) {
            const roomTabIds = this.#roomTabIdsByRoomKey.get(roomSession.roomKey);

            if (roomTabIds !== undefined) {
                roomTabIds.delete(tabId);

                if (roomTabIds.size === 0) {
                    this.#roomTabIdsByRoomKey.delete(roomSession.roomKey);
                }
            }

            this.#roomSessionsByTabId.delete(tabId);
        }

        this.#throttleGuard.reset(`player:${tabId}`);
        this.#throttleGuard.reset(`socket:${tabId}`);

        if (ws.tabId === tabId) {
            delete ws.tabId;
        }
    }

    /**
     * Finds a room session by room and player name.
     *
     * @param {string} roomKey - Room key.
     * @param {string} playerName - Player name.
     * @returns {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}|null} Matching room session.
     */
    #findRoomSessionByPlayer(roomKey, playerName) {
        let matchingRoomSession = null;

        for (const roomSession of this.#roomSessionsByTabId.values()) {
            if (matchingRoomSession === null && roomSession.roomKey === roomKey && roomSession.playerName === playerName) {
                matchingRoomSession = roomSession;
            }
        }

        return matchingRoomSession;
    }

    /**
     * Finds a room session by WebSocket.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @returns {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}|null} Matching room session.
     */
    #findRoomSessionBySocket(ws) {
        let matchingRoomSession = null;

        for (const roomSession of this.#roomSessionsByTabId.values()) {
            if (matchingRoomSession === null && roomSession.ws === ws) {
                matchingRoomSession = roomSession;
            }
        }

        return matchingRoomSession;
    }

    /**
     * Checks whether a captured room session is still current.
     *
     * @param {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}} roomSession - Captured room session.
     * @returns {boolean} True when still current.
     */
    #isCurrentRoomSession(roomSession) {
        return this.#roomSessionsByTabId.get(roomSession.tabId) === roomSession;
    }

    /**
     * Promotes a visitor to player status.
     *
     * Transition: Visitor -> Player.
     *
     * @param {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}} roomSession - Visitor room session.
     * @param {Room} room - Room instance.
     * @param {string} playerName - Requested player name.
     * @returns {Promise<Player>} Promoted player.
     */
    async #promoteVisitorSession(roomSession, room, playerName) {
        const previousPlayerName = roomSession.playerName;

        roomSession.playerName = playerName;

        try {
            const player = await room.promoteVisitor(roomSession.tabId, playerName);

            if (this.#isCurrentRoomSession(roomSession)) {
                roomSession.playerName = player.name;
            } else {
                await room.evictPlayer(player.name);
                await this.#continueGameOrCloseRoom(roomSession.roomKey);
            }

            return player;
        } catch (error) {
            if (this.#isCurrentRoomSession(roomSession)) {
                roomSession.playerName = previousPlayerName;
            }

            throw error;
        }
    }

    /**
     * Demotes an idle player to visitor status.
     *
     * Transition: Player -> Visitor.
     *
     * @param {string} roomKey - Room key.
     * @param {string} playerName - Idle player name.
     * @returns {Promise<void>}
     */
    async #demoteIdlePlayerToVisitor(roomKey, playerName) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        const roomSession = this.#findRoomSessionByPlayer(roomKey, playerName);

        if (room !== null && roomSession !== null) {
            const demotedPlayer = await room.demotePlayer(playerName, roomSession.tabId);

            if (demotedPlayer !== null) {
                if (this.#isCurrentRoomSession(roomSession)) {
                    roomSession.playerName = null;

                    this.#sendResponse(roomSession.ws, StateMapper.toResponse(
                        Constants.VIEWS.ROOM, StateMapper.toMessage(
                            Constants.STATUS.WARNING,
                            "Moved to visitors",
                            "You were idle."
                        ),
                        StateMapper.toRoomPayload(room, null)
                    ));

                    this.#scheduleRoomClosureIfEmpty(roomKey);
                    await this.#continueAutomatedTurn(roomKey);
                } else {
                    room.evictVisitor(roomSession.tabId);
                    await this.#continueGameOrCloseRoom(roomKey);
                }
            }
        }
    }

    /**
     * Evicts one room occupant.
     *
     * @param {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}} roomSession - Room session.
     * @param {Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async #evictRoomSession(roomSession, room) {
        const roomKey = await this.#removeRoomSession(roomSession, room);

        await this.#continueGameOrCloseRoom(roomKey);
    }

    /**
     * Removes one occupant without waiting for subsequent automated turns.
     *
     * @param {{tabId:string, ws:WebSocket, roomKey:string, playerName:string|null}} roomSession - Room session.
     * @param {Room} room - Room instance.
     * @returns {Promise<string>} Removed occupant's room key.
     */
    async #removeRoomSession(roomSession, room) {
        const roomKey = roomSession.roomKey;
        const playerName = roomSession.playerName;

        this.#unregisterRoomSession(roomSession.tabId, roomSession.ws);

        if (playerName !== null) {
            await room.evictPlayer(playerName);
        } else {
            room.evictVisitor(roomSession.tabId);
        }

        return roomKey;
    }

    // -------------------------------------------------------------------------
    // Room closure and game continuation
    // -------------------------------------------------------------------------

    /**
     * Continues the game or closes the room if no players remain.
     *
     * @param {string} roomKey - Room key.
     * @returns {Promise<boolean>} True when the room closed.
     */
    async #continueGameOrCloseRoom(roomKey) {
        const isRoomClosed = this.#closeRoomIfNoPlayersRemain(roomKey);

        if (!isRoomClosed) {
            await this.#continueAutomatedTurn(roomKey);
        }

        return isRoomClosed;
    }

    /**
     * Closes a room when no players remain.
     *
     * @param {string} roomKey - Room key.
     * @returns {boolean} True when the room closed.
     */
    #closeRoomIfNoPlayersRemain(roomKey) {
        let isRoomClosed = false;

        if (this.#isRoomEmpty(roomKey) && !this.#roomClosureTimersByRoomKey.has(roomKey)) {
            this.#closeRoomAndEvictVisitors(roomKey);
            isRoomClosed = true;
        }

        return isRoomClosed;
    }

    /**
     * Schedules a second empty-room check after the idle-player notification
     * grace period when the room is currently empty.
     *
     * @param {string} roomKey - Room key.
     */
    #scheduleRoomClosureIfEmpty(roomKey) {
        if (this.#isRoomEmpty(roomKey)) {
            this.#cancelScheduledRoomClosure(roomKey);

            const timeoutId = globalThis.setTimeout(() => {
                this.#roomClosureTimersByRoomKey.delete(roomKey);
                this.#closeRoomIfNoPlayersRemain(roomKey);
            }, Constants.MAX_IDLE_MS);

            timeoutId.unref?.();
            this.#roomClosureTimersByRoomKey.set(roomKey, timeoutId);
        }
    }

    /**
     * Checks whether a registered room currently has no players.
     *
     * @param {string} roomKey - Room key.
     * @returns {boolean} True when the room exists and has no players.
     */
    #isRoomEmpty(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        return room !== null && room.isEmpty();
    }

    /**
     * Cancels a pending empty-room closure check.
     *
     * @param {string} roomKey - Room key.
     */
    #cancelScheduledRoomClosure(roomKey) {
        const timeoutId = this.#roomClosureTimersByRoomKey.get(roomKey);

        if (timeoutId !== undefined) {
            globalThis.clearTimeout(timeoutId);
            this.#roomClosureTimersByRoomKey.delete(roomKey);
        }
    }

    /**
     * Closes a room and involuntarily evicts every remaining visitor.
     *
     * @param {string} roomKey - Room key.
     */
    #closeRoomAndEvictVisitors(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            this.#cancelScheduledRoomClosure(roomKey);

            const roomTabIds = Array.from(this.#roomTabIdsByRoomKey.get(roomKey) ?? []);
            const evictedVisitorSessions = [];

            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            this.#roomTabIdsByRoomKey.delete(roomKey);
            this.#throttleGuard.reset(`room:${roomKey}`);

            for (const tabId of roomTabIds) {
                const roomSession = this.#roomSessionsByTabId.get(tabId);

                if (roomSession !== undefined) {
                    evictedVisitorSessions.push(roomSession);
                    this.#unregisterRoomSession(roomSession.tabId, roomSession.ws);
                }
            }

            const lobbySync = this.#createLobbySync();

            this.#broadcastLobbySync(lobbySync);

            for (const roomSession of evictedVisitorSessions) {
                this.#sendInvoluntaryLobbyTransition(
                    roomSession.ws,
                    "Room closed",
                    "No players remain.",
                    lobbySync
                );
            }
        }
    }

    /**
     * Continues AI turn processing while the room remains active.
     *
     * @param {string} roomKey - Room key.
     * @returns {Promise<void>}
     */
    async #continueAutomatedTurn(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null && room.isGameActive()) {
            await this.#runAutomatedTurn(roomKey);
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
        this.#registerLobbyConnection(ws);
        this.#sendViewSync(ws, Constants.VIEWS.LOBBY, this.#createLobbySync());

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
            [Constants.ACTIONS.VIEW_LOBBY]: this.#viewLobby,
            [Constants.ACTIONS.CREATE_ROOM]: this.#createRoom,
            [Constants.ACTIONS.ADMIT_VISITOR]: this.#admitVisitor,
            [Constants.ACTIONS.ADMIT_PLAYER]: this.#admitPlayer,
            [Constants.ACTIONS.PROMOTE_VISITOR]: this.#promoteVisitor,
            [Constants.ACTIONS.DEMOTE_PLAYER]: this.#demotePlayer,
            [Constants.ACTIONS.EVICT_OCCUPANT]: this.#evictOccupant,
            [Constants.ACTIONS.START_GAME]: this.#startGame,
            [Constants.ACTIONS.DRAW_CARD]: this.#drawCard,
            [Constants.ACTIONS.DISCARD_CARD]: this.#discardCard,
            [Constants.ACTIONS.PASS_PLAYER]: this.#passTurn,
            [Constants.ACTIONS.SUIT_CHANGE]: this.#suitChange
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
     * Room occupants are silently evicted.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @returns {Promise<void>}
     */
    async #handleWebSocketDisconnect(ws) {
        this.#unregisterLobbyConnection(ws);

        const roomSession = this.#findRoomSessionBySocket(ws);

        if (roomSession !== null) {
            const room = this.#roomsByKey.get(roomSession.roomKey) ?? null;

            if (room !== null) {
                await this.#evictRoomSession(roomSession, room);
            } else {
                this.#unregisterRoomSession(roomSession.tabId, ws);
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
     * Welcomes a newly admitted visitor.
     *
     * @param {WebSocket} ws - Visitor WebSocket.
     */
    #sendVisitorWelcome(ws) {
        this.#sendUserNotification(
            ws,
            Constants.STATUS.INFO,
            "Welcome",
            "Enjoy the show or join in."
        );
    }

    /**
     * Welcomes a newly admitted player and identifies their play area.
     *
     * @param {WebSocket} ws - Player WebSocket.
     * @param {string} playerName - Admitted player name.
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
     * Handles VIEW_LOBBY.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @returns {Promise<void>}
     */
    async #viewLobby(ws) {
        if (this.#findRoomSessionBySocket(ws) !== null) {
            throw new UserNotification("Exit the current room before viewing the lobby.");
        }

        this.#registerLobbyConnection(ws);
        this.#sendViewSync(ws, Constants.VIEWS.LOBBY, this.#createLobbySync());
    }

    /**
     * Handles CREATE_ROOM.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #createRoom(ws, payload) {
        const tabId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const roomName = NormalizeUtils.requiredString(payload.roomName, "Room name");
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");
        const roomKey = this.#normalizeRoomKey(roomName);
        const capacity = this.#normalizeRoomCapacity(payload.capacity);

        this.#throttleGuard.enforcePlayerThrottle(tabId, Constants.ACTIONS.CREATE_ROOM, 500);

        if (this.#roomSessionsByTabId.has(tabId)) {
            throw new UserNotification("Exit the current room before creating another room.");
        }

        if (this.#roomsByKey.has(roomKey)) {
            throw new UserNotification(`Room already exists: ${roomName}`);
        }

        const room = this.#registerRoom(roomName, capacity, roomKey);

        try {
            const player = await room.admitPlayer(playerName, false);

            this.#registerRoomSession(tabId, ws, roomKey, player.name);
            this.#sendRoomSync(ws, room, player.name);
            this.#sendPlayerWelcome(ws, player.name);
            this.#broadcastLobbySync();
        } catch (error) {
            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            this.#roomTabIdsByRoomKey.delete(roomKey);

            throw error;
        }
    }

    /**
     * Resolves room capacity.
     *
     * @param {*} value - Raw capacity.
     * @returns {number} Capacity.
     */
    #normalizeRoomCapacity(value) {
        const parsedCapacity = Number(value || Constants.ROOM_MAX_CAPACITY);

        return Number.isInteger(parsedCapacity) ? parsedCapacity : Constants.ROOM_MAX_CAPACITY;
    }

    /**
     * Handles ADMIT_VISITOR.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #admitVisitor(ws, payload) {
        const {tabId, roomKey, room, existingRoomSession} = this.#requireAdmissionContext(
            ws, payload, Constants.ACTIONS.ADMIT_VISITOR, 300
        );

        if (existingRoomSession !== null && existingRoomSession.roomKey !== roomKey) {
            throw new UserNotification("Exit the current room before viewing another room.");
        }

        if (existingRoomSession === null) {
            room.admitVisitor(tabId);
            this.#registerRoomSession(tabId, ws, roomKey, null);
            this.#sendRoomSync(ws, room, null);
            this.#sendVisitorWelcome(ws);
        } else {
            this.#sendRoomSync(ws, room, this.#resolveRoomSessionPlayerName(room, existingRoomSession));
        }
    }

    /**
     * Handles ADMIT_PLAYER.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #admitPlayer(ws, payload) {
        const {tabId, roomKey, room, existingRoomSession} = this.#requireAdmissionContext(
            ws, payload, Constants.ACTIONS.ADMIT_PLAYER, 500
        );
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");

        this.#assertPlayerNameAvailable(room, playerName);

        if (existingRoomSession !== null) {
            throw new UserNotification("Client is already admitted to a room.");
        }

        const player = await room.admitPlayer(playerName, false);
        this.#registerRoomSession(tabId, ws, roomKey, player.name);

        const currentRoomSession = this.#roomSessionsByTabId.get(tabId);

        if (currentRoomSession !== undefined && currentRoomSession.ws === ws && currentRoomSession.roomKey === roomKey) {
            currentRoomSession.playerName = player.name;
            this.#sendRoomSync(ws, room, player.name);
            this.#sendPlayerWelcome(ws, player.name);
        }
    }

    /**
     * Validates and resolves the shared context for direct room admission.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Admission payload.
     * @param {string} action - Admission action.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,roomKey:string,room:Room,existingRoomSession:Object|null}} Admission context.
     */
    #requireAdmissionContext(ws, payload, action, throttleMs) {
        const tabId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const {roomKey, room} = this.#requirePayloadRoom(payload);
        const existingRoomSession = this.#roomSessionsByTabId.get(tabId) ?? null;

        this.#throttleGuard.enforcePlayerThrottle(tabId, action, throttleMs);

        if (existingRoomSession !== null && existingRoomSession.ws !== ws) {
            throw new UserNotification("Your room session has expired. Rejoin the room.");
        }

        return {tabId, roomKey, room, existingRoomSession};
    }

    /**
     * Resolves a required room from an action payload.
     *
     * @param {Object} payload - Action payload.
     * @returns {{roomKey:string,room:Room}} Room context.
     */
    #requirePayloadRoom(payload) {
        const roomName = NormalizeUtils.requiredString(payload.roomName, "Room name");
        const roomKey = this.#normalizeRoomKey(roomName);

        return {roomKey, room: this.#requireRoomByKey(roomKey)};
    }

    /**
     * Requires a player name that is not already present in a room.
     *
     * @param {Room} room - Target room.
     * @param {string} playerName - Requested player name.
     */
    #assertPlayerNameAvailable(room, playerName) {
        if (room.isPlayerPresent(playerName)) {
            throw new UserNotification(`Player already exists: ${playerName}`);
        }
    }

    /**
     * Handles PROMOTE_VISITOR.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #promoteVisitor(ws, payload) {
        const session = this.#requireThrottledRoomSession(
            ws, payload, Constants.ACTIONS.PROMOTE_VISITOR, 500
        );
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");
        const {roomKey, room} = this.#requirePayloadRoom(payload);

        if (session.roomSession.roomKey !== roomKey || session.roomSession.playerName !== null) {
            throw new UserNotification("Only a visitor in this room can be promoted.");
        }

        this.#assertPlayerNameAvailable(room, playerName);

        const player = await this.#promoteVisitorSession(session.roomSession, room, playerName);

        if (this.#isCurrentRoomSession(session.roomSession)) {
            this.#sendRoomSync(ws, room, player.name);
            this.#sendPlayerWelcome(ws, player.name);
        }
    }

    /**
     * Handles DEMOTE_PLAYER.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #demotePlayer(ws, payload) {
        const session = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.DEMOTE_PLAYER, 300
        );

        await session.room.demotePlayer(session.playerName, session.tabId);
        session.roomSession.playerName = null;
        this.#sendRoomSync(ws, session.room, null);
        await this.#continueGameOrCloseRoom(session.roomKey);
    }

    /**
     * Handles EVICT_OCCUPANT.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #evictOccupant(ws, payload) {
        const session = this.#requireThrottledRoomSession(
            ws, payload, Constants.ACTIONS.EVICT_OCCUPANT, 300
        );
        const room = this.#roomsByKey.get(session.roomSession.roomKey) ?? null;

        if (room !== null) {
            const roomKey = await this.#removeRoomSession(session.roomSession, room);

            this.#sendLobbyTransition(ws);
            await this.#continueGameOrCloseRoom(roomKey);
        } else {
            this.#unregisterRoomSession(session.tabId, ws);
            this.#sendLobbyTransition(ws);
        }
    }

    /**
     * Requires a valid client room session.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {{tabId:string, roomSession:Object}} Room session context.
     * @throws {Error}
     */
    #requireRoomSession(ws, payload) {
        const tabId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const roomSession = this.#roomSessionsByTabId.get(tabId) ?? null;

        if (roomSession === null || roomSession.ws !== ws) {
            throw new UserNotification("Your room session has expired. Rejoin the room.");
        }

        return { tabId, roomSession };
    }

    /**
     * Requires a room session and applies its action throttle.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Action payload.
     * @param {string} action - Client action.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,roomSession:Object}} Throttled room session context.
     */
    #requireThrottledRoomSession(ws, payload, action, throttleMs) {
        const session = this.#requireRoomSession(ws, payload);

        this.#throttleGuard.enforcePlayerThrottle(session.tabId, action, throttleMs);

        return session;
    }

    /**
     * Requires a valid player session.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {{tabId:string, roomSession:Object, roomKey:string, room:Room, playerName:string}} Player session.
     * @throws {Error}
     */
    #requirePlayerSession(ws, payload) {
        const session = this.#requireRoomSession(ws, payload);
        const roomSession = session.roomSession;

        if (roomSession.playerName === null) {
            throw new UserNotification("Join the game before making a move.");
        }

        const room = this.#requireRoomByKey(roomSession.roomKey);

        if (!room.isPlayerPresent(roomSession.playerName)) {
            throw new UserNotification("Your player session has expired. Rejoin the game.");
        }

        return {
            tabId: session.tabId,
            roomSession,
            roomKey: roomSession.roomKey,
            room,
            playerName: roomSession.playerName
        };
    }

    /**
     * Requires a player session and applies player and optional room throttles.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Action payload.
     * @param {string} action - Player action.
     * @param {number} playerThrottleMs - Player throttle window.
     * @param {number|null} [roomThrottleMs=null] - Optional room throttle window.
     * @returns {{tabId:string,roomSession:Object,roomKey:string,room:Room,playerName:string}} Player session.
     */
    #requireThrottledPlayerSession(ws, payload, action, playerThrottleMs, roomThrottleMs = null) {
        const session = this.#requirePlayerSession(ws, payload);

        this.#throttleGuard.enforcePlayerThrottle(session.tabId, action, playerThrottleMs);

        if (roomThrottleMs !== null) {
            this.#throttleGuard.enforceRoomThrottle(session.roomKey, action, roomThrottleMs);
        }

        return session;
    }

    /**
     * Handles START_GAME.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #startGame(ws, payload) {
        const session = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.START_GAME, 1000, 500
        );

        await session.room.startGame();
        await this.#runAutomatedTurn(session.roomKey);
    }

    /**
     * Handles DRAW_CARD.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #drawCard(ws, payload) {
        const session = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.DRAW_CARD, 400, 100
        );

        const room = session.room;
        const drawn = await room.drawCards(session.playerName, payload.sortKey);
        const count = drawn.length;

        this.#sendDrawNotification(ws, count, room.status === Constants.STATUS.PLAYING && count > 1);
        await this.#continueAutomatedTurn(session.roomKey);
    }

    /**
     * Handles DISCARD_CARD.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #discardCard(ws, payload) {
        const session = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.DISCARD_CARD, 250, 100
        );
        const card = Card.from(payload.card);

        const drawn = await session.room.discardCard(session.playerName, card.value, card.suit, payload.sortKey);

        this.#sendDrawNotification(ws, drawn.length, true);
        await this.#continueAutomatedTurn(session.roomKey);
    }

    /**
     * Handles PASS_PLAYER.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #passTurn(ws, payload) {
        const session = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.PASS_PLAYER, 250, 100
        );

        const drawn = await session.room.passTurn(session.playerName, payload.sortKey);

        this.#sendDrawNotification(ws, drawn.length, true);
        await this.#continueAutomatedTurn(session.roomKey);
    }

    /**
     * Handles SUIT_CHANGE.
     *
     * @param {WebSocket} ws - Client WebSocket.
     * @param {Object} payload - Payload.
     * @returns {Promise<void>}
     */
    async #suitChange(ws, payload) {
        const session = this.#requireThrottledPlayerSession(
            ws, payload, Constants.ACTIONS.SUIT_CHANGE, 250, 100
        );
        const suit = this.#requireSuit(payload.suit);

        await session.room.declareSuit(suit);
        await this.#continueAutomatedTurn(session.roomKey);
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
     * @param {string} roomKey - Room key.
     * @returns {Promise<void>}
     */
    async #runAutomatedTurn(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            if (room.status === Constants.STATUS.PENDING) {
                const turnOwner = room.circle.getTurnOwner();

                if (turnOwner instanceof AIPlayer) {
                    await turnOwner.chooseSuit(room);
                    await this.#runAutomatedTurn(roomKey);
                }
            } else if (room.status === Constants.STATUS.PLAYING) {
                const turnOwner = room.circle.getTurnOwner();

                if (turnOwner instanceof AIPlayer) {
                    await turnOwner.takeTurn(room);
                    await this.#runAutomatedTurn(roomKey);
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

        for (const timeoutId of this.#roomClosureTimersByRoomKey.values()) {
            globalThis.clearTimeout(timeoutId);
        }

        this.#roomClosureTimersByRoomKey.clear();

        for (const room of this.#roomsByKey.values()) {
            this.#clearRoomCallbacks(room);
        }

        this.#roomsByKey.clear();
        this.#roomTabIdsByRoomKey.clear();
        this.#roomSessionsByTabId.clear();
        this.#lobbyConnections.clear();
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
