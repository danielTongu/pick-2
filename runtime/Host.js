"use strict";

/** Transport-neutral room orchestrator shared by Browser and Network. */

import { UserNotification } from "../core/UserNotification.js";

import { Card } from "../core/Card.js";
import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";
import { BotPlayer, Player } from "../core/Player.js";
import { Room } from "../core/Room.js";
import { StateMapper } from "../core/StateMapper.js";
import { RateLimit } from "./RateLimit.js";

/** Explicit runtime configuration for one Host. */
export class HostConfig {
    /**
     * @param {string} mode - Runtime mode (`local` or `network`).
     * @param {string} customBots - Custom-room bot policy.
     * @param {boolean} trackIdle - Whether to monitor idle players.
     * @param {boolean} resetFinished - Whether finished rooms reset after publication.
     * @param {boolean} closeOwnedRoom - Whether an owned custom room closes when its owner leaves.
     * @param {Object} store - Room-definition storage adapter.
     */
    constructor(mode, customBots, trackIdle, resetFinished, closeOwnedRoom, store) {
        this.mode = mode;
        this.customBots = customBots;
        this.trackIdle = trackIdle;
        this.resetFinished = resetFinished;
        this.closeOwnedRoom = closeOwnedRoom;
        this.store = store;
        Object.freeze(this);
    }
}

/** Explicit publication boundary supplied by Browser or Network. */
export class HostChannel {
    /**
     * @param {Function} publish - Publishes a response to the endpoint.
     * @param {Function} terminate - Closes the endpoint connection.
     */
    constructor(publish, terminate) {
        if (typeof publish !== "function" || typeof terminate !== "function") {
            throw new Error("HostChannel requires publish and terminate functions.");
        }

        this.publish = publish;
        this.terminate = terminate;
        Object.freeze(this);
    }
}

/** Concrete peer handle returned by Host.open(). */
class HostConnection {
    #request;
    #close;

    /** @param {Function} request - Request dispatcher. @param {Function} close - Close callback. */
    constructor(request, close) {
        this.#request = request;
        this.#close = close;
        Object.freeze(this);
    }

    /** @param {Object} message - Canonical action request. */
    request(message) {
        return this.#request(message);
    }

    /** Closes this peer connection. */
    close() {
        return this.#close();
    }
}

/** No-op storage implementation for runtimes without persistent custom rooms. */
export class EmptyRoomStore {
    /** @returns {Promise<Object[]>} No stored room definitions. */
    async load() {
        return [];
    }

    /** @param {Object} _definition - Ignored room definition. */
    async save(_definition) {}

    /** @param {string} _roomKey - Ignored room key. */
    async remove(_roomKey) {}
}

/**
 * Transport-neutral host for Pick 2 rooms.
 *
 * Host owns room registration, peers, viewers, notifications, and lifecycle
 * orchestration; each Room owns players and round rules.
 */
export class Host {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** @type {Map<string, Room>} */
    #roomsByKey = new Map();

    /** @type {Map<string, Set<string>>} */
    #roomTabIdsByRoomKey = new Map();

    /** @type {Map<string, *>} */
    #roomClosureTimersByRoomKey = new Map();

    /** @type {Map<string, {tabId:string, peer:Object, roomKey:string, playerName:string|null}>} */
    #clientsByTabId = new Map();

    /** @type {Set<Object>} */
    #homePeers = new Set();

    /** @type {RateLimit} */
    #rateLimit = new RateLimit();

    /** @type {Map<string,string>} */
    #ownerTabIdsByRoomKey = new Map();

    /** @type {Set<string>} */
    #customRoomKeys = new Set();

    /** @type {Object} */
    #profile;

    /** @type {Object} */
    #store;

    /** @type {Promise<void>} */
    #ready;

    /** @type {number} */
    #peerSequence = 0;

    /**
     * Creates a room Host.
     *
     * @param {HostConfig} config - Explicit Host configuration.
     */
    constructor(config) {
        if (!(config instanceof HostConfig)) {
            throw new Error("Host requires a HostConfig instance.");
        }

        this.#profile = Host.#normalizeProfile(config);
        this.#store = Host.#normalizeStore(config.store);
        this.#ready = this.#initializeRooms();
    }

    /**
     * Opens one transport-neutral peer connection.
     *
     * @param {{publish:Function,terminate?:Function}} channel - Environment channel.
     * @returns {{request:Function,close:Function}} Connected peer API.
     */
    open(channel) {
        if (!(channel instanceof HostChannel)) {
            throw new Error("Host.open requires a HostChannel instance.");
        }

        const publish = channel.publish;

        if (typeof publish !== "function") {
            throw new Error("Channel.publish must be a function.");
        }

        const peer = {
            id: `peer-${++this.#peerSequence}`,
            isOpen: true,
            publish,
            terminate: channel.terminate
        };

        this.#registerHomePeer(peer);
        void this.#ready.then(this.#publishCurrentHomeState.bind(this, peer));

        return new HostConnection(
            this.#receive.bind(this, peer),
            this.#disconnect.bind(this, peer)
        );
    }

