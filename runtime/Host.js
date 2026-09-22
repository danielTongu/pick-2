"use strict";

/** Transport-neutral room orchestrator shared by every runtime. */

import { UserNotification } from "../core/UserNotification.js";

import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";
import { Actor } from "../core/Actor.js";
import { CommandContext, CommandRouter, HostRequest } from "./Command.js";
import { PeerChannel } from "./Transport.js";
import { RateLimit } from "./RateLimit.js";
import { RoomLifecycle } from "./RoomLifecycle.js";
import { HostPeer, PeerSession, RoomSession, SessionRegistry } from "./Session.js";

/**
 * Transport-neutral host for the selected game.
 *
 * Host owns room registration, peers, viewers, notifications, and lifecycle
 * orchestration; each Room owns players and round rules.
 */
export class Host {
    /**
     * @type {import("../core/Game.js").Game} Game contract supplying rules and mapping.
     */
    #game;
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

    /**
     * @type {SessionRegistry} Connected peers and authenticated room sessions.
     */
    #sessions = new SessionRegistry();

    /**
     * @type {RateLimit} Shared command throttle across all connected peers and rooms.
     */
    #rateLimit = new RateLimit();

    /**
     * @type {{mode:string, capabilities:Object, customBots:string|number, trackIdle:boolean}} Runtime profile.
     */
    #profile;

    /**
     * @type {Promise<void>} Initialization barrier for default rooms and bot players.
     */
    #ready;

    /**
     * @type {CommandRouter} Runtime and game-command dispatcher.
     */
    #commandRouter;

