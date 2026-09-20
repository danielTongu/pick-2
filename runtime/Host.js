"use strict";

/** Transport-neutral room orchestrator shared by Browser and Network. */

import { UserNotification } from "../core/UserNotification.js";

import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";
import { Actor } from "../core/Actor.js";
import { RateLimit } from "./RateLimit.js";

/** Explicit runtime configuration for one Host. */
export class HostConfig {
    /**
     * @param {string} mode - Runtime mode (`direct` or `hosted`).
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
    /** @type {Function} Dispatches a canonical request to the owning Host. */
    #request;

    /** @type {Function} Disconnects this peer from the owning Host. */
    #close;

    /** @param {Function} request - Request dispatcher. @param {Function} close - Close callback.
     * @param {Function} close
     */
    constructor(request, close) {
        this.#request = request;
        this.#close = close;
        Object.freeze(this);
    }

    /** @param {Object} message - Canonical command request. */
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
    async save() {}

    /** @param {string} _roomKey - Ignored room key. */
    async remove() {}
}

/**
 * Transport-neutral host for the selected game.
 *
 * Host owns room registration, peers, viewers, notifications, and lifecycle
 * orchestration; each Room owns players and round rules.
 */
export class Host {
    /** @type {Object} Game contract supplying rooms, commands, mapping, and automation. */
    #game;
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** @type {Map<string, Room>} Registered rooms keyed by normalized room identity. */
    #roomsByKey = new Map();

    /** @type {Map<string, Set<string>>} Connected tab identifiers grouped by room key. */
    #roomTabIdsByRoomKey = new Map();

    /** @type {Map<string, *>} Pending empty-room closure timers keyed by room. */
    #roomClosureTimersByRoomKey = new Map();

    /** @type {Map<string, {tabId:string,peer:Object,roomKey:string,playerName:string|null}>} Authenticated room clients keyed by tab identifier. */
    #clientsByTabId = new Map();

    /** @type {Set<Object>} Connected peers currently subscribed to Home state. */
    #homePeers = new Set();

    /** @type {RateLimit} Shared command throttle across all connected peers and rooms. */
    #rateLimit = new RateLimit();

    /** @type {Map<string,string>} Direct-mode owner tab identifiers keyed by custom room. */
    #ownerTabIdsByRoomKey = new Map();

    /** @type {Set<string>} Normalized keys for user-created rooms eligible for persistence. */
    #customRoomKeys = new Set();

    /** @type {Object} Immutable runtime capability and lifecycle profile. */
    #profile;

    /** @type {Object} Validated room-definition persistence adapter. */
    #store;

    /** @type {Promise<void>} Initialization barrier for restored and default rooms. */
    #ready;

    /** @type {number} Monotonic sequence used to identify transport peers. */
    #peerSequence = 0;

    /**
     * Creates a room Host.
     *
     * @param {HostConfig} config - Explicit Host configuration.
     * @param {Object} game - Room factory, state mapper, commands, and automation.
     */
    constructor(config, game) {
        this.#game = game;
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

        return new HostConnection(this.#receive.bind(this, peer), this.#disconnect.bind(this, peer));
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
        const mode = config.mode === "direct" ? "direct" : "hosted";

        return Object.freeze({
            mode,
            capabilities: Object.freeze({
                create: true,
                join: true,
                view: true,
                invite: mode === "hosted",
                botFill: mode === "direct",
                restart: mode === "direct"
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
        for (const roomConfig of this.#game.constants.DEFAULT_ROOMS) {
            const roomKey = this.#normalizeRoomKey(roomConfig.roomName);
            const room = this.#registerRoom(roomConfig.roomName, roomConfig.playerLimit, roomKey);

            await this.#addBotActors(room, roomConfig.botCount, null);
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

                    await this.#addBotActors(room, botCount, null);
                }
            }
        }
    }

    /** Adds a fixed number of bot players through the shared Room admission API. */
    async #addBotActors(room, count, humanName) {
        let index = 0;

        while (index < count && !room.isFull()) {
            const baseName = this.#game.constants.DIRECT_OPPONENT_NAMES[index] ?? `Bot ${index + 1}`;
            const botName =
                humanName !== null && Actor.normalizeKey(baseName) === Actor.normalizeKey(humanName)
                    ? `${baseName} Bot`
                    : baseName;

            if (!room.hasActor(botName)) {
                await room.joinActor(botName, true);
            }

            index += 1;
        }
    }

    /**
     * Builds a normalized key from a name.
     *
     * @param {string} name - Display room name to normalize for lookup.
     * @returns {string} Normalized key.
     */
    #normalizeRoomKey(name) {
        return Actor.normalizeKey(name);
    }

    /**
     * Creates and registers a room.
     *
     * @param {string} roomName - Room name.
     * @param {number} playerLimit - Maximum seated actor count.
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {Room} Registered room.
     */
    #registerRoom(roomName, playerLimit, roomKey) {
        const room = this.#game.createRoom(roomName, playerLimit);

        room.onAnyChange = this.#handleRoomChange.bind(this, roomKey, room);

        room.onActorIdle = this.#profile.trackIdle ? this.#handlePlayerIdle.bind(this, roomKey) : null;

        this.#roomsByKey.set(roomKey, room);
        this.#roomTabIdsByRoomKey.set(roomKey, new Set());

        return room;
    }