    /**
     * Stops the Host and releases all resources.
     *
     * @returns {Promise<void>} Resolves when shutdown completes.
     */
    async shutdown() {
        await this.#shutdown();
    }

    /** Removes expired rate-limit entries. */
    maintain() {
        this.#rateLimit.prune(5 * 60 * 1000);
    }

    // -------------------------------------------------------------------------
    // Room registry and state publication
    // -------------------------------------------------------------------------

    /** @returns {Object} Normalized Host profile. */
    static #normalizeProfile(config) {
        const mode = config.mode === "local" ? "local" : "network";

        return Object.freeze({
            mode,
            capabilities: Object.freeze({
                create: true,
                join: true,
                view: true,
                invite: mode === "network",
                botFill: mode === "local",
                restart: mode === "local",
            }),
            customBots: config.customBots === "fill" ? "fill" : 0,
            trackIdle: config.trackIdle === true,
            resetFinished: config.resetFinished === true,
            closeOwnedRoom: config.closeOwnedRoom === true
        });
    }

    /** @returns {Object} Normalized serializable-definition store. */
    static #normalizeStore(store) {
        const source = store ?? new EmptyRoomStore();

        for (const method of ["load", "save", "remove"]) {
            if (typeof source[method] !== "function") {
                throw new Error(`Room store must implement ${method}().`);
            }
        }

        return source;
    }

    /** Creates configured Rooms and their initial bot players. */
    async #initializeRooms() {
        for (const roomConfig of Constants.DEFAULT_ROOMS) {
            const roomKey = this.#normalizeRoomKey(roomConfig.roomName);
            const room = this.#registerRoom(roomConfig.roomName, roomConfig.playerLimit, roomKey);

            await this.#addBotPlayers(room, roomConfig.botCount, null);
        }

        const definitions = await this.#store.load();

        for (const definition of Array.isArray(definitions) ? definitions : []) {
            if (typeof definition?.roomName === "string") {
                const roomKey = this.#normalizeRoomKey(definition.roomName);

                if (!this.#roomsByKey.has(roomKey)) {
                    const playerLimit = this.#normalizePlayerLimit(definition.playerLimit);
                    const room = this.#registerRoom(definition.roomName, playerLimit, roomKey);
                    this.#customRoomKeys.add(roomKey);
                    const botCount = Math.min(
                        ValidationUtils.nonNegativeInteger(definition.botCount ?? 0, "Bot count"),
                        playerLimit
                    );

                    await this.#addBotPlayers(room, botCount, null);
                }
            }
        }
    }

    /** Adds a fixed number of bot players through the shared Room admission API. */
    async #addBotPlayers(room, count, humanName) {
        let index = 0;

        while (index < count && !room.isFull()) {
            const baseName = Constants.LOCAL_OPPONENT_NAMES[index] ?? `Bot ${index + 1}`;
            const botName = humanName !== null &&
                Player.normalizeKey(baseName) === Player.normalizeKey(humanName)
                ? `${baseName} Bot`
                : baseName;

            if (!room.isPlayerPresent(botName)) {
                await room.join(botName, true);
            }

            index += 1;
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
     * @param {number} playerLimit - Maximum number of players.
     * @param {string} roomKey - Room key.
     * @returns {Room} Registered room.
     */
    #registerRoom(roomName, playerLimit, roomKey) {
        const room = new Room(roomName, playerLimit);

        room.onAnyChange = this.#handleRoomChange.bind(this, roomKey, room);

        room.onPlayerIdle = this.#profile.trackIdle
            ? this.#handlePlayerIdle.bind(this, roomKey)
            : null;

        this.#roomsByKey.set(roomKey, room);
        this.#roomTabIdsByRoomKey.set(roomKey, new Set());

        return room;
    }

    #handleRoomChange(roomKey, room) {
        this.#broadcastRoomState(roomKey);

        if (!this.#profile.trackIdle) {
            Host.#stopIdleMonitoring(room);
        }
    }

    #handlePlayerIdle(roomKey, _room, playerName) {
        void this.#moveIdlePlayerToView(roomKey, playerName);
    }

    /** Stops idle monitoring when the active profile does not use it. */
    static #stopIdleMonitoring(room) {
        for (const player of room.circle.players.values()) {
            player.stopIdleMonitoring();
        }
    }

    /**
     * Removes server callbacks from a room.
     *
     * @param {Room} room - Room instance.
     */
    #clearRoomCallbacks(room) {
        room.onAnyChange = null;
        room.onPlayerIdle = null;
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
     * Broadcasts current Room state to every connected client.
     *
     * @param {string} roomKey - Room key.
     */
    #broadcastRoomState(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            const roomTabIds = this.#roomTabIdsByRoomKey.get(roomKey);

            if (roomTabIds !== undefined) {
                for (const tabId of roomTabIds) {
                    const client = this.#clientsByTabId.get(tabId);

                    if (client !== undefined && client.peer.isOpen) {
                        this.#publishRoomState(
                            client.peer,
                            room,
                            this.#resolveClientPlayerName(room, client)
                        );
                    }
                }
            }

            if (this.#profile.resetFinished && room.status === Constants.STATUS.FINISHED) {
                room.status = Constants.STATUS.WAITING;
            }
        }
    }

    /**
     * Resolves a client's player name against current room membership.
     *
     * @param {Room} room - Room instance.
     * @param {{playerName:string|null}} client - Room client.
     * @returns {string|null} Valid player name or null.
     */
    #resolveClientPlayerName(room, client) {
        let playerName = null;

        if (client.playerName !== null && room.isPlayerPresent(client.playerName)) {
            playerName = client.playerName;
        }

        return playerName;
    }

    /**
     * Sends active Room state to one client.
     *
     * @param {Object} peer - Client peer.
     * @param {Room} room - Room instance.
     * @param {string|null} playerName - Room player name.
     */
    #publishRoomState(peer, room, playerName) {
        this.#publishViewState(peer, Constants.VIEWS.ROOM, Object.freeze({
            ...StateMapper.toRoomData(room, playerName),
            ...this.#getModeData(),
            isBusy: false
        }));
    }

    /**
     * Registers a peer as currently viewing Home.
     *
     * @param {Object} peer - Client peer.
     */
    #registerHomePeer(peer) {
        if (peer.isOpen) {
            this.#homePeers.add(peer);
        }
    }

    /**
     * Removes a peer from Home tracking.
     *
     * @param {Object} peer - Client peer.
     */
    #unregisterHomePeer(peer) {
        this.#homePeers.delete(peer);
    }

    /**
     * Broadcasts the current Home data.
     *
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #broadcastHomeState(homeState) {
        for (const peer of Array.from(this.#homePeers)) {
            if (peer.isOpen) {
                this.#publishViewState(peer, Constants.VIEWS.HOME, homeState);
            } else {
                this.#homePeers.delete(peer);
            }
        }
    }

    /**
     * Creates the Home data.
     *
     * @returns {{rooms:Object[]}} Home data.
     */
    #createHomeState() {
        return Object.freeze({
            ...StateMapper.toHomeData(this.#roomsByKey.values()),
            ...this.#getModeData()
        });
    }

    /** @returns {Object} Shared mode metadata. */
    #getModeData() {
        return Object.freeze({
            mode: this.#profile.mode,
            capabilities: this.#profile.capabilities
        });
    }

    /**
     * Sends a normal transition to Home.
     *
     * @param {Object} peer - Client peer.
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #publishHomeState(peer, homeState) {
        this.#registerHomePeer(peer);
        this.#publishViewState(peer, Constants.VIEWS.HOME, homeState);
    }

    #publishCurrentHomeState(peer) {
        this.#publishHomeState(peer, this.#createHomeState());
    }

    /**
     * Sends a forced room-exit notification and Home state.
     *
     * @param {Object} peer - Client peer.
     * @param {string} title - Warning title.
     * @param {string} message - Warning message.
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #publishInvoluntaryHomeState(peer, title, message, homeState) {
        this.#registerHomePeer(peer);
        this.#publish(peer, StateMapper.toResponse(
            Constants.VIEWS.HOME,
            StateMapper.toMessage(Constants.STATUS.WARNING, title, message),
            homeState
        ));
    }

    // -------------------------------------------------------------------------
    // Client rooms and membership transitions
    // -------------------------------------------------------------------------

    /**
     * Registers a client with a room.
     *
     * @param {string} tabId - Tab ID.
     * @param {Object} peer - Client peer.
     * @param {string} roomKey - Room key.
     * @param {string|null} playerName - Player name.
     * @returns {{tabId:string, peer:Object, roomKey:string, playerName:string|null}} Registered client.
     */
    #registerClient(tabId, peer, roomKey, playerName) {
        const existingClient = this.#clientsByTabId.get(tabId);

        if (existingClient !== undefined && existingClient.peer !== peer) {
            existingClient.peer.terminate(1008, "Room replaced");
            void this.#disconnect(existingClient.peer);
        }

        this.#unregisterHomePeer(peer);

        const client = { tabId, peer, roomKey, playerName };

        this.#clientsByTabId.set(tabId, client);
        peer.tabId = tabId;

        let roomTabIds = this.#roomTabIdsByRoomKey.get(roomKey);

        if (roomTabIds === undefined) {
            roomTabIds = new Set();
            this.#roomTabIdsByRoomKey.set(roomKey, roomTabIds);
        }

        roomTabIds.add(tabId);

        return client;
    }

    /**
     * Unregisters a client from a room.
     *
     * This does not mutate Room membership or move the socket to the room.
     *
     * @param {string} tabId - Tab ID.
     * @param {Object} peer - Client peer.
     */
    #unregisterClient(tabId, peer) {
        const client = this.#clientsByTabId.get(tabId);

        if (client !== undefined && client.peer === peer) {
            const roomTabIds = this.#roomTabIdsByRoomKey.get(client.roomKey);

            if (roomTabIds !== undefined) {
                roomTabIds.delete(tabId);

                if (roomTabIds.size === 0) {
                    this.#roomTabIdsByRoomKey.delete(client.roomKey);
                }
            }

            this.#clientsByTabId.delete(tabId);
        }

        this.#rateLimit.reset(`player:${tabId}`);
        this.#rateLimit.reset(`connection:${tabId}`);

        if (peer.tabId === tabId) {
            delete peer.tabId;
        }
    }

    /**
     * Finds a room client by player name.
     *
     * @param {string} roomKey - Room key.
     * @param {string} playerName - Player name.
     * @returns {{tabId:string, peer:Object, roomKey:string, playerName:string|null}|null} Matching client.
     */
    #findClientByPlayer(roomKey, playerName) {
        let matchingClient = null;

        for (const client of this.#clientsByTabId.values()) {
            if (matchingClient === null && client.roomKey === roomKey && client.playerName === playerName) {
                matchingClient = client;
            }
        }

        return matchingClient;
    }

    /**
     * Finds a room client by peer.
     *
     * @param {Object} peer - Client peer.
     * @returns {{tabId:string, peer:Object, roomKey:string, playerName:string|null}|null} Matching client.
     */
    #findClientByPeer(peer) {
        let matchingClient = null;

        for (const client of this.#clientsByTabId.values()) {
            if (matchingClient === null && client.peer === peer) {
                matchingClient = client;
            }
        }

        return matchingClient;
    }

    /**
     * Checks whether a captured room client is still current.
     *
     * @param {{tabId:string, peer:Object, roomKey:string, playerName:string|null}} client - Captured client.
     * @returns {boolean} True when still current.
     */
    #isCurrentClient(client) {
        return this.#clientsByTabId.get(client.tabId) === client;
    }

    /**
     * Moves an idle player back to viewing state.
     *
     * @param {string} roomKey - Room key.
     * @param {string} playerName - Idle player name.
     * @returns {Promise<void>}
     */
    async #moveIdlePlayerToView(roomKey, playerName) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        const client = this.#findClientByPlayer(roomKey, playerName);

        if (room !== null && client !== null) {
            const removedPlayer = await room.movePlayerToView(playerName, client.tabId);

            if (removedPlayer !== null) {
                if (this.#isCurrentClient(client)) {
                    client.playerName = null;

                    this.#publish(client.peer, StateMapper.toResponse(
                        Constants.VIEWS.ROOM, StateMapper.toMessage(
                            Constants.STATUS.WARNING,
                            "Moved to viewers",
                            "You were idle."
                        ),
                        StateMapper.toRoomData(room, null)
                    ));

                    this.#scheduleRoomClosureIfEmpty(roomKey);
                    await this.#continueAutomatedTurn(roomKey);
                } else {
                    room.leaveViewer(client.tabId);
                    await this.#continueOrCloseRoom(roomKey);
                }
            }
        }
    }

    /**
     * Removes one room client.
     *
     * @param {{tabId:string, peer:Object, roomKey:string, playerName:string|null}} client - Room client.
     * @param {Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async #leaveClient(client, room) {
        const roomKey = await this.#removeClient(client, room);

        await this.#continueOrCloseRoom(roomKey);
    }

    /**
     * Removes one occupant without waiting for subsequent automated turns.
     *
     * @param {{tabId:string, peer:Object, roomKey:string, playerName:string|null}} client - Room client.
     * @param {Room} room - Room instance.
     * @returns {Promise<string>} Removed occupant's room key.
     */
    async #removeClient(client, room) {
        const roomKey = client.roomKey;
        const playerName = client.playerName;

        this.#unregisterClient(client.tabId, client.peer);

        if (playerName !== null) {
            await room.leavePlayer(playerName);
        } else {
            room.leaveViewer(client.tabId);
        }

        return roomKey;
    }

    // -------------------------------------------------------------------------
    // Room closure and round continuation
    // -------------------------------------------------------------------------

    /**
     * Continues the room or closes the room if no players remain.
     *
     * @param {string} roomKey - Room key.
     * @returns {Promise<boolean>} True when the room closed.
     */
    async #continueOrCloseRoom(roomKey) {
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
            this.#closeRoom(roomKey);
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

            const timeoutId = globalThis.setTimeout(
                this.#closeRoomAfterIdle.bind(this, roomKey),
                Constants.MAX_IDLE_MS
            );

            timeoutId.unref?.();
            this.#roomClosureTimersByRoomKey.set(roomKey, timeoutId);
        }
    }

    #closeRoomAfterIdle(roomKey) {
        this.#roomClosureTimersByRoomKey.delete(roomKey);
        this.#closeRoomIfNoPlayersRemain(roomKey);
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
     * Closes a room and returns every viewer to the Room.
     *
     * @param {string} roomKey - Room key.
     */
    #closeRoom(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            this.#cancelScheduledRoomClosure(roomKey);

            const roomTabIds = Array.from(this.#roomTabIdsByRoomKey.get(roomKey) ?? []);
            const viewingClients = [];

            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            this.#roomTabIdsByRoomKey.delete(roomKey);
            this.#rateLimit.reset(`room:${roomKey}`);
            this.#ownerTabIdsByRoomKey.delete(roomKey);

            if (this.#customRoomKeys.delete(roomKey)) {
                void this.#store.remove(roomKey);
            }

            for (const tabId of roomTabIds) {
                const client = this.#clientsByTabId.get(tabId);

                if (client !== undefined) {
                    viewingClients.push(client);
                    this.#unregisterClient(client.tabId, client.peer);
                }
            }

            const homeState = this.#createHomeState();

            this.#broadcastHomeState(homeState);

            for (const client of viewingClients) {
                this.#publishInvoluntaryHomeState(
                    client.peer,
                    "Room closed",
                    "No players remain.",
                    homeState
                );
            }
        }
    }

    /**
     * Continues bot turn processing while the room remains active.
     *
     * @param {string} roomKey - Room key.
     * @returns {Promise<void>}
     */
    async #continueAutomatedTurn(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null && room.isActive()) {
            await this.#runAutomatedTurn(roomKey);
        }
    }

    // -------------------------------------------------------------------------
    // Request routing
    // -------------------------------------------------------------------------

    /** Processes one request from a connected peer. */
    async #receive(peer, request) {
        await this.#ready;

        if (!peer.isOpen) {
            return;
        }

        try {
            const parsed = ValidationUtils.object(request, "Request");
            const action = ValidationUtils.requiredString(parsed.action, "Action");
            const data = parsed.data === undefined
                ? {}
                : ValidationUtils.object(parsed.data, "Action data");

            this.#rateLimit.enforceConnection(peer, action, 75);
            await this.#routeAction(peer, action, data);
        } catch (error) {
            if (error instanceof UserNotification) {
                this.#publishError(peer, error.message);
            } else {
                this.#publishError(peer, "Host error occurred.");
                console.error("Host request failed:", error);
            }
        }
    }

    /**
     * Routes an action to its handler.
     *
     * @param {Object} peer - Client peer.
     * @param {string} type - Action type.
     * @param {Object} data - Action data.
     * @returns {Promise<void>}
     */
    async #routeAction(peer, action, data) {
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

        const handler = handlers[action];

        if (typeof handler !== "function") {
            throw new Error(`Unknown action: ${action}`);
        }

        await handler.call(this, peer, data);
    }

    /**
     * Handles a disconnected peer.
     *
     * Room clients are silently removed.
     *
     * @param {Object} peer - Client peer.
     * @returns {Promise<void>}
     */
    async #disconnect(peer) {
        if (!peer.isOpen) {
            return;
        }

        peer.isOpen = false;
        this.#unregisterHomePeer(peer);

        const client = this.#findClientByPeer(peer);

        if (client !== null) {
            const room = this.#roomsByKey.get(client.roomKey) ?? null;
            const ownsRoom = this.#profile.closeOwnedRoom &&
                this.#ownerTabIdsByRoomKey.get(client.roomKey) === client.tabId;

            if (room !== null) {
                await this.#removeClient(client, room);

                if (ownsRoom) {
                    this.#closeRoom(client.roomKey);
                } else {
                    await this.#continueOrCloseRoom(client.roomKey);
                }
            } else {
                this.#unregisterClient(client.tabId, peer);
            }
        }
    }

    /**
     * Publishes one structured response.
     *
     * @param {Object|null|undefined} peer - Client peer.
     * @param {Object} response - Response data.
     */
    #publish(peer, response) {
        if (peer?.isOpen) {
            peer.publish(response);
        }
    }

    /**
     * Publishes view data in a response.
     *
     * @param {Object|null|undefined} peer - Client peer.
     * @param {string|null} view - View name.
     * @param {Object|null} data - View data.
     */
    #publishViewState(peer, view, data) {
        this.#publish(peer, StateMapper.toResponse(view, null, data));
    }

    /**
     * Publishes an error response.
     *
     * @param {Object|null|undefined} peer - Client peer.
     * @param {string} message - Error message.
     */
    #publishError(peer, message) {
        this.#publishNotification(peer, Constants.STATUS.ERROR, "Error", message);
    }

    /**
     * Publishes a message response.
     *
     * @param {Object|null|undefined} peer - Client peer.
     * @param {string} status - Message status.
     * @param {string} title - Message title.
     * @param {string} message - Message text.
     */
    #publishNotification(peer, status, title, message) {
        this.#publish(peer, StateMapper.toResponse(null, StateMapper.toMessage(status, title, message), null));
    }

    /**
     * Welcomes a new viewer.
     *
     * @param {Object} peer - Viewer peer.
     */
    #publishViewerWelcome(peer) {
        this.#publishNotification(
            peer,
            Constants.STATUS.INFO,
            "Welcome",
            "Enjoy the show or join in."
        );
    }

    /**
     * Welcomes a newly joined player and identifies their play area.
     *
     * @param {Object} peer - Player peer.
     * @param {string} playerName - Joined player name.
     */
    #publishPlayerWelcome(peer, playerName) {
        this.#publishNotification(
            peer,
            Constants.STATUS.INFO,
            `Welcome, ${playerName}!`,
            "Your hand is below the discard pile.\nGood luck!"
        );
    }

    /**
     * Sends a card-draw notification.
     *
     * @param {Object} peer - Client peer.
     * @param {number} count - Number of cards drawn.
     * @param {boolean} [isMocked=false] - True to add mock emoji to mock the move.
     */
    #publishDrawNotification(peer, count, isMocked) {
        if (count > 0) {
            const emoji = isMocked ? `\n\n${Constants.EMOJIS.silly.random}` : "";
            this.#publishNotification(peer, Constants.STATUS.INFO, "Cards Drawn", `+${count} ${emoji}`);
        }
    }

    // -------------------------------------------------------------------------
    // Client action handlers and their shared requirements
    // -------------------------------------------------------------------------

    /**
     * Handles LIST.
     *
     * @param {Object} peer - Client peer.
     * @returns {Promise<void>}
     */
    async #list(peer) {
        if (this.#findClientByPeer(peer) !== null) {
            throw new UserNotification("Leave the current room before returning Home.");
        }

        this.#registerHomePeer(peer);
        this.#publishViewState(peer, Constants.VIEWS.HOME, this.#createHomeState());
    }

    /**
     * Handles CREATE.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #create(peer, data) {
        const tabId = ValidationUtils.requiredString(data.tabId, "tabId");
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");
        const roomKey = this.#normalizeRoomKey(roomName);
        const playerLimit = this.#normalizePlayerLimit(data.playerLimit);

        this.#rateLimit.enforcePlayerThrottle(tabId, Constants.ACTIONS.CREATE, 500);

        if (this.#clientsByTabId.has(tabId)) {
            throw new UserNotification("Leave the current room before creating another room.");
        }

        if (this.#roomsByKey.has(roomKey)) {
            throw new UserNotification(`Room already exists: ${roomName}`);
        }

        const room = this.#registerRoom(roomName, playerLimit, roomKey);
        this.#customRoomKeys.add(roomKey);

        try {
            const player = await room.join(playerName, false);
            const botCount = this.#profile.customBots === "fill" ? playerLimit - 1 : 0;

            await this.#addBotPlayers(room, botCount, player.name);
            await this.#store.save(Object.freeze({roomName: room.name, playerLimit, botCount}));

            if (this.#profile.closeOwnedRoom) {
                this.#ownerTabIdsByRoomKey.set(roomKey, tabId);
            }

            this.#registerClient(tabId, peer, roomKey, player.name);
            this.#publishRoomState(peer, room, player.name);
            this.#publishPlayerWelcome(peer, player.name);
            this.#broadcastHomeState(this.#createHomeState());
        } catch (error) {
            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            this.#roomTabIdsByRoomKey.delete(roomKey);
            this.#customRoomKeys.delete(roomKey);
            this.#ownerTabIdsByRoomKey.delete(roomKey);
            await this.#store.remove(roomKey);

            throw error;
        }
    }

    /**
     * Resolves the room player limit.
     *
     * @param {*} value - Raw player limit.
     * @returns {number} Player limit.
     */
    #normalizePlayerLimit(value) {
        const parsedPlayerLimit = Number(value || Constants.ROOM_PLAYER_LIMIT);

        return Number.isInteger(parsedPlayerLimit) ? parsedPlayerLimit : Constants.ROOM_PLAYER_LIMIT;
    }

    /**
     * Handles VIEW.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #view(peer, data) {
        const {tabId, roomKey, room, existingClient} = this.#requireRoomContext(
            peer, data, Constants.ACTIONS.VIEW, 300
        );

        if (existingClient !== null && existingClient.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before viewing another room.");
        }

        if (existingClient === null) {
            room.view(tabId);
            this.#registerClient(tabId, peer, roomKey, null);
            this.#publishRoomState(peer, room, null);
            this.#publishViewerWelcome(peer);
        } else {
            this.#publishRoomState(peer, room, this.#resolveClientPlayerName(room, existingClient));
        }
    }

    /** Joins a room as a player, whether it is already being viewed or not. */
    async #join(peer, data) {
        const {tabId, roomKey, room, existingClient} = this.#requireRoomContext(
            peer, data, Constants.ACTIONS.JOIN, 500
        );
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");

        this.#assertPlayerNameAvailable(room, playerName);

        if (existingClient !== null && existingClient.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before joining another room.");
        }

        if (existingClient !== null && existingClient.playerName !== null) {
            throw new UserNotification("You already joined this room.");
        }

        const player = await room.join(playerName, false, existingClient === null ? null : tabId);

        if (existingClient === null) {
            this.#registerClient(tabId, peer, roomKey, player.name);
        } else {
            existingClient.playerName = player.name;
        }

        if (this.#profile.closeOwnedRoom &&
            this.#customRoomKeys.has(roomKey) &&
            !this.#ownerTabIdsByRoomKey.has(roomKey)) {
            this.#ownerTabIdsByRoomKey.set(roomKey, tabId);
        }

        const currentClient = this.#clientsByTabId.get(tabId);

        if (currentClient !== undefined && currentClient.peer === peer && currentClient.roomKey === roomKey) {
            currentClient.playerName = player.name;
            this.#publishRoomState(peer, room, player.name);
            this.#publishPlayerWelcome(peer, player.name);
        }
    }

    /**
     * Resolves the shared context for viewing or joining a room.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Room data.
     * @param {string} action - Room action.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,roomKey:string,room:Room,existingClient:Object|null}} Room context.
     */
    #requireRoomContext(peer, data, action, throttleMs) {
        const tabId = ValidationUtils.requiredString(data.tabId, "tabId");
        const {roomKey, room} = this.#requireDataRoom(data);
        const existingClient = this.#clientsByTabId.get(tabId) ?? null;

        this.#rateLimit.enforcePlayerThrottle(tabId, action, throttleMs);

        if (existingClient !== null && existingClient.peer !== peer) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }

        return {tabId, roomKey, room, existingClient};
    }

    /**
     * Resolves a required room from an action data.
     *
     * @param {Object} data - Action data.
     * @returns {{roomKey:string,room:Room}} Room context.
     */
    #requireDataRoom(data) {
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
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

    /** Leaves the viewed or joined room. */
    async #leave(peer, data) {
        const context = this.#requireThrottledClient(
            peer, data, Constants.ACTIONS.LEAVE, 300
        );
        const room = this.#roomsByKey.get(context.client.roomKey) ?? null;

        if (room !== null) {
            const ownsRoom = this.#profile.closeOwnedRoom &&
                this.#ownerTabIdsByRoomKey.get(context.client.roomKey) === context.tabId;
            const roomKey = await this.#removeClient(context.client, room);

            if (ownsRoom) {
                this.#closeRoom(roomKey);
            } else {
                await this.#continueOrCloseRoom(roomKey);
            }

            this.#publishCurrentHomeState(peer);
        } else {
            this.#unregisterClient(context.tabId, peer);
            this.#publishCurrentHomeState(peer);
        }
    }

    /**
     * Requires a client currently viewing or playing in a room.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {{tabId:string, client:Object}} Client context.
     * @throws {Error}
     */
    #requireClient(peer, data) {
        const tabId = ValidationUtils.requiredString(data.tabId, "tabId");
        const client = this.#clientsByTabId.get(tabId) ?? null;

        if (client === null || client.peer !== peer) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }

        return { tabId, client };
    }

    /**
     * Requires a room client and applies its action throttle.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Action data.
     * @param {string} action - Client action.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,client:Object}} Throttled client context.
     */
    #requireThrottledClient(peer, data, action, throttleMs) {
        const context = this.#requireClient(peer, data);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, action, throttleMs);

        return context;
    }

    /**
     * Requires a valid player room.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {{tabId:string, client:Object, roomKey:string, room:Room, playerName:string}} Player room.
     * @throws {Error}
     */
    #requirePlayerRoom(peer, data) {
        const context = this.#requireClient(peer, data);
        const client = context.client;

        if (client.playerName === null) {
            throw new UserNotification("Join the room before making a move.");
        }

        const room = this.#requireRoomByKey(client.roomKey);

        if (!room.isPlayerPresent(client.playerName)) {
            throw new UserNotification("Your player connection expired. Rejoin the room.");
        }

        return {
            tabId: context.tabId,
            client,
            roomKey: client.roomKey,
            room,
            playerName: client.playerName
        };
    }

    /**
     * Requires a player room and applies player and optional room throttles.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Action data.
     * @param {string} action - Player action.
     * @param {number} playerThrottleMs - Player throttle window.
     * @param {number|null} [roomThrottleMs=null] - Optional room throttle window.
     * @returns {{tabId:string,client:Object,roomKey:string,room:Room,playerName:string}} Player room.
     */
    #requireThrottledPlayerRoom(peer, data, action, playerThrottleMs, roomThrottleMs) {
        const context = this.#requirePlayerRoom(peer, data);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, action, playerThrottleMs);

        if (roomThrottleMs !== null) {
            this.#rateLimit.enforceRoomThrottle(context.roomKey, action, roomThrottleMs);
        }

        return context;
    }

    /**
     * Handles START.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #start(peer, data) {
        const context = this.#requireThrottledPlayerRoom(
            peer, data, Constants.ACTIONS.START, 1000, 500
        );

        await context.room.start();
        await this.#runAutomatedTurn(context.roomKey);
    }

    /**
     * Handles DRAW.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #draw(peer, data) {
        const context = this.#requireThrottledPlayerRoom(
            peer, data, Constants.ACTIONS.DRAW, 400, 100
        );

        const drawn = await context.room.drawCards(context.playerName, data.sortKey);
        const count = drawn.length;

        this.#publishDrawNotification(peer, count, context.room.status === Constants.STATUS.PLAYING && count > 1);
        await this.#continueAutomatedTurn(context.roomKey);
    }

    /**
     * Handles DISCARD.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #discard(peer, data) {
        const context = this.#requireThrottledPlayerRoom(
            peer, data, Constants.ACTIONS.DISCARD, 250, 100
        );
        const card = Card.from(data.card);

        const drawn = await context.room.discardCard(context.playerName, card.value, card.suit, data.sortKey);

        this.#publishDrawNotification(peer, drawn.length, true);
        await this.#continueAutomatedTurn(context.roomKey);
    }

    /**
     * Handles PASS.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #pass(peer, data) {
        const context = this.#requireThrottledPlayerRoom(
            peer, data, Constants.ACTIONS.PASS, 250, 100
        );

        const drawn = await context.room.passTurn(context.playerName, data.sortKey);

        this.#publishDrawNotification(peer, drawn.length, true);
        await this.#continueAutomatedTurn(context.roomKey);
    }

    /**
     * Handles DECLARE.
     *
     * @param {Object} peer - Client peer.
     * @param {Object} data - Data.
     * @returns {Promise<void>}
     */
    async #declare(peer, data) {
        const context = this.#requireThrottledPlayerRoom(
            peer, data, Constants.ACTIONS.DECLARE, 250, 100
        );
        const suit = this.#requireSuit(data.suit);

        await context.room.declareSuit(suit);
        await this.#continueAutomatedTurn(context.roomKey);
    }

    /**
     * Requires a standard card suit.
     *
     * @param {*} value - Suit value.
     * @returns {string} Normalized suit.
     * @throws {Error}
     */
    #requireSuit(value) {
        return Constants.normalizeStandardSuit(ValidationUtils.requiredString(value, "Suit"));
    }

    /**
     * Handles bot turns and suit declarations.
     *
     * @param {string} roomKey - Room key.
     * @returns {Promise<void>}
     */
    async #runAutomatedTurn(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            if (room.status === Constants.STATUS.PENDING) {
                const turnOwner = room.circle.getTurnOwner();

                if (turnOwner instanceof BotPlayer) {
                    await turnOwner.chooseSuit(room);
                    await this.#runAutomatedTurn(roomKey);
                }
            } else if (room.status === Constants.STATUS.PLAYING) {
                const turnOwner = room.circle.getTurnOwner();

                if (turnOwner instanceof BotPlayer) {
                    await turnOwner.takeTurn(room);
                    await this.#runAutomatedTurn(roomKey);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Shutdown implementation
    // -------------------------------------------------------------------------

    /**
     * Stops the host and releases all resources.
     *
     * @returns {Promise<void>} Resolves when shutdown completes.
     */
    async #shutdown() {
        await this.#ready;

        for (const timeoutId of this.#roomClosureTimersByRoomKey.values()) {
            globalThis.clearTimeout(timeoutId);
        }

        this.#roomClosureTimersByRoomKey.clear();

        for (const room of this.#roomsByKey.values()) {
            this.#clearRoomCallbacks(room);
            Host.#stopIdleMonitoring(room);
        }

        for (const peer of this.#homePeers) {
            peer.isOpen = false;
            peer.terminate(1001, "Host stopped");
        }

        for (const client of this.#clientsByTabId.values()) {
            if (client.peer.isOpen) {
                client.peer.isOpen = false;
                client.peer.terminate(1001, "Host stopped");
            }
        }

        this.#roomsByKey.clear();
        this.#roomTabIdsByRoomKey.clear();
        this.#clientsByTabId.clear();
        this.#homePeers.clear();
        this.#ownerTabIdsByRoomKey.clear();
        this.#customRoomKeys.clear();
        this.#rateLimit.resetAll();
    }
}
