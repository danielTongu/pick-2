"use strict";

/** Transport-neutral room orchestrator shared by every runtime. */

import {UserNotification} from "../shared/UserNotification.js";

import {Constants} from "../shared/Constants.js";
import {ValidationUtils} from "../shared/ValidationUtils.js";
import {Player} from "../model/Player.js";
import {BotPlayer} from "../model/BotPlayer.js";
import {Knockout} from "../model/Knockout.js";
import {RoomService} from "../service/RoomService.js";
import { BotService } from "../service/BotService.js";
import {StateMapper} from "./StateMapper.js";
import {RoomLifecycle} from "./RoomLifecycle.js";
import {ConnectionRegistry} from "./ConnectionRegistry.js";

import { RequestThrottle } from "./RequestThrottle.js";

/**
 * @typedef {Object} RequestContext
 * @property {import("./HostConnection.js").HostConnection} connection - Requesting transport.
 * @property {string} command - Validated command.
 * @property {Object} data - Validated payload object.
 * @property {string|null} tabId - Validated identity for commands requiring membership.
 * @property {import("./ConnectionRegistry.js").RoomMembership|null} membership - Resolved membership.
 * @property {string|null} roomKey - Resolved room key.
 * @property {RoomService|null} service - Resolved room workflow.
 */

/**
 * Transport-neutral host for Pick 2 rooms.
 *
 * Host owns room registration, connections, viewers, notifications, and lifecycle
 * orchestration; each Room owns players and match rules.
 */
export class Host {

    /** @type {number} Maximum registered rooms per Host, including default rooms. */
    static MAX_ROOMS = 1000;

    /** Default rooms available in Direct and Hosted registries.*/
    static DEFAULT_ROOMS = Object.freeze([
        Object.freeze({ roomName: "Default-R0", playerLimit: 4, botCount: 3 }),
        Object.freeze({ roomName: "Default-R1", playerLimit: 4, botCount: 2 }),
        Object.freeze({ roomName: "Default-R2", playerLimit: 4, botCount: 1 })
    ]);

    /** Ordered display names for Direct bot opponents.*/
    static DIRECT_OPPONENT_NAMES = Object.freeze(["CM", "XC", "VI"]);

    /** Per-command player and room throttles for card actions. */
    static COMMAND_LIMITS = Object.freeze({
        draw: Object.freeze({player: 400, room: 100}),
        discard: Object.freeze({player: 250, room: 100}),
        pass: Object.freeze({player: 250, room: 100}),
        declare: Object.freeze({player: 250, room: 100})
    });

    /**
     * @type {Map<string, RoomService>} Registered rooms keyed by normalized room identity.
     */
    #roomServicesByKey = new Map();

    /**
     * @type {RoomLifecycle} Deferred empty-room lifecycle work.
     */
    #roomLifecycle = new RoomLifecycle();

    /** @type {RoomLifecycle} Pending next-match starts. */
    #knockoutStarts = new RoomLifecycle();

    /** @type {RoomLifecycle} Pending sidelined-bot returns. */
    #botReturns = new RoomLifecycle();

    /** @type {Set<string>} Rooms currently converting eliminated players. */
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
     * @type {Promise<void>} Initialization barrier for default rooms and bot players.
     */
    #ready;

    /** @type {BotService} Executes bots without adding behavior to player models. */
    #bots = new BotService();

    // ---- Construction and public lifecycle ----

    /**
     * Creates a room Host.
     *
     * @param {string} mode - Runtime mode.
     * @param {string|number} customBots - Custom-Room bot policy.
     * @param {boolean} trackIdle - Whether to monitor idle Players.
     */
    constructor(mode, customBots, trackIdle) {
        this.#profile = Host.#normalizeProfile(mode, customBots, trackIdle);
        this.#ready = this.#initializeRooms();
    }

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
     * Constructs one room workflow with its own model and mutation queue.
     * @param {string} name - Room display name.
     * @param {number} playerLimit - Maximum seated players.
     * @returns {RoomService} Unregistered service; Host reserves and wires it next.
     */
    createRoomService(name, playerLimit) {
        return new RoomService(name, playerLimit);
    }

    /** Removes expired rate-limit entries. */
    maintain() {
        this.#requestThrottle.prune(5 * 60 * 1000);
    }

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