    /** Broadcasts authoritative room state and enforces the active idle profile. */
    #handleRoomChange(roomKey, room) {
        this.#broadcastRoomState(roomKey);

        if (!this.#profile.trackIdle) {
            Host.#stopIdleMonitoring(room);
        }
    }

    /** Moves an idle actor to viewing state through the serialized Host lifecycle. */
    #handlePlayerIdle(roomKey, actorName) {
        void this.#moveIdlePlayerToView(roomKey, actorName);
    }

    /** Stops idle monitoring when the active profile does not use it. */
    static #stopIdleMonitoring(room) {
        for (const player of room.actors.values()) {
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
        room.onActorIdle = null;
    }

    /**
     * Returns a registered room or raises an actionable missing-room failure.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {Room} Room instance.
     * @throws {UserNotification} When the requested room or authenticated client context is unavailable.
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
     * @param {string} roomKey - Normalized room lookup key.
     */
    #broadcastRoomState(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            const roomTabIds = this.#roomTabIdsByRoomKey.get(roomKey);

            if (roomTabIds !== undefined) {
                for (const tabId of roomTabIds) {
                    const client = this.#clientsByTabId.get(tabId);

                    if (client !== undefined && client.peer.isOpen) {
                        this.#publishRoomState(client.peer, room, this.#resolveClientPlayerName(room, client));
                    }
                }
            }

            if (this.#profile.resetFinished && room.state === Constants.ROOM_STATE.FINISHED) {
                room.state = Constants.ROOM_STATE.WAITING;
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

        if (client.playerName !== null && room.hasActor(client.playerName)) {
            playerName = client.playerName;
        }

        return playerName;
    }

    /**
     * Sends active Room state to one client.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Room} room - Room instance.
     * @param {string|null} playerName - Room player name.
     * @param {Object|null} message - Optional notification sent with the state.
     */
    #publishRoomState(peer, room, playerName, message = null) {
        this.#publish(
            peer,
            this.#game.stateMapper.toResponse(
                Constants.VIEWS.ROOM,
                message,
                Object.freeze({
                    ...this.#game.stateMapper.toRoomData(room, playerName),
                    ...this.#getModeData(),
                    isBusy: false
                })
            )
        );
    }

    /**
     * Registers a peer as currently viewing Home.
     *
     * @param {Object} peer - Connected transport peer.
     */
    #registerHomePeer(peer) {
        if (peer.isOpen) {
            this.#homePeers.add(peer);
        }
    }

    /**
     * Removes a peer from Home tracking.
     *
     * @param {Object} peer - Connected transport peer.
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
            ...this.#game.stateMapper.toHomeData(this.#roomsByKey.values()),
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
     * @param {Object} peer - Connected transport peer.
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #publishHomeState(peer, homeState) {
        this.#registerHomePeer(peer);
        this.#publishViewState(peer, Constants.VIEWS.HOME, homeState);
    }

    /** Builds and publishes the latest Home directory snapshot to one peer. */
    #publishCurrentHomeState(peer) {
        this.#publishHomeState(peer, this.#createHomeState());
    }

    /**
     * Sends a forced room-exit notification and Home state.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {string} title - Warning title.
     * @param {string} message - Warning message.
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #publishInvoluntaryHomeState(peer, title, message, homeState) {
        this.#registerHomePeer(peer);
        this.#publish(
            peer,
            this.#game.stateMapper.toResponse(
                Constants.VIEWS.HOME,
                this.#game.stateMapper.toMessage(Constants.STATUS.WARNING, title, message),
                homeState
            )
        );
    }

    // -------------------------------------------------------------------------
    // Client rooms and membership transitions
    // -------------------------------------------------------------------------

    /**
     * Registers a client with a room.
     *
     * @param {string} tabId - Tab ID.
     * @param {Object} peer - Connected transport peer.
     * @param {string} roomKey - Normalized room lookup key.
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
     * @param {Object} peer - Connected transport peer.
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
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string} playerName - Display name of the seated actor.
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
     * @param {Object} peer - Connected transport peer.
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
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string} playerName - Idle player name.
     * @returns {Promise<void>}
     */
    async #moveIdlePlayerToView(roomKey, playerName) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        const client = this.#findClientByPlayer(roomKey, playerName);

        if (room !== null && client !== null) {
            const removedPlayer = await room.moveActorToView(playerName, client.tabId);

            if (removedPlayer !== null) {
                if (this.#isCurrentClient(client)) {
                    client.playerName = null;

                    this.#publishRoomState(
                        client.peer,
                        room,
                        null,
                        this.#game.stateMapper.toMessage(
                            Constants.STATUS.WARNING,
                            Constants.NOTIFICATIONS.MOVED_TO_VIEWING.title,
                            Constants.NOTIFICATIONS.MOVED_TO_VIEWING.message
                        )
                    );

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
            await room.removeActor(playerName);
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
     * @param {string} roomKey - Normalized room lookup key.
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
     * @param {string} roomKey - Normalized room lookup key.
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
     * @param {string} roomKey - Normalized room lookup key.
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

    /** Completes a scheduled closure only if the room remains empty. */
    #closeRoomAfterIdle(roomKey) {
        this.#roomClosureTimersByRoomKey.delete(roomKey);
        this.#closeRoomIfNoPlayersRemain(roomKey);
    }

    /**
     * Checks whether a registered room currently has no players.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {boolean} True when the room exists and has no players.
     */
    #isRoomEmpty(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        return room !== null && room.isEmpty();
    }

    /**
     * Cancels a pending empty-room closure check.
     *
     * @param {string} roomKey - Normalized room lookup key.
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
     * @param {string} roomKey - Normalized room lookup key.
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
                    Constants.NOTIFICATIONS.ROOM_CLOSED.title,
                    Constants.NOTIFICATIONS.ROOM_CLOSED.message,
                    homeState
                );
            }
        }
    }

    /**
     * Continues bot turn processing while the room remains active.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {Promise<void>}
     */
    async #continueAutomatedTurn(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null && room.isRoundActive()) {
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
            const command = ValidationUtils.requiredString(parsed.command, "Command");
            const data = parsed.data === undefined ? {} : ValidationUtils.object(parsed.data, "Command data");

            this.#rateLimit.enforceConnection(peer, command, 75);
            await this.#routeCommand(peer, command, data);
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
     * Routes a command to its handler.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {string} type - Command type.
     * @param {Object} data - Command data.
     * @returns {Promise<void>}
     */
    async #routeCommand(peer, command, data) {
        const handlers = {
            [Constants.COMMANDS.LIST]: this.#list,
            [Constants.COMMANDS.CREATE]: this.#create,
            [Constants.COMMANDS.VIEW]: this.#view,
            [Constants.COMMANDS.JOIN]: this.#join,
            [Constants.COMMANDS.LEAVE]: this.#leave,
            [Constants.COMMANDS.START]: this.#start
        };

        const handler = handlers[command];

        if (typeof handler !== "function") {
            await this.#handleGameCommand(peer, command, data);
            return;
        }

        await handler.call(this, peer, data);
    }

    /**
     * Handles a disconnected peer.
     *
     * Room clients are silently removed.
     *
     * @param {Object} peer - Connected transport peer.
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
            const ownsRoom =
                this.#profile.closeOwnedRoom && this.#ownerTabIdsByRoomKey.get(client.roomKey) === client.tabId;

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
        this.#publish(peer, this.#game.stateMapper.toResponse(view, null, data));
    }

    /**
     * Publishes an error response.
     *
     * @param {Object|null|undefined} peer - Client peer.
     * @param {string} message - Error message.
     */
    #publishError(peer, message) {
        this.#publishNotification(peer, Constants.STATUS.ERROR, Constants.NOTIFICATIONS.ERROR_TITLE, message);
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
        this.#publish(
            peer,
            this.#game.stateMapper.toResponse(null, this.#game.stateMapper.toMessage(status, title, message), null)
        );
    }

    /**
     * Welcomes a new viewer.
     *
     * @param {Object} peer - Viewer peer.
     */
    #publishViewerWelcome(peer) {
        const welcome = Constants.NOTIFICATIONS.VIEWER_WELCOME;
        this.#publishNotification(peer, Constants.STATUS.INFO, welcome.title, welcome.message);
    }

    /**
     * Welcomes a newly joined player and identifies their play area.
     *
     * @param {Object} peer - Player peer.
     * @param {string} playerName - Joined player name.
     */
    #publishPlayerWelcome(peer, playerName) {
        const welcome = Constants.NOTIFICATIONS.PLAYER_WELCOME;
        this.#publishNotification(peer, Constants.STATUS.INFO, `${welcome.title}, ${playerName}!`, this.#game.welcomeMessage);
    }

    // -------------------------------------------------------------------------
    // Client command handlers and their shared requirements
    // -------------------------------------------------------------------------

    /**
     * Publishes the current Home directory to a peer that is not in a room.
     *
     * @param {Object} peer - Connected transport peer.
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
     * Creates, optionally fills, persists, joins, and publishes a custom room.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Canonical command payload.
     * @returns {Promise<void>}
     */
    async #create(peer, data) {
        const tabId = ValidationUtils.requiredString(data.tabId, "tabId");
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");
        const roomKey = this.#normalizeRoomKey(roomName);
        const playerLimit = this.#normalizePlayerLimit(data.playerLimit);

        this.#rateLimit.enforcePlayerThrottle(tabId, Constants.COMMANDS.CREATE, 500);

        if (this.#clientsByTabId.has(tabId)) {
            throw new UserNotification("Leave the current room before creating another room.");
        }

        if (this.#roomsByKey.has(roomKey)) {
            throw new UserNotification(`Room already exists: ${roomName}`);
        }

        const room = this.#registerRoom(roomName, playerLimit, roomKey);
        this.#customRoomKeys.add(roomKey);

        try {
            const player = await room.joinActor(playerName, false);
            const botCount = this.#profile.customBots === "fill" ? playerLimit - 1 : 0;

            await this.#addBotActors(room, botCount, player.name);
            await this.#store.save(Object.freeze({ roomName: room.name, playerLimit, botCount }));

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
     * Normalizes a requested actor limit, falling back to the configured maximum.
     *
     * @param {*} value - Untrusted actor-limit value from a command payload.
     * @returns {number} Requested integer actor limit or the configured default.
     */
    #normalizePlayerLimit(value) {
        const parsedPlayerLimit = Number(value || this.#game.constants.ROOM_PLAYER_LIMIT);

        return Number.isInteger(parsedPlayerLimit) ? parsedPlayerLimit : this.#game.constants.ROOM_PLAYER_LIMIT;
    }

    /**
     * Registers a peer as a viewer and publishes its authoritative room snapshot.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Canonical command payload.
     * @returns {Promise<void>}
     */
    async #view(peer, data) {
        const { tabId, roomKey, room, existingClient } = this.#requireRoomContext(
            peer,
            data,
            Constants.COMMANDS.VIEW,
            300
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

    /** Seats a new actor, upgrading an existing viewer connection when present. */
    async #join(peer, data) {
        const { tabId, roomKey, room, existingClient } = this.#requireRoomContext(
            peer,
            data,
            Constants.COMMANDS.JOIN,
            500
        );
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");

        this.#assertPlayerNameAvailable(room, playerName);

        if (existingClient !== null && existingClient.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before joining another room.");
        }

        if (existingClient !== null && existingClient.playerName !== null) {
            throw new UserNotification("You already joined this room.");
        }

        const player = await room.joinActor(playerName, false, existingClient === null ? null : tabId);

        if (existingClient === null) {
            this.#registerClient(tabId, peer, roomKey, player.name);
        } else {
            existingClient.playerName = player.name;
        }

        if (
            this.#profile.closeOwnedRoom &&
            this.#customRoomKeys.has(roomKey) &&
            !this.#ownerTabIdsByRoomKey.has(roomKey)
        ) {
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
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Command payload containing tab and room identity.
     * @param {string} command - Room command.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,roomKey:string,room:Room,existingClient:Object|null}} Room context.
     */
    #requireRoomContext(peer, data, command, throttleMs) {
        const tabId = ValidationUtils.requiredString(data.tabId, "tabId");
        const { roomKey, room } = this.#requireDataRoom(data);
        const existingClient = this.#clientsByTabId.get(tabId) ?? null;

        this.#rateLimit.enforcePlayerThrottle(tabId, command, throttleMs);

        if (existingClient !== null && existingClient.peer !== peer) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }

        return { tabId, roomKey, room, existingClient };
    }

    /**
     * Normalizes command room identity and resolves the registered room.
     *
     * @param {Object} data - Command data.
     * @returns {{roomKey:string,room:Room}} Room context.
     */
    #requireDataRoom(data) {
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
        const roomKey = this.#normalizeRoomKey(roomName);

        return { roomKey, room: this.#requireRoomByKey(roomKey) };
    }

    /**
     * Rejects an actor display name already seated in the target room.
     *
     * @param {Room} room - Target room.
     * @param {string} playerName - Requested actor display name.
     */
    #assertPlayerNameAvailable(room, playerName) {
        if (room.hasActor(playerName)) {
            throw new UserNotification(`Player already exists: ${playerName}`);
        }
    }

    /** Removes the authenticated occupant, applies ownership cleanup, and returns Home state. */
    async #leave(peer, data) {
        const context = this.#requireThrottledClient(peer, data, Constants.COMMANDS.LEAVE, 300);
        const room = this.#roomsByKey.get(context.client.roomKey) ?? null;

        if (room !== null) {
            const ownsRoom =
                this.#profile.closeOwnedRoom &&
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
     * Authenticates a tab-scoped client against the requesting transport peer.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Canonical command payload.
     * @returns {{tabId:string, client:Object}} Client context.
     * @throws {UserNotification} When the requested room or authenticated client context is unavailable.
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
     * Authenticates a room client and applies its tab-scoped command throttle.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Command data.
     * @param {string} command - Client command.
     * @param {number} throttleMs - Player throttle window.
     * @returns {{tabId:string,client:Object}} Throttled client context.
     */
    #requireThrottledClient(peer, data, command, throttleMs) {
        const context = this.#requireClient(peer, data);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, command, throttleMs);

        return context;
    }

    /**
     * Resolves an authenticated seated actor and its current room.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Canonical command payload.
     * @returns {{tabId:string, client:Object, roomKey:string, room:Room, playerName:string}} Player room.
     * @throws {UserNotification} When the requested room or authenticated client context is unavailable.
     */
    #requirePlayerRoom(peer, data) {
        const context = this.#requireClient(peer, data);
        const client = context.client;

        if (client.playerName === null) {
            throw new UserNotification("Join the room before making a move.");
        }

        const room = this.#requireRoomByKey(client.roomKey);

        if (!room.hasActor(client.playerName)) {
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
     * Resolves an authenticated actor context and applies actor- and room-scoped throttles.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Command data.
     * @param {string} command - Player command.
     * @param {number} playerThrottleMs - Player throttle window.
     * @param {number|null} [roomThrottleMs=null] - Optional room throttle window.
     * @returns {{tabId:string,client:Object,roomKey:string,room:Room,playerName:string}} Player room.
     */
    #requireThrottledPlayerRoom(peer, data, command, playerThrottleMs, roomThrottleMs) {
        const context = this.#requirePlayerRoom(peer, data);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, command, playerThrottleMs);

        if (roomThrottleMs !== null) {
            this.#rateLimit.enforceRoomThrottle(context.roomKey, command, roomThrottleMs);
        }

        return context;
    }

    /**
     * Starts a round for an authenticated actor and advances any opening bot turns.
     *
     * @param {Object} peer - Connected transport peer.
     * @param {Object} data - Canonical command payload.
     * @returns {Promise<void>}
     */
    async #start(peer, data) {
        const context = this.#requireThrottledPlayerRoom(peer, data, Constants.COMMANDS.START, 1000, 500);

        await context.room.startRound();
        await this.#runAutomatedTurn(context.roomKey);
    }

    /** Authenticates and throttles game-specific moves before delegating rules. */
    async #handleGameCommand(peer, command, data) {
        const limits = this.#game.commands[command];
        if (limits === undefined) {
            throw new UserNotification(`Unknown command: ${command}`);
        }
        const context = this.#requireThrottledPlayerRoom(peer, data, command, limits.player, limits.room);
        const notification = await this.#game.execute(context.room, context.playerName, command, data);
        if (notification !== null) {
            this.#publishNotification(peer, notification.status, notification.title, notification.message);
        }
        await this.#continueAutomatedTurn(context.roomKey);
    }

    /** Advances automated play while the selected game has an automated move. */
    async #runAutomatedTurn(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        if (room !== null && (await this.#game.runAutomatedTurn(room))) {
            await this.#runAutomatedTurn(roomKey);
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
