"use strict";

/** Transport-neutral room orchestrator shared by every runtime. */

import {UserNotification} from "../core/UserNotification.js";

import {Constants} from "../core/Constants.js";
import {ValidationUtils} from "../core/ValidationUtils.js";
import {Actor} from "../core/Actor.js";
import {BotActor} from "../core/BotActor.js";
import {Knockout} from "../core/Room.js";
import {Room} from "../core/Room.js";
import {StateMapper} from "../core/StateMapper.js";
import {RoomLifecycle} from "./RoomLifecycle.js";
import {ConnectionRegistry} from "./ConnectionRegistry.js";
import {HostRequest} from "./HostRequest.js";
import {HostRequestContext} from "./HostRequestContext.js";

/** Lightweight in-memory request throttle shared by direct and hosted Host. */
export class RequestThrottle {
    /**
     * @type {Map<string, number>} Most recent accepted request timestamp for each scoped key.
     */
    #lastRequestAtByKey = new Map();

    /**
     * Enforces throttle for a connected connection.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Host connection.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceConnection(connection, eventType, windowMs) {
        const tabId =
            typeof connection?.tabId === "string" && connection.tabId.trim() ? connection.tabId.trim() : (connection?.id ?? "anonymous");

        this.#enforce(`connection:${tabId}:${eventType}`, windowMs);
    }

    /**
     * Enforces throttle for an actor.
     *
     * @param {string} tabId - Browser tab id.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceActorThrottle(tabId, eventType, windowMs) {
        this.#enforce(`actor:${ValidationUtils.requiredString(tabId, "tabId")}:${eventType}`, windowMs);
    }

    /**
     * Enforces throttle for a room.
     *
     * @param {string} roomKey - Normalized room key.
     * @param {string} eventType - Event type.
     * @param {number} windowMs - Minimum interval.
     */
    enforceRoomThrottle(roomKey, eventType, windowMs) {
        this.#enforce(`room:${ValidationUtils.requiredString(roomKey, "roomKey")}:${eventType}`, windowMs);
    }

    /**
     * Enforces throttle for a key.
     *
     * @param {string} key - Throttle key.
     * @param {number} windowMs - Minimum interval.
     * @throws {UserNotification} When another request for the scoped key was accepted too recently.
     */
    #enforce(key, windowMs) {
        const normalizedKey = ValidationUtils.requiredString(key, "Throttle key");
        const normalizedWindow = ValidationUtils.nonNegativeInteger(windowMs, "Throttle window");

        const now = Date.now();
        const previous = this.#lastRequestAtByKey.get(normalizedKey) ?? 0;

        if (now - previous < normalizedWindow) {
            throw new UserNotification("Too many requests. Please slow down.");
        }

        this.#lastRequestAtByKey.set(normalizedKey, now);
    }

    /**
     * Removes matching throttle keys.
     *
     * @param {string} prefix - Key prefix.
     */
    reset(prefix) {
        const text = ValidationUtils.requiredString(prefix, "Throttle reset prefix");

        for (const key of this.#lastRequestAtByKey.keys()) {
            if (key === text || key.startsWith(`${text}:`)) {
                this.#lastRequestAtByKey.delete(key);
            }
        }
    }

    /**
     * Removes throttle entries older than the specified age.
     *
     * @param {number} maxAgeMs - Maximum age in milliseconds.
     */
    prune(maxAgeMs) {
        const age = ValidationUtils.nonNegativeInteger(maxAgeMs, "Maximum age");

        const cutoff = Date.now() - age;

        for (const [key, timestamp] of this.#lastRequestAtByKey.entries()) {
            if (timestamp < cutoff) {
                this.#lastRequestAtByKey.delete(key);
            }
        }
    }

    /**
     * Removes every throttle record.
     */
    resetAll() {
        this.#lastRequestAtByKey.clear();
    }
}


/**
 * Transport-neutral host for Pick 2 rooms.
 *
 * Host owns room registration, connections, viewers, notifications, and lifecycle
 * orchestration; each Room owns actors and match rules.
 */
export class Host {
    /** Per-command actor and room throttles for card actions. */
    static COMMAND_LIMITS = Object.freeze({
        draw: Object.freeze({actor: 400, room: 100}),
        discard: Object.freeze({actor: 250, room: 100}),
        pass: Object.freeze({actor: 250, room: 100}),
        declare: Object.freeze({actor: 250, room: 100})
    });
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /**
     * @type {Map<string, Room>} Registered rooms keyed by normalized room identity.
     */
    #roomsByKey = new Map();

    /**
     * @type {RoomLifecycle} Deferred empty-room lifecycle work.
     */
    #roomLifecycle = new RoomLifecycle();