        for (const service of this.#roomServicesByKey.values()) {
            service.dispose();
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

        this.#roomServicesByKey.clear();
        this.#connections.clear();
        this.#requestThrottle.resetAll();
    }

    // ---- Automated match execution ----

    /** Runs the current automated owner, if one can act. */
    async runAutomatedTurn(service) {
        const turnOwner = service.room.match.turnOrder.owner;
        if (!(turnOwner instanceof BotPlayer) || service.room.match.state !== Constants.ROOM_STATE.ACTIVE) return;
        await this.#bots.takeTurn(turnOwner, service);
    }

    // ---- Room initialization and registration ----

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

    /** Creates configured Rooms and their initial bot players. */
    async #initializeRooms() {
        for (const roomConfig of Host.DEFAULT_ROOMS) {
            const roomKey = Player.normalizeKey(roomConfig.roomName);
            const service = this.#registerRoomService(roomConfig.roomName, roomConfig.playerLimit, roomKey);

            await this.#addBotPlayers(service, roomConfig.botCount, null);
        }
    }

    /**
     * Adds a fixed number of bot players through the shared Room admission API.
     *
     * @param {RoomService} service - Room receiving the Bots.
     * @param {number} count - Maximum number of Bots to add.
     * @param {string|null} humanName - Human name that Bot names must not duplicate.
     */
    async #addBotPlayers(service, count, humanName) {
        let index = 0;

        while (index < count && !service.room.isFull()) {
            const baseName = Host.DIRECT_OPPONENT_NAMES[index] ?? `Bot ${index + 1}`;
            const botName = humanName !== null && Player.normalizeKey(baseName) === Player.normalizeKey(humanName)
                ? `${baseName} Bot` : baseName;
            if (!service.room.hasPlayer(botName)) {
                await service.joinPlayer(botName, true);
            }

            index += 1;
        }
    }

    /**
     * Creates and registers a room.
     *
     * @param {string} roomName - Room name.
     * @param {number} playerLimit - Maximum seated player count.
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {RoomService} Registered room.
     */
    #registerRoomService(roomName, playerLimit, roomKey) {
        if (this.#roomServicesByKey.size >= this.constructor.MAX_ROOMS) {
            throw new UserNotification(`Room limit reached (${this.constructor.MAX_ROOMS}). Join an existing room or try again later.`);
        }
        const service = this.createRoomService(roomName, playerLimit);

        service.onAnyChange = this.#handleRoomChange.bind(this, roomKey, service);
        service.onPlayerIdle = this.#profile.trackIdle ? this.#moveIdlePlayerToView.bind(this, roomKey) : null;

        this.#roomServicesByKey.set(roomKey, service);
        return service;
    }

    /**
     * Broadcasts authoritative room state and enforces the active idle profile.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {RoomService} service - Room that changed.
     */
    #handleRoomChange(roomKey, service) {
        this.#broadcastRoomState(roomKey);

        if (!this.#profile.trackIdle && !service.room.match.nextMatchAvailable) {
            service.stopIdleMonitoring();
        }
    }

    // ---- Request and connection dispatch ----

    /**
     * Validates command input and creates its short-lived resolution context.
     * @param {import("./HostConnection.js").HostConnection} connection - Requesting transport.
     * @param {*} raw - Untrusted command payload.
     * @returns {RequestContext} Validated command and mutable resolution fields.
     */
    #parseRequest(connection, raw) {
        const request = ValidationUtils.object(raw, "Request");
        const command = ValidationUtils.requiredString(request.command, "Command");
        const data = request.data === undefined ? {} : ValidationUtils.object(request.data, "Command data");
        const tabId = command === Constants.COMMANDS.LIST ? null : ValidationUtils.requiredString(data.tabId, "tabId");
        return { connection, command, data, tabId, membership: null, roomKey: null, service: null };
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

        let context = null;
        try {
            context = this.#parseRequest(connection, rawRequest);

            this.#requestThrottle.enforceConnection(connection, context.command, 75);
            switch (context.command) {
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
                    this.#publishActionSuccess(context);
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
                Constants.ACTION_NOTIFICATIONS[`${context?.command?.toUpperCase()}_ERROR`]?.title ?? Constants.AUTO_NOTIFICATIONS.ERROR.title,
                error instanceof UserNotification ? error.message : Constants.AUTO_NOTIFICATIONS.ERROR.message);
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
            const service = this.#roomServicesByKey.get(membership.roomKey) ?? null;
            if (service !== null) {
                await this.#removeMembership(membership, service);
                await this.#continueOrCloseRoom(membership.roomKey);
            } else {
                this.#unregisterMembership(membership.tabId, connection);
            }
        }
    }

    // ---- Room commands ----

    /**
     * Publishes the current Home directory to a connection that is not in a room.
     *
     * @param {RequestContext} context - Validated list command.
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
     * @param {RequestContext} context - Validated create command.
     * @returns {Promise<void>}
     */
    async #create(context) {
        const {connection, tabId} = context;
        const {data} = context;
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");
        const roomKey = Player.normalizeKey(roomName);
        const playerLimit = this.#normalizePlayerLimit(data.playerLimit);

        this.#requestThrottle.enforcePlayerThrottle(tabId, Constants.COMMANDS.CREATE, 500);

        if (this.#connections.has(tabId)) {
            throw new UserNotification("Leave the current room before creating another room.");
        }

        if (this.#roomServicesByKey.has(roomKey)) {
            throw new UserNotification(`Room already exists: ${roomName}`);
        }

        const service = this.#registerRoomService(roomName, playerLimit, roomKey);
        try {
            const player = await service.joinPlayer(playerName, false);
            const botCount = this.#profile.customBots === "fill" ? playerLimit - 1 : 0;

            await this.#addBotPlayers(service, botCount, player.name);
            this.#registerMembership(tabId, connection, roomKey, player.name);
            this.#publishRoomState(connection, service, player.name);
            this.#publishActionSuccess(context);
            this.#broadcastHomeState(this.#createHomeState());
        } catch (error) {
            service.dispose();
            this.#roomServicesByKey.delete(roomKey);
            throw error;
        }
    }

    /**
     * Registers a connection as a viewer and publishes its authoritative room snapshot.
     *
     * @param {RequestContext} context - Validated view command.
     * @returns {Promise<void>}
     */
    async #view(context) {
        this.#requireRoomContext(context, 300);
        const {connection, tabId, roomKey, service} = context;

        if (context.membership !== null && context.membership.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before viewing another room.");
        }

        if (context.membership === null) {
            service.view(tabId);
            this.#registerMembership(tabId, connection, roomKey, null);
        }
        const membership = this.#connections.get(tabId);
        this.#publishRoomState(connection, service, this.#resolveMembershipPlayerName(service, membership));
        this.#publishActionSuccess(context);
    }

    /**
     * @param {RequestContext} context - Validated join command.
     * @returns {Promise<void>}
     */
    async #join(context) {
        this.#requireRoomContext(context, 500);
        const {connection, tabId, roomKey, service} = context;
        const {data} = context;
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");

        if (service.room.hasPlayer(playerName)) {
            throw new UserNotification(`Player already exists: ${playerName}`);
        }

        if (context.membership !== null && context.membership.roomKey !== roomKey) {
            throw new UserNotification("Leave the current room before joining another room.");
        }

        if (context.membership !== null && context.membership.playerName !== null) {
            throw new UserNotification("You already joined this room.");
        }

        const player = await service.joinPlayer(playerName, false, context.membership === null ? null : tabId);

        if (context.membership === null) {
            this.#registerMembership(tabId, connection, roomKey, player.name);
        }

        const currentMembership = this.#connections.get(tabId);

        if (currentMembership !== null && currentMembership.connection === connection && currentMembership.roomKey === roomKey) {
            currentMembership.playerName = player.name;
            this.#publishRoomState(connection, service, player.name);
            this.#publishActionSuccess(context, Constants.ACTION_NOTIFICATIONS.JOIN.message.replace("{playerName}", player.name));
        }
    }

    /**
     * @param {RequestContext} context - Validated leave command.
     * @returns {Promise<void>}
     */
    async #leave(context) {
        this.#requireThrottledClient(context, 300);
        const service = this.#roomServicesByKey.get(context.membership.roomKey) ?? null;

        if (service !== null) {
            await this.#removeMembership(context.membership, service);
            await this.#continueOrCloseRoom(context.membership.roomKey);
        } else {
            this.#unregisterMembership(context.tabId, context.connection);
        }
        this.#publishHomeState(context.connection, this.#createHomeState());
    }

    /**
     * Starts a match for an authenticated player and advances any opening bot turns.
     *
     * @param {RequestContext} context - Validated start command.
     * @returns {Promise<void>}
     */
    async #start(context) {
        this.#requirePlayerRoom(context);
        const knockout = context.data.knockout ?? null;
        const isNextKnockoutMatch = context.service.room.match.nextMatchAvailable;
        this.#requestThrottle.enforcePlayerThrottle(context.tabId, context.command, isNextKnockoutMatch ? 0 : 1000);
        this.#requestThrottle.enforceRoomThrottle(context.roomKey, context.command, isNextKnockoutMatch ? 0 : 500);
        if (context.service.room.match instanceof Knockout && context.service.room.match.isKnockoutComplete) {
            await this.#returnSidelinedBots(context.roomKey);
        }
        await this.#startMatchAndContinue(context.roomKey, context.service, isNextKnockoutMatch ? null : knockout);
    }

    /**
     * @param {RequestContext} context - Validated card command.
     * @returns {Promise<void>}
     */
    async #handleMatchCommand(context) {
        const limits = Host.COMMAND_LIMITS[context.command];
        if (limits === undefined) {
            throw new UserNotification(`Unknown command: ${context.command}`);
        }
        this.#requireThrottledPlayerRoom(context, limits.player, limits.room);
        const result = await context.service.perform(context.command, context.membership.playerName, context.data);
        const notification = StateMapper.toActionMessage(context.command, context.data, result, context.service.room.match.state);
        this.#publishNotification(context.connection, notification.status, notification.title, notification.message);
        await this.#advanceRoom(context.roomKey);
    }

    // ---- Authentication and command validation ----

    /**
     * Authenticates a tab-scoped membership against the requesting transport connection.
     *
     * @param {RequestContext} context - Command being authenticated.
     * @throws {UserNotification} When the requested room or authenticated membership context is unavailable.
     */
    #requireClient(context) {
        context.membership = this.#connections.get(context.tabId);

        if (context.membership === null || context.membership.connection !== context.connection) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }
    }

    /**
     * Authenticates a room membership and applies its tab-scoped command throttle.
     *
     * @param {RequestContext} context - Command being authenticated.
     * @param {number} throttleMs - Player throttle window.
     */
    #requireThrottledClient(context, throttleMs) {
        this.#requireClient(context);
        this.#requestThrottle.enforcePlayerThrottle(context.tabId, context.command, throttleMs);
    }

    /**
     * Resolves the shared context for viewing or joining a room.
     *
     * @param {RequestContext} context - Command being resolved.
     * @param {number} throttleMs - Player throttle window.
     */
    #requireRoomContext(context, throttleMs) {
        const roomName = ValidationUtils.requiredString(context.data.roomName, "Room name");
        context.roomKey = Player.normalizeKey(roomName);
        context.service = this.#requireRoomServiceByKey(context.roomKey);
        context.membership = this.#connections.get(context.tabId);

        this.#requestThrottle.enforcePlayerThrottle(context.tabId, context.command, throttleMs);

        if (context.membership !== null && context.membership.connection !== context.connection) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }
    }

    /**
     * Resolves an authenticated seated player and its current room.
     *
     * @param {RequestContext} context - Command being authenticated.
     * @throws {UserNotification} When the requested room or authenticated membership context is unavailable.
     */
    #requirePlayerRoom(context) {
        this.#requireClient(context);
        if (context.membership.playerName === null) {
            throw new UserNotification("Join the room before making a move.");
        }

        const requestedRoom = context.data.roomName;
        if (requestedRoom !== undefined && Player.normalizeKey(requestedRoom) !== context.membership.roomKey) {
            throw new UserNotification("Your player is not seated in the requested room.");
        }

        const service = this.#requireRoomServiceByKey(context.membership.roomKey);

        if (!service.room.hasPlayer(context.membership.playerName)) {
            throw new UserNotification("Your player connection expired. Rejoin the room.");
        }

        context.roomKey = context.membership.roomKey;
        context.service = service;
    }

    /**
     * Resolves an authenticated player context and applies player- and room-scoped throttles.
     *
     * @param {RequestContext} context - Command being authenticated.
     * @param {number} playerThrottleMs - Player throttle window.
     * @param {number|null} [roomThrottleMs=null] - Optional room throttle window.
     */
    #requireThrottledPlayerRoom(context, playerThrottleMs, roomThrottleMs) {
        this.#requirePlayerRoom(context);

        this.#requestThrottle.enforcePlayerThrottle(context.tabId, context.command, playerThrottleMs);

        if (roomThrottleMs !== null) {
            this.#requestThrottle.enforceRoomThrottle(context.roomKey, context.command, roomThrottleMs);
        }

    }

    /**
     * Returns a registered room or raises an actionable missing-room failure.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {RoomService} Room instance.
     * @throws {UserNotification} When the requested room is unavailable.
     */
    #requireRoomServiceByKey(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;

        if (service === null) {
            throw new UserNotification("Room not found.");
        }

        return service;
    }

    /**
     * Normalizes a requested player limit, falling back to the configured maximum.
     *
     * @param {*} value - Untrusted player-limit value from a command payload.
     * @returns {number} Requested integer player limit or the configured default.
     */
    #normalizePlayerLimit(value) {
        const parsedPlayerLimit = Number(value || Constants.ROOM_PLAYER_LIMIT);

        return Number.isInteger(parsedPlayerLimit) ? parsedPlayerLimit : Constants.ROOM_PLAYER_LIMIT;
    }

    // ---- State and notification publication ----

    /**
     * Publishes a message response.
     * @param {HostConnection|null|undefined} connection - Client connection.
     * @param {string} status - Message status.
     * @param {string} title - Message title.
     * @param {string} message - Message text.
     */
    #publishNotification(connection, status, title, message) {
        connection?.publish(
            StateMapper.toResponse(null, StateMapper.toMessage(status, title, message), null)
        );
    }

    /** Publishes the completed action to its initiating connection. */
    #publishActionSuccess(context, message = null) {
        const action = Constants.ACTION_NOTIFICATIONS[context.command.toUpperCase()];
        this.#publishNotification(context.connection, action.status, action.title, message ?? action.message);
    }

    /**
     * Creates the Home data.
     *
     * @returns {{rooms:Object[]}} Home data.
     */
    #createHomeState() {
        return Object.freeze({
            ...StateMapper.toHomeData(Array.from(this.#roomServicesByKey.values(), function roomModel(service) { return service.room; })),
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
        connection?.publish(StateMapper.toResponse(Constants.VIEWS.HOME, message, homeState));
    }

    /**
     * Broadcasts the current Home data.
     *
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #broadcastHomeState(homeState) {
        for (const connection of this.#connections.homeConnections()) {
            if (connection.isOpen) {
                connection?.publish(StateMapper.toResponse(Constants.VIEWS.HOME, null, homeState));
            } else {
                this.#connections.unsubscribeHome(connection);
            }
        }
    }

    /**
     * Sends active Room state to one membership.
     *
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     * @param {RoomService} service - Room instance.
     * @param {string|null} playerName - Room player name.
     * @param {Object|null} message - Optional notification sent with the state.
     */
    #publishRoomState(connection, service, playerName, message = null) {
        connection?.publish(
            StateMapper.toResponse(
                Constants.VIEWS.ROOM,
                message,
                Object.freeze({
                    ...StateMapper.toRoomData(service.room, playerName),
                    ...this.#getConnectionData(),
                    isBusy: false
                })
            )
        );
    }

    /**
     * Broadcasts current Room state to every connected membership.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #broadcastRoomState(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;

        if (service !== null) {
            for (const membership of this.#connections.inRoom(roomKey)) {
                if (membership.connection.isOpen) {
                    this.#publishRoomState(membership.connection, service, this.#resolveMembershipPlayerName(service, membership));
                }
            }

        }
    }

    /**
     * Resolves a membership's player name against current room membership.
     *
     * @param {RoomService} service - Room instance.
     * @param {import("./ConnectionRegistry.js").RoomMembership} membership - Room membership.
     * @returns {string|null} Valid player name or null.
     */
    #resolveMembershipPlayerName(service, membership) {
        let playerName = null;

        if (membership.playerName !== null && service.room.hasPlayer(membership.playerName)) {
            playerName = membership.playerName;
        }

        return playerName;
    }

    // ---- Membership and empty-room lifecycle ----

    /**
     * Registers a membership with a room.
     *
     * @param {string} tabId - Tab ID.
     * @param {import("./HostConnection.js").HostConnection} connection - Connected transport connection.
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string|null} playerName - Player name.
     */
    #registerMembership(tabId, connection, roomKey, playerName) {
        const existingMembership = this.#connections.get(tabId);

        if (existingMembership !== null && existingMembership.connection !== connection) {
            existingMembership.connection.terminate(1008, "Room replaced");
            void this.#disconnect(existingMembership.connection);
        }

        this.#connections.register(tabId, connection, roomKey, playerName);
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

        this.#requestThrottle.reset(`player:${tabId}`);
        this.#requestThrottle.reset(`connection:${tabId}`);

    }

    /**
     * Removes one occupant without waiting for subsequent automated turns.
     *
     * @param {import("./ConnectionRegistry.js").RoomMembership} membership - Room membership.
     * @param {RoomService} service - Room instance.
     * @returns {Promise<void>}
     */
    async #removeMembership(membership, service) {
        const playerName = membership.playerName;

        this.#unregisterMembership(membership.tabId, membership.connection);

        if (playerName !== null) {
            await service.removePlayer(playerName);
        } else {
            service.leaveViewer(membership.tabId);
        }

    }

    /**
     * Moves an idle player back to viewing state.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string} playerName - Idle player name.
     * @returns {Promise<void>}
     */
    async #moveIdlePlayerToView(roomKey, playerName) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;
        const membership = this.#connections.findPlayer(roomKey, playerName);

        if (service !== null && membership !== null) {
            const removedPlayer = await service.movePlayerToView(playerName, membership.tabId);

            if (removedPlayer !== null) {
                if (this.#connections.isCurrent(membership)) {
                    membership.playerName = null;

                    this.#publishRoomState(
                        membership.connection,
                        service,
                        null,
                        StateMapper.toMessage(
                            Constants.AUTO_NOTIFICATIONS.MOVED_TO_VIEWING.status,
                            Constants.AUTO_NOTIFICATIONS.MOVED_TO_VIEWING.title,
                            Constants.AUTO_NOTIFICATIONS.MOVED_TO_VIEWING.message
                        )
                    );

                    this.#scheduleRoomClosureIfEmpty(roomKey);
                    await this.#advanceRoom(roomKey);
                } else {
                    service.leaveViewer(membership.tabId);
                    await this.#continueOrCloseRoom(roomKey);
                }
            }
        }
    }

    /**
     * Continues the room or closes the room if no players remain.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {Promise<void>}
     */
    async #continueOrCloseRoom(roomKey) {
        await this.#afterRoomAction(roomKey);
        this.#closeRoomIfNoPlayersRemain(roomKey);
        if (!this.#roomServicesByKey.has(roomKey)) return;
        await this.#advanceRoom(roomKey);
    }

    /**
     * Closes a room when no players remain.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #closeRoomIfNoPlayersRemain(roomKey) {
        if (this.#isRoomEmpty(roomKey) && !this.#roomLifecycle.hasPending(roomKey)) {
            this.#closeRoom(roomKey);
        }
    }

    /**
     * Schedules a second empty-room check after the idle-player notification
     * grace period when the room is currently empty.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #scheduleRoomClosureIfEmpty(roomKey) {
        if (this.#isRoomEmpty(roomKey)) {
            this.#roomLifecycle.schedule(roomKey, Constants.ROOM_WAIT_MS, this.#closeRoomIfNoPlayersRemain.bind(this));
        }
    }

    /**
     * Checks whether a registered room currently has no players.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @returns {boolean} True when the room exists and has no players.
     */
    #isRoomEmpty(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;

        return service !== null && service.room.isEmpty();
    }

    /**
     * Closes a room and returns every viewer Home.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #closeRoom(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;

        if (service !== null) {
            this.#roomLifecycle.cancel(roomKey);
            this.#knockoutStarts.cancel(roomKey);
            this.#botReturns.cancel(roomKey);

            const viewingMemberships = this.#connections.inRoom(roomKey);

            service.dispose();
            this.#roomServicesByKey.delete(roomKey);
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
                    StateMapper.toMessage(Constants.AUTO_NOTIFICATIONS.ROOM_CLOSED.status,
                        Constants.AUTO_NOTIFICATIONS.ROOM_CLOSED.title,
                        Constants.AUTO_NOTIFICATIONS.ROOM_CLOSED.message)
                );
            }
        }
    }

    // ---- Automated turns and Knockout transitions ----

    /** Starts one match, processes exclusions, and advances automated play. */
    async #startMatchAndContinue(roomKey, service, knockout = null) {
        const eliminated = await service.startMatch(knockout);
        this.#knockoutStarts.cancel(roomKey);
        await this.#settleEliminatedPlayers(roomKey, eliminated);
        await this.#advanceRoom(roomKey);
    }

    /**
     * Advances automated turns and handles the resulting match transition.
     * @param {string} roomKey - Normalized key of the Room advancing play.
     */
    async #advanceRoom(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;
        if (service === null) return;
        while (!service.isDisposed && service.room.match.state === Constants.ROOM_STATE.ACTIVE) {
            const player = service.room.match.turnOrder.owner;
            if (!(player instanceof BotPlayer)) break;
            const revision = service.revision;
            await this.runAutomatedTurn(service);
            if (service.revision === revision) break;
        }
        await this.#afterRoomAction(roomKey);
    }

    /** Handles the completed Room transition after its result has been published. */
    async #afterRoomAction(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;
        if (service === null || !(service.room.match instanceof Knockout) || service.room.match.state !== Constants.ROOM_STATE.FINISHED || this.#settlingKnockout.has(roomKey)) return;

        this.#settlingKnockout.add(roomKey);
        try {
            if (service.room.match.nextMatchAvailable && !this.#knockoutStarts.hasPending(roomKey)) {
                this.#knockoutStarts.schedule(roomKey, Constants.ROOM_WAIT_MS, this.#startScheduledKnockoutMatch.bind(this));
                service.notifyStateChange();
            } else if (service.room.match.isKnockoutComplete) {
                this.#knockoutStarts.cancel(roomKey);
                if (service.room.match.lostBotNames.length > 0 && !this.#botReturns.hasPending(roomKey)) {
                    this.#botReturns.schedule(roomKey, Constants.TRANSITION_DELAY_SECONDS * 1000, this.#restoreSidelinedBotsWhenDue.bind(this));
                }
                this.#scheduleRoomClosureIfEmpty(roomKey);
            }
        } finally {
            this.#settlingKnockout.delete(roomKey);
        }
    }

    /** Demotes eliminated humans after the current order is pruned. */
    async #settleEliminatedPlayers(roomKey, players) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;
        if (service === null) return;
        for (const player of players) {
            if (player instanceof BotPlayer) continue;
            const membership = this.#connections.findPlayer(roomKey, player.name);
            if (membership !== null && this.#connections.isCurrent(membership)) {
                membership.playerName = null;
                service.view(membership.tabId);
                this.#publishRoomState(membership.connection, service, null,
                    StateMapper.toMessage(Constants.STATUS.INFO, "Knockout result", "You were eliminated from the knockout."));
            }
        }
    }

    /** Starts a waiting Knockout match unless a human already started it. */
    async #startScheduledKnockoutMatch(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;
        if (service === null || !service.room.match.nextMatchAvailable) return;
        try {
            await this.#startMatchAndContinue(roomKey, service);
        } catch (error) {
            if (!(error instanceof UserNotification)) console.error("Scheduled Knockout start failed:", error);
        }
    }

    /** Recreates lost bots by name after the final result is available. */
    async #returnSidelinedBots(roomKey) {
        const service = this.#roomServicesByKey.get(roomKey) ?? null;
        if (service === null || !(service.room.match instanceof Knockout) || !service.room.match.isKnockoutComplete) return;
        this.#botReturns.cancel(roomKey);
        await service.restoreLostBots();
    }

    /** Handles a scheduled bot return without leaving an unobserved rejection. */
    #restoreSidelinedBotsWhenDue(roomKey) {
        void this.#returnSidelinedBots(roomKey).catch(function reportReturnFailure(error) {
            console.error("Sidelined bot return failed:", error);
        });
    }
}