    /**
     * Creates a room Host.
     *
     * @param {string} mode - Runtime mode.
     * @param {string|number} customBots - Custom-Room bot policy.
     * @param {boolean} trackIdle - Whether to monitor idle Players.
     * @param {import("../core/Game.js").Game} game - Room factory, state mapper, commands, and automation.
     */
    constructor(mode, customBots, trackIdle, game) {
        this.#game = game;
        this.#profile = Host.#normalizeProfile(mode, customBots, trackIdle);
        this.#commandRouter = new CommandRouter(
            {
                [Constants.COMMANDS.LIST]: this.#list,
                [Constants.COMMANDS.CREATE]: this.#create,
                [Constants.COMMANDS.VIEW]: this.#view,
                [Constants.COMMANDS.JOIN]: this.#join,
                [Constants.COMMANDS.LEAVE]: this.#leave,
                [Constants.COMMANDS.START]: this.#start
            },
            this.#handleGameCommand
        );
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
     * @param {Room} room - Room whose Players should no longer be monitored.
     */
    static #stopIdleMonitoring(room) {
        for (const player of room.actors.values()) {
            player.stopIdleMonitoring();
        }
    }

    /**
     * Accepts one transport-neutral peer channel.
     *
     * @param {PeerChannel} channel - Environment channel.
     * @returns {HostPeer} Connected peer API.
     */
    accept(channel) {
        if (!(channel instanceof PeerChannel)) {
            throw new Error("Host.accept requires a PeerChannel instance.");
        }

        const peer = this.#sessions.createPeer(channel);

        this.#registerHomePeer(peer);
        void this.#ready.then(this.#publishCurrentHomeState.bind(this, peer));

        return new HostPeer(this.#receive.bind(this, peer), this.#disconnect.bind(this, peer));
    }

    // -------------------------------------------------------------------------
    // Room registry and state publication
    // -------------------------------------------------------------------------

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

    /** Creates configured Rooms and their initial bot players. */
    async #initializeRooms() {
        for (const roomConfig of this.#game.constants.DEFAULT_ROOMS) {
            const roomKey = this.#normalizeRoomKey(roomConfig.roomName);
            const room = this.#registerRoom(roomConfig.roomName, roomConfig.playerLimit, roomKey);

            await this.#addBotActors(room, roomConfig.botCount, null);
        }
    }

    /**
     * Adds a fixed number of bot players through the shared Room admission API.
     *
     * @param {Room} room - Room receiving the Bots.
     * @param {number} count - Maximum number of Bots to add.
     * @param {string|null} humanName - Human name that Bot names must not duplicate.
     */
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
        return room;
    }

    /**
     * Broadcasts authoritative room state and enforces the active idle profile.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {Room} room - Room that changed.
     */
    #handleRoomChange(roomKey, room) {
        this.#broadcastRoomState(roomKey);

        if (!this.#profile.trackIdle) {
            Host.#stopIdleMonitoring(room);
        }
    }

    /**
     * Moves an idle actor to viewing state through the serialized Host lifecycle.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string} actorName - Idle Actor name.
     */
    #handlePlayerIdle(roomKey, actorName) {
        void this.#moveIdlePlayerToView(roomKey, actorName);
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
     * Broadcasts current Room state to every connected session.
     *
     * @param {string} roomKey - Normalized room lookup key.
     */
    #broadcastRoomState(roomKey) {
        const room = this.#roomsByKey.get(roomKey) ?? null;

        if (room !== null) {
            for (const session of this.#sessions.inRoom(roomKey)) {
                if (session.peer.isOpen) {
                    this.#publishRoomState(session.peer, room, this.#resolveSessionPlayerName(room, session));
                }
            }

        }
    }

    /**
     * Resolves a session's player name against current room membership.
     *
     * @param {Room} room - Room instance.
     * @param {RoomSession} session - Room session.
     * @returns {string|null} Valid player name or null.
     */
    #resolveSessionPlayerName(room, session) {
        let playerName = null;

        if (session.playerName !== null && room.hasActor(session.playerName)) {
            playerName = session.playerName;
        }

        return playerName;
    }

    /**
     * Sends active Room state to one session.
     *
     * @param {PeerSession} peer - Connected transport peer.
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
     * @param {PeerSession} peer - Connected transport peer.
     */
    #registerHomePeer(peer) {
        this.#sessions.subscribeHome(peer);
    }

    /**
     * Removes a peer from Home tracking.
     *
     * @param {PeerSession} peer - Connected transport peer.
     */
    #unregisterHomePeer(peer) {
        this.#sessions.unsubscribeHome(peer);
    }

    /**
     * Broadcasts the current Home data.
     *
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #broadcastHomeState(homeState) {
        for (const peer of this.#sessions.homePeers()) {
            if (peer.isOpen) {
                this.#publishViewState(peer, Constants.VIEWS.HOME, homeState);
            } else {
                this.#sessions.unsubscribeHome(peer);
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

    /**
     * @returns {Object} Shared mode metadata.
     */
    #getModeData() {
        return Object.freeze({
            mode: this.#profile.mode,
            capabilities: this.#profile.capabilities
        });
    }

    /**
     * Sends a normal transition to Home.
     *
     * @param {PeerSession} peer - Connected transport peer.
     * @param {{rooms:Object[]}} homeState - Home data.
     */
    #publishHomeState(peer, homeState) {
        this.#registerHomePeer(peer);
        this.#publishViewState(peer, Constants.VIEWS.HOME, homeState);
    }

    /**
     * @param {PeerSession} peer - Peer receiving the latest Home directory snapshot.
     */
    #publishCurrentHomeState(peer) {
        this.#publishHomeState(peer, this.#createHomeState());
    }

    /**
     * Sends a forced room-exit notification and Home state.
     *
     * @param {PeerSession} peer - Connected transport peer.
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
    // Room sessions and membership transitions
    // -------------------------------------------------------------------------

    /**
     * Registers a session with a room.
     *
     * @param {string} tabId - Tab ID.
     * @param {PeerSession} peer - Connected transport peer.
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string|null} playerName - Player name.
     * @returns {RoomSession} Registered room session.
     */
    #registerSession(tabId, peer, roomKey, playerName) {
        const existingClient = this.#sessions.get(tabId);

        if (existingClient !== null && existingClient.peer !== peer) {
            existingClient.peer.terminate(1008, "Room replaced");
            void this.#disconnect(existingClient.peer);
        }

        return this.#sessions.register(tabId, peer, roomKey, playerName);
    }

    /**
     * Unregisters a session from a room.
     *
     * This does not mutate Room membership or move the socket to the room.
     *
     * @param {string} tabId - Tab ID.
     * @param {PeerSession} peer - Connected transport peer.
     */
    #unregisterSession(tabId, peer) {
        this.#sessions.unregister(tabId, peer);

        this.#rateLimit.reset(`player:${tabId}`);
        this.#rateLimit.reset(`connection:${tabId}`);

    }

    /**
     * Finds a room session by player name.
     *
     * @param {string} roomKey - Normalized room lookup key.
     * @param {string} playerName - Display name of the seated actor.
     * @returns {RoomSession|null} Matching session.
     */
    #findSessionByPlayer(roomKey, playerName) {
        return this.#sessions.findPlayer(roomKey, playerName);
    }

    /**
     * Finds a room session by peer.
     *
     * @param {PeerSession} peer - Connected transport peer.
     * @returns {RoomSession|null} Matching session.
     */
    #findSessionByPeer(peer) {
        return this.#sessions.findPeer(peer);
    }

    /**
     * Checks whether a captured room session is still current.
     *
     * @param {RoomSession} session - Captured session.
     * @returns {boolean} True when still current.
     */
    #isCurrentSession(session) {
        return this.#sessions.isCurrent(session);
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
        const session = this.#findSessionByPlayer(roomKey, playerName);

        if (room !== null && session !== null) {
            const removedPlayer = await room.moveActorToView(playerName, session.tabId);

            if (removedPlayer !== null) {
                if (this.#isCurrentSession(session)) {
                    session.view();

                    this.#publishRoomState(
                        session.peer,
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
                    room.leaveViewer(session.tabId);
                    await this.#continueOrCloseRoom(roomKey);
                }
            }
        }
    }

    /**
     * Removes one occupant without waiting for subsequent automated turns.
     *
     * @param {RoomSession} session - Room session.
     * @param {Room} room - Room instance.
     * @returns {Promise<string>} Removed occupant's room key.
     */
    async #removeSession(session, room) {
        const roomKey = session.roomKey;
        const playerName = session.playerName;

        this.#unregisterSession(session.tabId, session.peer);

        if (playerName !== null) {
            await room.removeActor(playerName);
        } else {
            room.leaveViewer(session.tabId);
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

        if (this.#isRoomEmpty(roomKey) && !this.#roomLifecycle.hasPending(roomKey)) {
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
            this.#roomLifecycle.schedule(roomKey, Constants.MAX_IDLE_MS, this.#closeRoomAfterIdle.bind(this));
        }
    }

    /**
     * @param {string} roomKey - Normalized key of the Room scheduled for closure.
     */
    #closeRoomAfterIdle(roomKey) {
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
        this.#roomLifecycle.cancel(roomKey);
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

            const viewingSessions = this.#sessions.inRoom(roomKey);

            this.#clearRoomCallbacks(room);
            this.#roomsByKey.delete(roomKey);
            this.#rateLimit.reset(`room:${roomKey}`);

            for (const session of viewingSessions) {
                this.#unregisterSession(session.tabId, session.peer);
            }

            const homeState = this.#createHomeState();

            this.#broadcastHomeState(homeState);

            for (const session of viewingSessions) {
                this.#publishInvoluntaryHomeState(
                    session.peer,
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

    /**
     * Processes one request from a connected peer.
     *
     * @param {PeerSession} peer - Peer that sent the request.
     * @param {Object|string|null} rawRequest - Untrusted request payload.
     */
    async #receive(peer, rawRequest) {
        await this.#ready;

        if (!peer.isOpen) {
            return;
        }

        try {
            const request = HostRequest.parse(rawRequest);
            const context = new CommandContext(peer, request);

            this.#rateLimit.enforceConnection(peer, context.command, 75);
            await this.#routeCommand(context);
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
     * @param {CommandContext} context - Validated command context.
     * @returns {Promise<void>}
     */
    async #routeCommand(context) {
        await this.#commandRouter.dispatch(this, context);
    }

    /**
     * Handles a disconnected peer.
     *
     * Room sessions are silently removed.
     *
     * @param {PeerSession} peer - Connected transport peer.
     * @returns {Promise<void>}
     */
    async #disconnect(peer) {
        if (!peer.isOpen) {
            return;
        }

        peer.markClosed();
        this.#unregisterHomePeer(peer);

        const session = this.#findSessionByPeer(peer);

        if (session !== null) {
            const room = this.#roomsByKey.get(session.roomKey) ?? null;
            if (room !== null) {
                await this.#removeSession(session, room);
                await this.#continueOrCloseRoom(session.roomKey);
            } else {
                this.#unregisterSession(session.tabId, peer);
            }
        }
    }

    /**
     * Publishes one structured response.
     *
     * @param {PeerSession|null|undefined} peer - Client peer.
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
     * @param {PeerSession|null|undefined} peer - Client peer.
     * @param {string|null} view - View name.
     * @param {Object|null} data - View data.
     */
    #publishViewState(peer, view, data) {
        this.#publish(peer, this.#game.stateMapper.toResponse(view, null, data));
    }

    /**
     * Publishes an error response.
     *
     * @param {PeerSession|null|undefined} peer - Client peer.
     * @param {string} message - Error message.
     */
    #publishError(peer, message) {
        this.#publishNotification(peer, Constants.STATUS.ERROR, Constants.NOTIFICATIONS.ERROR_TITLE, message);
    }

    /**
     * Publishes a message response.
     *
     * @param {PeerSession|null|undefined} peer - Client peer.
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
     * @param {PeerSession} peer - Viewer peer.
     */
    #publishViewerWelcome(peer) {
        const welcome = Constants.NOTIFICATIONS.VIEWER_WELCOME;
        this.#publishNotification(peer, Constants.STATUS.INFO, welcome.title, welcome.message);
    }

    /**
     * Welcomes a newly joined player and identifies their play area.
     *
     * @param {PeerSession} peer - Player peer.
     * @param {string} playerName - Joined player name.
     */
    #publishPlayerWelcome(peer, playerName) {
        const welcome = Constants.NOTIFICATIONS.PLAYER_WELCOME;
        this.#publishNotification(peer, Constants.STATUS.INFO, `${welcome.title}, ${playerName}!`, this.#game.welcomeMessage);
    }

    // -------------------------------------------------------------------------
    // Command handlers and their shared requirements
    // -------------------------------------------------------------------------

    /**
     * Publishes the current Home directory to a peer that is not in a room.
     *
     * @param {CommandContext} context - Validated list command.
     * @returns {Promise<void>}
     */
    async #list(context) {
        if (this.#findSessionByPeer(context.peer) !== null) {
            throw new UserNotification("Leave the current room before returning Home.");
        }

        this.#registerHomePeer(context.peer);
        this.#publishViewState(context.peer, Constants.VIEWS.HOME, this.#createHomeState());
    }

    /**
     * Creates, optionally fills, joins, and publishes a custom room.
     *
     * @param {CommandContext} context - Validated create command.
     * @returns {Promise<void>}
     */
    async #create(context) {
        context.identifyTab();
        const { data, peer, tabId } = context;
        const roomName = ValidationUtils.requiredString(data.roomName, "Room name");
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");
        const roomKey = this.#normalizeRoomKey(roomName);
        const playerLimit = this.#normalizePlayerLimit(data.playerLimit);

        this.#rateLimit.enforcePlayerThrottle(tabId, Constants.COMMANDS.CREATE, 500);

        if (this.#sessions.has(tabId)) {
            throw new UserNotification("Leave the current room before creating another room.");
        }

        if (this.#roomsByKey.has(roomKey)) {
            throw new UserNotification(`Room already exists: ${roomName}`);
        }

        const room = this.#registerRoom(roomName, playerLimit, roomKey);
        try {
            const player = await room.joinActor(playerName, false);
            const botCount = this.#profile.customBots === "fill" ? playerLimit - 1 : 0;

            await this.#addBotActors(room, botCount, player.name);
            this.#registerSession(tabId, peer, roomKey, player.name);
            this.#publishRoomState(peer, room, player.name);
            this.#publishPlayerWelcome(peer, player.name);
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
    #normalizePlayerLimit(value) {
        const parsedPlayerLimit = Number(value || this.#game.constants.ROOM_PLAYER_LIMIT);

        return Number.isInteger(parsedPlayerLimit) ? parsedPlayerLimit : this.#game.constants.ROOM_PLAYER_LIMIT;
    }

    /**
     * Registers a peer as a viewer and publishes its authoritative room snapshot.
     *
     * @param {CommandContext} context - Validated view command.
     * @returns {Promise<void>}
     */
    async #view(context) {
        this.#requireRoomContext(context, 300);
        const { peer, tabId, roomKey, room, session } = context;

        if (session !== null && !session.belongsTo(roomKey)) {
            throw new UserNotification("Leave the current room before viewing another room.");
        }

        if (session === null) {
            room.view(tabId);
            this.#registerSession(tabId, peer, roomKey, null);
            this.#publishRoomState(peer, room, null);
            this.#publishViewerWelcome(peer);
        } else {
            this.#publishRoomState(context.peer, room, this.#resolveSessionPlayerName(room, session));
        }
    }

    /**
     * @param {CommandContext} context - Validated join command.
     * @returns {Promise<void>}
     */
    async #join(context) {
        this.#requireRoomContext(context, 500);
        const { data, peer, tabId, roomKey, room, session } = context;
        const playerName = ValidationUtils.requiredString(data.playerName, "Player name");

        this.#assertPlayerNameAvailable(room, playerName);

        if (session !== null && !session.belongsTo(roomKey)) {
            throw new UserNotification("Leave the current room before joining another room.");
        }

        if (session?.isPlayer()) {
            throw new UserNotification("You already joined this room.");
        }

        const player = await room.joinActor(playerName, false, session === null ? null : tabId);

        if (session === null) {
            this.#registerSession(tabId, peer, roomKey, player.name);
        } else {
            session.join(player.name);
        }

        const currentClient = this.#sessions.get(tabId);

        if (currentClient !== null && currentClient.peer === peer && currentClient.belongsTo(roomKey)) {
            currentClient.join(player.name);
            this.#publishRoomState(peer, room, player.name);
            this.#publishPlayerWelcome(peer, player.name);
        }
    }

    /**
     * Resolves the shared context for viewing or joining a room.
     *
     * @param {CommandContext} context - Command being resolved.
     * @param {number} throttleMs - Player throttle window.
     * @returns {CommandContext} Resolved room context.
     */
    #requireRoomContext(context, throttleMs) {
        context.identifyTab();
        this.#requireDataRoom(context);
        const session = this.#sessions.get(context.tabId);
        context.attachSession(session);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, context.command, throttleMs);

        if (session !== null && session.peer !== context.peer) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }

        return context;
    }

    /**
     * Normalizes command room identity and resolves the registered room.
     *
     * @param {CommandContext} context - Command being resolved.
     * @returns {CommandContext} Resolved room context.
     */
    #requireDataRoom(context) {
        const roomName = ValidationUtils.requiredString(context.data.roomName, "Room name");
        const roomKey = this.#normalizeRoomKey(roomName);

        return context.attachRoom(roomKey, this.#requireRoomByKey(roomKey));
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

    /**
     * @param {CommandContext} context - Validated leave command.
     * @returns {Promise<void>}
     */
    async #leave(context) {
        this.#requireThrottledClient(context, 300);
        const room = this.#roomsByKey.get(context.session.roomKey) ?? null;

        if (room !== null) {
            const roomKey = await this.#removeSession(context.session, room);
            await this.#continueOrCloseRoom(roomKey);

            this.#publishCurrentHomeState(context.peer);
        } else {
            this.#unregisterSession(context.tabId, context.peer);
            this.#publishCurrentHomeState(context.peer);
        }
    }

    /**
     * Authenticates a tab-scoped session against the requesting transport peer.
     *
     * @param {CommandContext} context - Command being authenticated.
     * @returns {CommandContext} Authenticated context.
     * @throws {UserNotification} When the requested room or authenticated session context is unavailable.
     */
    #requireClient(context) {
        context.identifyTab();
        const session = this.#sessions.get(context.tabId);

        if (session === null || session.peer !== context.peer) {
            throw new UserNotification("Your connection expired. Rejoin the room.");
        }

        return context.attachSession(session);
    }

    /**
     * Authenticates a room session and applies its tab-scoped command throttle.
     *
     * @param {CommandContext} context - Command being authenticated.
     * @param {number} throttleMs - Player throttle window.
     * @returns {CommandContext} Throttled context.
     */
    #requireThrottledClient(context, throttleMs) {
        this.#requireClient(context);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, context.command, throttleMs);

        return context;
    }

    /**
     * Resolves an authenticated seated actor and its current room.
     *
     * @param {CommandContext} context - Command being authenticated.
     * @returns {CommandContext} Authenticated player-room context.
     * @throws {UserNotification} When the requested room or authenticated session context is unavailable.
     */
    #requirePlayerRoom(context) {
        this.#requireClient(context);
        const session = context.session;

        if (!session.isPlayer()) {
            throw new UserNotification("Join the room before making a move.");
        }

        const room = this.#requireRoomByKey(session.roomKey);

        if (!room.hasActor(session.playerName)) {
            throw new UserNotification("Your player connection expired. Rejoin the room.");
        }

        return context.attachRoom(session.roomKey, room);
    }

    /**
     * Resolves an authenticated actor context and applies actor- and room-scoped throttles.
     *
     * @param {CommandContext} context - Command being authenticated.
     * @param {number} playerThrottleMs - Player throttle window.
     * @param {number|null} [roomThrottleMs=null] - Optional room throttle window.
     * @returns {CommandContext} Throttled player-room context.
     */
    #requireThrottledPlayerRoom(context, playerThrottleMs, roomThrottleMs) {
        this.#requirePlayerRoom(context);

        this.#rateLimit.enforcePlayerThrottle(context.tabId, context.command, playerThrottleMs);

        if (roomThrottleMs !== null) {
            this.#rateLimit.enforceRoomThrottle(context.roomKey, context.command, roomThrottleMs);
        }

        return context;
    }

    /**
     * Starts a round for an authenticated actor and advances any opening bot turns.
     *
     * @param {CommandContext} context - Validated start command.
     * @returns {Promise<void>}
     */
    async #start(context) {
        this.#requireThrottledPlayerRoom(context, 1000, 500);

        await context.room.startRound();
        await this.#runAutomatedTurn(context.roomKey);
    }

    /**
     * @param {CommandContext} context - Validated game command.
     * @returns {Promise<void>}
     */
    async #handleGameCommand(context) {
        const limits = this.#game.commands[context.command];
        if (limits === undefined) {
            throw new UserNotification(`Unknown command: ${context.command}`);
        }
        this.#requireThrottledPlayerRoom(context, limits.player, limits.room);
        const notification = await this.#game.execute(
            context.room,
            context.playerName,
            context.command,
            context.data
        );
        if (notification !== null) {
            this.#publishNotification(context.peer, notification.status, notification.title, notification.message);
        }
        await this.#continueAutomatedTurn(context.roomKey);
    }

    /**
     * @param {string} roomKey - Normalized key of the Room advancing automated play.
     */
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

        this.#roomLifecycle.clear();

        for (const room of this.#roomsByKey.values()) {
            this.#clearRoomCallbacks(room);
            Host.#stopIdleMonitoring(room);
        }

        for (const peer of this.#sessions.homePeers()) {
            peer.markClosed();
            peer.terminate(1001, "Host stopped");
        }

        for (const session of this.#sessions.allRoomSessions()) {
            if (session.peer.isOpen) {
                session.peer.markClosed();
                session.peer.terminate(1001, "Host stopped");
            }
        }

        this.#roomsByKey.clear();
        this.#sessions.clear();
        this.#rateLimit.resetAll();
    }
}