    /** @type {RoomLifecycle} Pending next-match starts. */
    #knockoutStarts = new RoomLifecycle();

    /** @type {RoomLifecycle} Pending sidelined-bot returns. */
    #botReturns = new RoomLifecycle();

    /** @type {Set<string>} Rooms currently converting eliminated actors. */
    #settlingKnockout = new Set();

    /**
     * @type {ConnectionRegistry} Host connections and authenticated room memberships.
     */
    #connections = new ConnectionRegistry();

    /**
     * @type {RequestThrottle} Shared request throttle across all connections and rooms.
     */
    #requestThrottle = new RequestThrottle();

    /**
     * @type {{mode:string, capabilities:Object, customBots:string|number, trackIdle:boolean}} Runtime profile.
     */
    #profile;

    /**
     * @type {Promise<void>} Initialization barrier for default rooms and bot actors.
     */
    #ready;

    /**
     * Creates a room Host.
     *
     * @param {string} mode - Runtime mode.
     * @param {string|number} customBots - Custom-Room bot policy.
     * @param {boolean} trackIdle - Whether to monitor idle Actors.
     */
    constructor(mode, customBots, trackIdle) {
        this.#profile = Host.#normalizeProfile(mode, customBots, trackIdle);
        this.#ready = this.#initializeRooms();
    }

    /**
     * @param {string} mode - Runtime mode.
     * @param {string|number} customBots - Bot policy.
     * @param {boolean} trackIdle - Idle policy.
     * @returns {Object} Normalized Host profile.
     */
    static #normalizeProfile(mode, customBots, trackIdle) {
        mode = mode === "direct" ? "direct" : "hosted";

        return Object.freeze({
            mode,
            capabilities: Object.freeze({
                create: true,
                join: true,
                view: true,
                invite: mode === "hosted",
                botFill: customBots === "fill",
                restart: true
            }),
            customBots: customBots === "fill" ? "fill" : 0,
            trackIdle: trackIdle === true
        });
    }

    /**
     * @param {Room} room - Room whose Actors should no longer be monitored.
     */
    static #stopIdleMonitoring(room) {
        for (const actor of room.match.turnOrder.actors.values()) {
            actor.stopIdleMonitoring();
        }
    }

    // -------------------------------------------------------------------------
    // Room registry and state publication
    // -------------------------------------------------------------------------

    /**
     * Accepts one transport-neutral connection.
     *
     * @param {function(Object): void} send - Transport response callback.
     * @param {function(number=, string=): void} disconnect - Transport disconnect callback.
     * @returns {import("./HostConnection.js").HostConnection} Host-side connection.
     */
    accept(send, disconnect) {
        const connection = this.#connections.createConnection(send, disconnect, this.#receive.bind(this), this.#disconnect.bind(this));

        this.#connections.subscribeHome(connection);
        void this.#ready.then(function publishInitialHome() {
            this.#publishHomeState(connection, this.#createHomeState());
        }.bind(this));

        return connection;
    }

    /**
     * Stops the Host and releases all resources.
     *
     * @returns {Promise<void>} Resolves when shutdown completes.
     */
    /** Removes expired rate-limit entries. */
    maintain() {
        this.#requestThrottle.prune(5 * 60 * 1000);
    }

    /** Creates configured Rooms and their initial bot actors. */
    async #initializeRooms() {
        for (const roomConfig of Constants.DEFAULT_ROOMS) {
            const roomKey = Actor.normalizeKey(roomConfig.roomName);
            const room = this.#registerRoom(roomConfig.roomName, roomConfig.actorLimit, roomKey);

            await this.#addBotActors(room, roomConfig.botCount, null);
        }
    }

    /**
     * Adds a fixed number of bot actors through the shared Room admission API.
     *
     * @param {Room} room - Room receiving the Bots.
     * @param {number} count - Maximum number of Bots to add.
     * @param {string|null} humanName - Human name that Bot names must not duplicate.
     */
    async #addBotActors(room, count, humanName) {
        let index = 0;

        while (index < count && !room.isFull()) {
            const baseName = Constants.DIRECT_OPPONENT_NAMES[index] ?? `Bot ${index + 1}`;
            const botName = humanName !== null && Actor.normalizeKey(baseName) === Actor.normalizeKey(humanName)
                ? `${baseName} Bot` : baseName;
            if (!room.hasActor(botName)) {
                await room.joinActor(botName, true);
            }

            index += 1;
        }
    }

    /**
     * Creates and registers a room.
     *
     * @param {string} roomName - Room name.
     * @param {number} actorLimit - Maximum seated actor count.
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {Room} Registered room.
     */
    #registerRoom(roomName, actorLimit, roomKey) {
        const room = this.createRoom(roomName, actorLimit);

        room.onAnyChange = this.#handleRoomChange.bind(this, roomKey, room);
        room.onActorIdle = this.#profile.trackIdle ? this.#moveIdleActorToView.bind(this, roomKey) : null;

        this.#roomsByKey.set(roomKey, room);
        return room;
    }

    /** Constructs the Room used by this Host. */
    createRoom(name, actorLimit) {
        return new Room(name, actorLimit);
    }

    /**
     * Broadcasts authoritative room state and enforces the active idle profile.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {Room} room - Room that changed.
     */
    #handleRoomChange(roomKey, room) {
        this.#broadcastRoomState(roomKey);

        if (!this.#profile.trackIdle && !room.match.nextMatchAvailable) {
            Host.#stopIdleMonitoring(room);
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
     * @throws {UserNotification} When the requested room is unavailable.
     */
    #requireRoomByKey(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room === null) {
            throw new UserNotification("Room not found.");
        }

        return room;
    }

    /**
     * Broadcasts current Room state to every connected membership.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #broadcastRoomState(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            for (const membership of this.#connections.inRoom(roomKey)) {
                if (membership.connection.isOpen) {
                    this.#publishRoomState(membership.connection, room, this.#resolveMembershipActorName(room, membership));
                }
            }

        }
    }

    /**
     * Resolves a membership's actor name against current room membership.
     *
     * @param {Room} room - Room instance.
     * @param {import("./RoomMembership.js").RoomMembership} membership - Room membership.
     * @returns {string|null} Valid actor name or null.
     */
    #resolveMembershipActorName(room, membership) {
        let actorName = null;

        if (membership.actorName !== null && room.hasActor(membership.actorName)) {
            actorName = membership.actorName;
        }

        return actorName;
    }

    /**
     * Sends active Room state to one membership.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     * @param {Room} room - Room instance.
     * @param {string|null} actorName - Room actor name.
     * @param {Object|null} message - Optional notification sent with the state.
     */
    #publishRoomState(connection, room, actorName, message = null) {
        this.#publish(
            connection,
            StateMapper.toResponse(
                Constants.VIEWS.ROOM,
                message,
                Object.freeze({
                    ...StateMapper.toRoomData(room, actorName),
                    ...this.#getConnectionData(),
                    isBusy: false
                })
            )
        );
    }

    /**
     * Broadcasts the current Home data.
     *
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #broadcastHomeState(homeState) {
        for (const connection of this.#connections.homeConnections()) {
            if (connection.isOpen) {
                this.#publish(connection, StateMapper.toResponse(Constants.VIEWS.HOME, null, homeState));
            } else {
                this.#connections.unsubscribeHome(connection);
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
            ...this.#getConnectionData()
        });
    }

    /**
     * @returns {Object} Shared connection metadata.
     */
    #getConnectionData() {
        return Object.freeze({
            connectionMode: this.#profile.mode,
            capabilities: this.#profile.capabilities
        });
    }

    /**
     * Sends a normal transition to Home.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     * @param {{rooms:Object[]}} homeState - Home data.
     * @param {Object|null} message - Optional notification sent with Home state.
     */
    #publishHomeState(connection, homeState, message = null) {
        this.#connections.subscribeHome(connection);
        this.#publish(connection, StateMapper.toResponse(Constants.VIEWS.HOME, message, homeState));
    }

    // -------------------------------------------------------------------------
    // Room memberships and membership transitions
    // -------------------------------------------------------------------------

    /**
     * Registers a membership with a room.
     *
     * @param {string} tabId - Tab ID.
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string|null} actorName - Actor name.
     */
    #registerMembership(tabId, connection, roomKey, actorName) {
        const existingMembership = this.#connections.get(tabId);

        if (existingMembership !== null && existingMembership.connection !== connection) {
            existingMembership.connection.terminate(1008, "Room replaced");
            void this.#disconnect(existingMembership.connection);
        }

        this.#connections.register(tabId, connection, roomKey, actorName);
    }

    /**
     * Unregisters a membership from a room.
     *
     * This does not mutate Room membership or move the socket to the room.
     *
     * @param {string} tabId - Tab ID.
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     */
    #unregisterMembership(tabId, connection) {
        this.#connections.unregister(tabId, connection);

        this.#requestThrottle.reset(`actor:${tabId}`);
        this.#requestThrottle.reset(`connection:${tabId}`);

    }

    /**
     * Moves an idle actor back to viewing state.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string} actorName - Idle actor name.
     * @returns {Promise<void>}
     */
    async #moveIdleActorToView(roomKey, actorName) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        const membership = this.#connections.findActor(roomKey, actorName);

        if (room !== null && membership !== null) {
            const removedActor = await room.moveActorToView(actorName, membership.tabId);

            if (removedActor !== null) {
                if (this.#connections.isCurrent(membership)) {
                    membership.view();

                    this.#publishRoomState(
                        membership.connection,
                        room,
                        null,
                        StateMapper.toMessage(
                            Constants.STATUS.WARNING,
                            Constants.NOTIFICATIONS.MOVED_TO_VIEWING.title,
                            Constants.NOTIFICATIONS.MOVED_TO_VIEWING.message
                        )
                    );

                    this.#scheduleRoomClosureIfEmpty(roomKey);
                    await this.#advanceRoom(roomKey);
                } else {
                    room.leaveViewer(membership.tabId);
                    await this.#continueOrCloseRoom(roomKey);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Room closure and match continuation
    // -------------------------------------------------------------------------

    /**
     * Removes one occupant without waiting for subsequent automated turns.
     *
     * @param {import("./RoomMembership.js").RoomMembership} membership - Room membership.
     * @param {Room} room - Room instance.
     * @returns {Promise<void>}
     */
    async #removeMembership(membership, room) {
        const actorName = membership.actorName;

        this.#unregisterMembership(membership.tabId, membership.connection);

        if (actorName !== null) {
            await room.removeActor(actorName);
        } else {
            room.leaveViewer(membership.tabId);
        }

    }

    /**
     * Continues the room or closes the room if no actors remain.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {Promise<void>}
     */
    async #continueOrCloseRoom(roomKey) {
        await this.#afterRoomAction(roomKey);
        this.#closeRoomIfNoActorsRemain(roomKey);
        if (!this.#roomsByKey.has(roomKey)) return;
        await this.#advanceRoom(roomKey);
    }

    /**
     * Closes a room when no actors remain.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #closeRoomIfNoActorsRemain(roomKey) {
        if (this.#isRoomEmpty(roomKey) && !this.#roomLifecycle.hasPending(roomKey)) {
            this.#closeRoom(roomKey);
        }
    }

    /**
     * Schedules a second empty-room check after the idle-actor notification
     * grace period when the room is currently empty.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #scheduleRoomClosureIfEmpty(roomKey) {
        if (this.#isRoomEmpty(roomKey)) {
            this.#roomLifecycle.schedule(roomKey, Constants.ROOM_WAIT_MS, this.#closeRoomIfNoActorsRemain.bind(this));
        }
    }

    /**
     * Checks whether a registered room currently has no actors.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {boolean} True when the room exists and has no actors.
     */
    #isRoomEmpty(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        return room !== null && room.isEmpty();
    }

    // -------------------------------------------------------------------------
    // Request routing
    // -------------------------------------------------------------------------

    /**
     * Closes a room and returns every viewer to the Room.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #closeRoom(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            this.#roomLifecycle.cancel(roomKey);
            this.#knockoutStarts.cancel(roomKey);
            this.#botReturns.cancel(roomKey);

            const viewingMemberships = this.#connections.inRoom(roomKey);

            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            this.#requestThrottle.reset(`room:${roomKey}`);

            for (const membership of viewingMemberships) {
                this.#unregisterMembership(membership.tabId, membership.connection);
            }

            const homeState = this.#createHomeState();

            this.#broadcastHomeState(homeState);

            for (const membership of viewingMemberships) {
                this.#publishHomeState(
                    membership.connection,
                    homeState,
                    StateMapper.toMessage(Constants.STATUS.WARNING,
                        Constants.NOTIFICATIONS.ROOM_CLOSED.title,
                        Constants.NOTIFICATIONS.ROOM_CLOSED.message)
                );
            }
        }
    }

    /**
     * Processes one request from a connected connection.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Connection that sent the request.
     * @param {Object|string|null} rawRequest - Untrusted request payload.
     */
    async #receive(connection, rawRequest) {
        await this.#ready;

        if (!connection.isOpen) {
            return;
        }

        try {
            const request = HostRequest.parse(rawRequest);
            const context = new HostRequestContext(connection, request);

            this.#requestThrottle.enforceConnection(connection, context.request.command, 75);
            switch (context.request.command) {
                case Constants.COMMANDS.LIST:
                    await this.#list(context);
                    break;
                case Constants.COMMANDS.CREATE:
                    await this.#create(context);
                    break;
                case Constants.COMMANDS.VIEW:
                    await this.#view(context);
                    break;
                case Constants.COMMANDS.JOIN:
                    await this.#join(context);
                    break;
                case Constants.COMMANDS.LEAVE:
                    await this.#leave(context);
                    break;
                case Constants.COMMANDS.START:
                    await this.#start(context);
                    break;
                default:
                    await this.#handleMatchCommand(context);
            }
        } catch (error) {
            if (!(error instanceof UserNotification)) {
                console.error("Host request failed:", error);
            }
            this.#publishNotification(connection, Constants.STATUS.ERROR,
                Constants.NOTIFICATIONS.ERROR_TITLE,
                error instanceof UserNotification ? error.message : "Host error occurred.");
        }
    }

    /**
     * Handles a disconnected connection.
     *
     * Room memberships are silently removed.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     * @returns {Promise<void>}
     */
    async #disconnect(connection) {
        if (!connection.isOpen) {
            return;
        }

        connection.markClosed();
        this.#connections.unsubscribeHome(connection);

        const membership = this.#connections.findConnection(connection);

        if (membership !== null) {
            const room = this.#roomsByKey.get(membership.roomKey) ?? null;
            if (room !== null) {
                await this.#removeMembership(membership, room);
                await this.#continueOrCloseRoom(membership.roomKey);
            } else {
                this.#unregisterMembership(membership.tabId, connection);
            }
        }
    }

    /**
     * Publishes one structured response.
     *
     * @param {HostConnection|null|undefined} connection - Client connection.
     * @param {Object} response - Response data.
     */
    #publish(connection, response) {
        if (connection?.isOpen) {
            connection.publish(response);
        }
    }

    // -------------------------------------------------------------------------
    // Command handlers and their shared requirements
    // -------------------------------------------------------------------------

    /**
     * Publishes a message response.
     *
     * @param {HostConnection|null|undefined} connection - Client connection.
     * @param {string} status - Message status.
     * @param {string} title - Message title.
     * @param {string} message - Message text.
     */
    #publishNotification(connection, status, title, message) {
        this.#publish(
            connection,
            StateMapper.toResponse(null, StateMapper.toMessage(status, title, message), null)
        );
    }

    /**
     * Publishes the current Home directory to a connection that is not in a room.
     *
     * @param {HostRequestContext} context - Validated list command.
     * @returns {Promise<void>}
     */
    async #list(context) {
        if (this.#connections.findConnection(context.connection) !== null) {
            throw new UserNotification("Leave the current room before returning Home.");
        }

        this.#publishHomeState(context.connection, this.#createHomeState());
    }

    /**
     * Creates, optionally fills, joins, and publishes a custom room.
     *
     * @param {HostRequestContext} context - Validated create command.
     * @returns {Promise<void>}
     */
    async #create(context) {
        context.identifyTab();
        const {connection, tabId} = context;
        const {data} = context.request;
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
        const actorName = ValidationUtils.requiredString(data.actorName, "Actor name");
        const roomKey = Actor.normalizeKey(roomName);
        const actorLimit = this.#normalizeActorLimit(data.actorLimit);

        this.#requestThrottle.enforceActorThrottle(tabId, Constants.COMMANDS.CREATE, 500);

        if (this.#connections.has(tabId)) {
            throw new UserNotification("Leave the current room before creating another room.");
        }

        if (this.#roomsByKey.has(roomKey)) {
            throw new UserNotification(`Room already exists: ${roomName}`);
        }

        const room = this.#registerRoom(roomName, actorLimit, roomKey);
        try {
            const actor = await room.joinActor(actorName, false);
            const botCount = this.#profile.customBots === "fill" ? actorLimit - 1 : 0;

            await this.#addBotActors(room, botCount, actor.name);
            this.#registerMembership(tabId, connection, roomKey, actor.name);
            this.#publishRoomState(connection, room, actor.name);
            this.#publishNotification(connection, Constants.STATUS.INFO,
                `${Constants.NOTIFICATIONS.ACTOR_WELCOME.title}, ${actor.name}!`,
                Constants.NOTIFICATIONS.ACTOR_WELCOME.message);
            this.#broadcastHomeState(this.#createHomeState());
        } catch (error) {
            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            throw error;
        }
    }

    /**
     * Normalizes a requested actor limit, falling back to the configured maximum.
     *
     * @param {*} value - Untrusted actor-limit value from a command payload.
     * @returns {number} Requested integer actor limit or the configured default.
     */
    #normalizeActorLimit(value) {
        const parsedActorLimit = Number(value || Constants.ROOM_ACTOR_LIMIT);

        return Number.isInteger(parsedActorLimit) ? parsedActorLimit : Constants.ROOM_ACTOR_LIMIT;
    }

    /**
     * Registers a connection as a viewer and publishes its authoritative room snapshot.
     *
     * @param {HostRequestContext} context - Validated view command.
     * @returns {Promise<void>}
     */
    async #view(context) {
        this.#requireRoomContext(context, 300);
        const {connection, tabId, roomKey, room} = context;

        if (context.membership !== null && context.membership.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before viewing another room.");
        }

        if (context.membership === null) {
            room.view(tabId);
            this.#registerMembership(tabId, connection, roomKey, null);
            this.#publishRoomState(connection, room, null);
            const welcome = Constants.NOTIFICATIONS.VIEWER_WELCOME;
            this.#publishNotification(connection, Constants.STATUS.INFO, welcome.title, welcome.message);
        } else {
            this.#publishRoomState(connection, room, this.#resolveMembershipActorName(room, context.membership));
        }
    }

    /**
     * @param {HostRequestContext} context - Validated join command.
     * @returns {Promise<void>}
     */
    async #join(context) {
        this.#requireRoomContext(context, 500);
        const {connection, tabId, roomKey, room} = context;
        const {data} = context.request;
        const actorName = ValidationUtils.requiredString(data.actorName, "Actor name");

        this.#assertActorNameAvailable(room, actorName);

        if (context.membership !== null && context.membership.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before joining another room.");
        }

        if (context.membership !== null && context.membership.actorName !== null) {
            throw new UserNotification("You already joined this room.");
        }

        const actor = await room.joinActor(actorName, false, context.membership === null ? null : tabId);

        if (context.membership === null) {
            this.#registerMembership(tabId, connection, roomKey, actor.name);
        }

        const currentMembership = this.#connections.get(tabId);

        if (currentMembership !== null && currentMembership.connection === connection && currentMembership.roomKey === roomKey) {
            currentMembership.join(actor.name);
            this.#publishRoomState(connection, room, actor.name);
            this.#publishNotification(connection, Constants.STATUS.INFO,
                `${Constants.NOTIFICATIONS.ACTOR_WELCOME.title}, ${actor.name}!`,
                Constants.NOTIFICATIONS.ACTOR_WELCOME.message);
        }
    }

    /**
     * Resolves the shared context for viewing or joining a room.
     *
     * @param {HostRequestContext} context - Command being resolved.
     * @param {number} throttleMs - Actor throttle window.
     */
    #requireRoomContext(context, throttleMs) {
        context.identifyTab();
        this.#requireDataRoom(context);
        context.attachMembership(this.#connections.get(context.tabId));

        this.#requestThrottle.enforceActorThrottle(context.tabId, context.request.command, throttleMs);

        if (context.membership !== null && context.membership.connection !== context.connection) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }
    }

    /**
     * Normalizes command room identity and resolves the registered room.
     *
     * @param {HostRequestContext} context - Command being resolved.
     */
    #requireDataRoom(context) {
        const roomName = ValidationUtils.requiredString(context.request.data.roomName, "Room name");
        const roomKey = Actor.normalizeKey(roomName);

        context.attachRoom(roomKey, this.#requireRoomByKey(roomKey));
    }

    /**
     * Rejects an actor display name already seated in the target room.
     *
     * @param {Room} room - Target room.
     * @param {string} actorName - Requested actor display name.
     */
    #assertActorNameAvailable(room, actorName) {
        if (room.hasActor(actorName)) {
            throw new UserNotification(`Actor already exists: ${actorName}`);
        }
    }

    /**
     * @param {HostRequestContext} context - Validated leave command.
     * @returns {Promise<void>}
     */
    async #leave(context) {
        this.#requireThrottledClient(context, 300);
        const room = this.#roomsByKey.get(context.membership.roomKey) ?? null;

        if (room !== null) {
            await this.#removeMembership(context.membership, room);
            await this.#continueOrCloseRoom(context.membership.roomKey);
        } else {
            this.#unregisterMembership(context.tabId, context.connection);
        }
        this.#publishHomeState(context.connection, this.#createHomeState());
    }

    /**
     * Authenticates a tab-scoped membership against the requesting transport connection.
     *
     * @param {HostRequestContext} context - Command being authenticated.
     * @throws {UserNotification} When the requested room or authenticated membership context is unavailable.
     */
    #requireClient(context) {
        context.identifyTab();
        context.attachMembership(this.#connections.get(context.tabId));

        if (context.membership === null || context.membership.connection !== context.connection) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }
    }

    /**
     * Authenticates a room membership and applies its tab-scoped command throttle.
     *
     * @param {HostRequestContext} context - Command being authenticated.
     * @param {number} throttleMs - Actor throttle window.
     */
    #requireThrottledClient(context, throttleMs) {
        this.#requireClient(context);
        this.#requestThrottle.enforceActorThrottle(context.tabId, context.request.command, throttleMs);
    }

    /**
     * Resolves an authenticated seated actor and its current room.
     *
     * @param {HostRequestContext} context - Command being authenticated.
     * @throws {UserNotification} When the requested room or authenticated membership context is unavailable.
     */
    #requireActorRoom(context) {
        this.#requireClient(context);
        if (context.membership.actorName === null) {
            throw new UserNotification("Join the room before making a move.");
        }

        const room = this.#requireRoomByKey(context.membership.roomKey);

        if (!room.hasActor(context.membership.actorName)) {
            throw new UserNotification("Your actor connection expired. Rejoin the room.");
        }

        context.attachRoom(context.membership.roomKey, room);
    }

    /**
     * Resolves an authenticated actor context and applies actor- and room-scoped throttles.
     *
     * @param {HostRequestContext} context - Command being authenticated.
     * @param {number} actorThrottleMs - Actor throttle window.
     * @param {number|null} [roomThrottleMs=null] - Optional room throttle window.
     */
    #requireThrottledActorRoom(context, actorThrottleMs, roomThrottleMs) {
        this.#requireActorRoom(context);

        this.#requestThrottle.enforceActorThrottle(context.tabId, context.request.command, actorThrottleMs);

        if (roomThrottleMs !== null) {
            this.#requestThrottle.enforceRoomThrottle(context.roomKey, context.request.command, roomThrottleMs);
        }

    }

    /**
     * Starts a match for an authenticated actor and advances any opening bot turns.
     *
     * @param {HostRequestContext} context - Validated start command.
     * @returns {Promise<void>}
     */
    async #start(context) {
        this.#requireActorRoom(context);
        const knockout = context.request.data.knockout ?? null;
        const isNextKnockoutMatch = context.room.match.nextMatchAvailable;
        this.#requestThrottle.enforceActorThrottle(context.tabId, context.request.command, isNextKnockoutMatch ? 0 : 1000);
        this.#requestThrottle.enforceRoomThrottle(context.roomKey, context.request.command, isNextKnockoutMatch ? 0 : 500);
        if (context.room.match instanceof Knockout && context.room.match.isKnockoutComplete) {
            await this.#returnSidelinedBots(context.roomKey);
        }
        await this.#startMatchAndContinue(context.roomKey, context.room, isNextKnockoutMatch ? null : knockout);
    }

    /**
     * @param {HostRequestContext} context - Validated card command.
     * @returns {Promise<void>}
     */
    async #handleMatchCommand(context) {
        const limits = Host.COMMAND_LIMITS[context.request.command];
        if (limits === undefined) {
            throw new UserNotification(`Unknown command: ${context.request.command}`);
        }
        this.#requireThrottledActorRoom(context, limits.actor, limits.room);
        const notification = await this.executeMatchCommand(
            context.room,
            context.membership?.actorName ?? null,
            context.request.command,
            context.request.data
        );
        if (notification !== null) {
            this.#publishNotification(context.connection, notification.status, notification.title, notification.message);
        }
        await this.#advanceRoom(context.roomKey);
    }

    /** Executes a seated actor's card command and creates any draw notice. */
    async executeMatchCommand(room, actorName, command, data) {
        let drawn = [];
        let mocked = true;

        if (room.match.state === Constants.ROOM_STATE.FINISHED) {
            if (room.match instanceof Knockout) {
                throw new UserNotification(room.match.isKnockoutComplete
                    ? "The knockout has finished." : "Wait for the next knockout match.");
            }
            await room.resumeWaiting();
        }

        const payload = command === Constants.COMMANDS.DECLARE
            ? {...data, suit: Constants.normalizeStandardSuit(ValidationUtils.requiredString(data.suit, "Suit"))}
            : data;
        const result = await room.perform(command, actorName, payload);
        if (command === Constants.COMMANDS.DRAW || command === Constants.COMMANDS.PASS || command === Constants.COMMANDS.DISCARD) {
            drawn = result;
        }
        if (command === Constants.COMMANDS.DRAW) {
            mocked = room.match.state === Constants.ROOM_STATE.ACTIVE && drawn.length > 1;
        }

        if (drawn.length === 0) return null;
        const emoji = mocked ? `\n\n${Constants.EMOJIS.silly.random}` : "";
        return {
            status: Constants.STATUS.INFO,
            title: Constants.NOTIFICATIONS.CARDS_DRAWN_TITLE,
            message: `+ ${drawn.length} ${emoji}`
        };
    }

    /** Runs the current automated owner, if one can act. */
    async runAutomatedTurn(room) {
        const turnOwner = room.match.turnOrder.owner;
        if (!(turnOwner instanceof BotActor) || room.match.state !== Constants.ROOM_STATE.ACTIVE) return;
        if (room.match.pending?.command === Constants.COMMANDS.DECLARE) {
            await turnOwner.chooseSuit(room);
            return;
        }
        await turnOwner.takeTurn(room);
    }

    /**
     * Advances automated turns and handles the resulting match transition.
     * @param {string} roomKey - Normalized key of the Room advancing play.
     */
    async #advanceRoom(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        if (room === null) return;
        while (room.match.state === Constants.ROOM_STATE.ACTIVE) {
            const actor = room.match.turnOrder.owner;
            if (!(actor instanceof BotActor)) break;
            const before = [room.match.turnOrder.ownerKey, room.match.pending, actor.collection.size,
                actor.drawAllowance, room.match.collections.draw.size, room.match.collections.play.size,
                room.match.declaredSuit];
            await this.runAutomatedTurn(room);
            const after = [room.match.turnOrder.ownerKey, room.match.pending, actor.collection.size,
                actor.drawAllowance, room.match.collections.draw.size, room.match.collections.play.size,
                room.match.declaredSuit];
            if (before.every(function unchanged(value, index) {
                return value === after[index];
            })) break;
        }
        await this.#afterRoomAction(roomKey);
    }

    /** Handles the completed Room transition after its result has been published. */
    async #afterRoomAction(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        if (room === null || !(room.match instanceof Knockout) || room.match.state !== Constants.ROOM_STATE.FINISHED || this.#settlingKnockout.has(roomKey)) return;

        this.#settlingKnockout.add(roomKey);
        try {
            if (room.match.nextMatchAvailable && !this.#knockoutStarts.hasPending(roomKey)) {
                this.#knockoutStarts.schedule(roomKey, Constants.ROOM_WAIT_MS, this.#startScheduledKnockoutMatch.bind(this));
                room.notifyStateChange();
            } else if (room.match.isKnockoutComplete) {
                this.#knockoutStarts.cancel(roomKey);
                if (room.match.lostBotNames.length > 0 && !this.#botReturns.hasPending(roomKey)) {
                    this.#botReturns.schedule(roomKey, Constants.COUNTDOWN_SECONDS * 1000, this.#restoreSidelinedBotsWhenDue.bind(this));
                }
                this.#scheduleRoomClosureIfEmpty(roomKey);
            }
        } finally {
            this.#settlingKnockout.delete(roomKey);
        }
    }

    /** Demotes eliminated humans after the current order is pruned. */
    async #settleEliminatedActors(roomKey, actors) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        if (room === null) return;
        for (const actor of actors) {
            if (actor instanceof BotActor) continue;
            const membership = this.#connections.findActor(roomKey, actor.name);
            if (membership !== null && this.#connections.isCurrent(membership)) {
                membership.view();
                room.view(membership.tabId);
                this.#publishRoomState(membership.connection, room, null,
                    StateMapper.toMessage(Constants.STATUS.INFO, "Knockout result", "You were eliminated from the knockout."));
            }
        }
    }

    /** Starts one match, processes exclusions, and advances automated play. */
    async #startMatchAndContinue(roomKey, room, knockout = null) {
        const eliminated = await room.startMatch(knockout);
        this.#knockoutStarts.cancel(roomKey);
        await this.#settleEliminatedActors(roomKey, eliminated);
        await this.#advanceRoom(roomKey);
    }

    /** Starts a waiting Knockout match unless a human already started it. */
    async #startScheduledKnockoutMatch(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        if (room === null || !room.match.nextMatchAvailable) return;
        try {
            await this.#startMatchAndContinue(roomKey, room);
        } catch (error) {
            if (!(error instanceof UserNotification)) console.error("Scheduled Knockout start failed:", error);
        }
    }

    /** Recreates lost bots by name after the final result is available. */
    async #returnSidelinedBots(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;
        if (room === null || !(room.match instanceof Knockout) || !room.match.isKnockoutComplete) return;
        this.#botReturns.cancel(roomKey);
        await room.restoreLostBots();
    }

    /** Handles a scheduled bot return without leaving an unobserved rejection. */
    #restoreSidelinedBotsWhenDue(roomKey) {
        void this.#returnSidelinedBots(roomKey).catch(function reportReturnFailure(error) {
            console.error("Sidelined bot return failed:", error);
        });
    }

    // -------------------------------------------------------------------------

    /**
     * Stops the host and releases all resources.
     *
     * @returns {Promise<void>} Resolves when shutdown completes.
     */
    async shutdown() {
        await this.#ready;

        this.#roomLifecycle.clear();
        this.#knockoutStarts.clear();
        this.#botReturns.clear();

        for (const room of this.#roomsByKey.values()) {
            this.#clearRoomCallbacks(room);
            Host.#stopIdleMonitoring(room);
        }

        for (const connection of this.#connections.homeConnections()) {
            connection.markClosed();
            connection.terminate(1001, "Host stopped");
        }

        for (const membership of this.#connections.allRoomMemberships()) {
            if (membership.connection.isOpen) {
                membership.connection.markClosed();
                membership.connection.terminate(1001, "Host stopped");
            }
        }

        this.#roomsByKey.clear();
        this.#connections.clear();
        this.#requestThrottle.resetAll();
    }
}
