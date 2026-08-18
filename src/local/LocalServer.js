"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { AIPlayer, Player } from "../core/Player.js";
import { Session } from "../core/Session.js";
import { StateMapper } from "../core/StateMapper.js";
import { UserNotification } from "../core/UserNotification.js";

/**
 * Implements the game server protocol entirely inside one browser tab.
 */
export class LocalServer {
    static #STORAGE_KEY = "pick2.localSessions";

    /** @type {Map<string,Object>} */
    #memorySessions = new Map();

    /** @type {Session|null} */
    #session = null;

    /** @type {string|null} */
    #playerName = null;

    /** @type {string|null} */
    #viewerId = null;

    /** @type {boolean} */
    #ownsRegistryEntry = false;

    /** @type {boolean} */
    #isBusy = false;

    /** @type {number} */
    #operationId = 0;

    /** @type {Function|null} */
    #responseHandler = null;

    /** @param {Function|null} handler - Response callback. */
    set onResponse(handler) {
        this.#responseHandler = typeof handler === "function" ? handler : null;
    }

    /**
     * Handles one canonical client request.
     *
     * @param {{type:string,payload:Object}} request - Action request.
     * @returns {Promise<void>}
     */
    async handle(request) {
        try {
            const source = NormalizeUtils.object(request, "Request");
            const type = NormalizeUtils.requiredString(source.type, "Action type");
            const payload = NormalizeUtils.object(source.payload ?? {}, "Action payload");

            if (type === Constants.ACTIONS.LIST) {
                this.#list();
            } else if (type === Constants.ACTIONS.CREATE) {
                await this.#create(payload);
            } else if (type === Constants.ACTIONS.VIEW) {
                await this.#view(payload);
            } else if (type === Constants.ACTIONS.JOIN) {
                await this.#join(payload);
            } else if (type === Constants.ACTIONS.LEAVE) {
                this.#leave();
            } else {
                await this.#act(type, payload);
            }
        } catch (error) {
            this.#sendError(error);
        }
    }

    /** Stops active work and releases the current session. */
    disconnect() {
        this.#operationId += 1;
        this.#isBusy = false;

        if (this.#session !== null) {
            if (this.#ownsRegistryEntry) {
                this.#deleteSession(this.#session.name);
            }

            this.#session.onAnyChange = null;
            this.#stopIdleMonitoring(this.#session);
        }

        this.#session = null;
        this.#playerName = null;
        this.#viewerId = null;
        this.#ownsRegistryEntry = false;
    }

    /** Sends the local session registry. */
    #list() {
        if (this.#session !== null) {
            throw new UserNotification("Exit the current session before viewing the game.");
        }

        this.#send(Constants.VIEWS.GAME, null, this.#createGameSync());
    }

    /**
     * Creates a local session, joins the human, and fills remaining seats with AI.
     *
     * @param {Object} payload - Create-session payload.
     */
    async #create(payload) {
        if (this.#session !== null) {
            throw new UserNotification("Exit the current session before creating another session.");
        }

        const sessionName = NormalizeUtils.requiredString(payload.sessionName, "Session name");
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");
        const capacity = Number(payload.capacity || Constants.SESSION_MAX_CAPACITY);
        const sessionKey = Player.normalizeKey(sessionName);
        const registry = this.#readSessions();

        if (registry.has(sessionKey)) {
            throw new UserNotification(`Session already exists: ${sessionName}`);
        }

        await this.#openSession(sessionName, playerName, capacity, true);
        this.#saveSession({
            name: sessionName,
            playerName,
            capacity,
            createdAt: Date.now(),
            lastActiveAt: Date.now()
        });
        this.#sendWelcome(playerName);
    }

    /** Joins a saved local session or the currently viewed session. */
    async #join(payload) {
        const sessionName = NormalizeUtils.requiredString(payload.sessionName, "Session name");
        const playerName = NormalizeUtils.requiredString(payload.playerName, "Player name");

        if (this.#session !== null) {
            const isSameSession = Player.normalizeKey(this.#session.name) === Player.normalizeKey(sessionName);

            if (this.#viewerId === null || !isSameSession) {
                throw new UserNotification("Leave the current session before joining another session.");
            }

            const player = await this.#session.join(playerName, false, this.#viewerId);
            this.#playerName = player.name;
            this.#viewerId = null;
            await this.#fillAiSeats(this.#session, player.name, this.#session.capacity);
            this.#stopIdleMonitoring(this.#session);
            this.#sendSessionSync();
            this.#sendWelcome(player.name);
            return;
        }

        const savedSession = this.#readSessions().get(Player.normalizeKey(sessionName));

        if (savedSession === undefined) {
            throw new UserNotification("Session not found.");
        }

        await this.#openSession(savedSession.name, playerName, savedSession.capacity);

        if (savedSession.isDefault !== true) {
            this.#saveSession({
                ...savedSession,
                lastActiveAt: Date.now()
            });
        }

        this.#sendWelcome(playerName);
    }

    /** Views a listed session without joining as a player. */
    async #view(payload) {
        if (this.#session !== null) {
            throw new UserNotification("Leave the current session before viewing another session.");
        }

        const sessionName = NormalizeUtils.requiredString(payload.sessionName, "Session name");
        const viewerId = NormalizeUtils.requiredString(payload.tabId, "tabId");
        const savedSession = this.#readSessions().get(Player.normalizeKey(sessionName));

        if (savedSession === undefined) {
            throw new UserNotification("Session not found.");
        }

        const session = new Session(savedSession.name, savedSession.capacity);
        const aiCount = savedSession.isDefault === true
            ? savedSession.aiCount
            : Math.max(0, savedSession.capacity - 1);
        await this.#fillAiSeats(session, null, aiCount);
        session.view(viewerId);
        this.#activateSession(session, null, viewerId, false);
    }

    /**
     * Builds the active local session.
     *
     * @param {string} sessionName - Session name.
     * @param {string} playerName - Human player name.
     * @param {number} capacity - Total seats.
     */
    async #openSession(sessionName, playerName, capacity, ownsRegistryEntry = false) {
        const session = new Session(sessionName, capacity);
        const human = await session.join(playerName, false);
        await this.#fillAiSeats(session, human.name, session.capacity);
        this.#activateSession(session, human.name, null, ownsRegistryEntry);
    }

    /** Activates one local session. */
    #activateSession(session, playerName, viewerId, ownsRegistryEntry) {
        this.#session = session;
        this.#playerName = playerName;
        this.#viewerId = viewerId;
        this.#ownsRegistryEntry = ownsRegistryEntry;
        this.#isBusy = false;
        this.#operationId += 1;
        session.onAnyChange = () => this.#sendSessionSync();
        this.#stopIdleMonitoring(session);
        this.#sendSessionSync();
    }

    /** Fills a session to the requested player count with uniquely named AI. */
    async #fillAiSeats(session, humanName, targetCount) {
        let index = 0;

        while (session.circle.players.size < targetCount) {
            const aiName = LocalServer.#getAiName(index, humanName);
            index += 1;

            if (!session.isPlayerPresent(aiName)) {
                await session.join(aiName, true);
            }
        }
    }

    /**
     * Returns a unique, familiar AI player name.
     *
     * @param {number} index - AI seat index.
     * @param {string} humanName - Human player name.
     * @returns {string} AI name.
     */
    static #getAiName(index, humanName) {
        const baseName = Constants.LOCAL_OPPONENT_NAMES[index] ?? `AI ${index + 1}`;

        return humanName !== null && Player.normalizeKey(baseName) === Player.normalizeKey(humanName)
            ? `${baseName} Bot`
            : baseName;
    }

    /** Leaves the current session and returns a game sync. */
    #leave() {
        if (this.#session === null) {
            throw new UserNotification("No session is open.");
        }

        const session = this.#session;
        this.#operationId += 1;
        session.onAnyChange = null;
        this.#stopIdleMonitoring(session);
        if (this.#ownsRegistryEntry) {
            this.#deleteSession(session.name);
        }

        this.#session = null;
        this.#playerName = null;
        this.#viewerId = null;
        this.#ownsRegistryEntry = false;
        this.#isBusy = false;
        this.#send(Constants.VIEWS.GAME, null, this.#createGameSync());
    }

    /**
     * Applies a game action and resolves subsequent AI turns.
     *
     * @param {string} type - Action type.
     * @param {Object} payload - Action payload.
     */
    async #act(type, payload) {
        const session = this.#requireSession();

        if (this.#isBusy) {
            throw new UserNotification("Please wait for the current turn to finish.");
        }

        const operationId = ++this.#operationId;
        this.#isBusy = true;
        this.#sendSessionSync();

        try {
            if (type === Constants.ACTIONS.START) {
                await session.start();
            } else if (type === Constants.ACTIONS.DRAW) {
                const cards = await session.drawCards(this.#playerName, payload.sortKey);
                this.#sendDrawNotification(cards.length);
            } else if (type === Constants.ACTIONS.PASS) {
                await session.passTurn(this.#playerName, payload.sortKey);
            } else if (type === Constants.ACTIONS.DISCARD) {
                const card = NormalizeUtils.object(payload.card, "Card");
                const cards = await session.discardCard(
                    this.#playerName,
                    card.value,
                    card.suit,
                    payload.sortKey
                );
                this.#sendDrawNotification(cards.length);
            } else if (type === Constants.ACTIONS.DECLARE) {
                await session.declareSuit(payload.suit);
            } else {
                throw new Error(`Unknown action: ${type}`);
            }

            await this.#runAiTurns(session, operationId);
        } finally {
            if (this.#session === session && this.#operationId === operationId) {
                this.#isBusy = false;
                this.#stopIdleMonitoring(session);
                this.#sendSessionSync();
            }
        }
    }

    /** Resolves AI turns until control returns to the human. */
    async #runAiTurns(session, operationId) {
        let actionCount = 0;

        while (this.#session === session && this.#operationId === operationId && session.isActive()) {
            const player = session.circle.getTurnOwner();

            if (!(player instanceof AIPlayer)) {
                break;
            }

            actionCount += 1;

            if (actionCount > 250) {
                throw new Error("The AI turn limit was exceeded.");
            }

            this.#sendSessionSync();

            if (session.status === Constants.STATUS.PENDING) {
                await player.chooseSuit(session);
            } else {
                await player.takeTurn(session);
            }
        }
    }

    /** @returns {Session} Active session. */
    #requireSession() {
        if (this.#session === null || this.#playerName === null) {
            throw new UserNotification("Join a session before playing.");
        }

        return this.#session;
    }

    /** Sends the current session snapshot. */
    #sendSessionSync() {
        if (this.#session === null) {
            return;
        }

        this.#send(Constants.VIEWS.SESSION, null, Object.freeze({
            ...StateMapper.toSessionPayload(this.#session, this.#playerName),
            ...LocalServer.#getModeData(),
            isBusy: this.#isBusy
        }));
    }

    /** @returns {Object} Local game snapshot. */
    #createGameSync() {
        const sessions = Array.from(this.#readSessions().values()).map((session) => Object.freeze({
            name: session.name,
            status: Constants.STATUS.WAITING,
            playerCount: session.playerCount ?? session.capacity,
            viewerCount: 0,
            capacity: session.capacity,
            lastActiveAt: LocalServer.#formatDate(session.lastActiveAt),
            createdAt: LocalServer.#formatDate(session.createdAt)
        }));

        return Object.freeze({
            ...LocalServer.#getModeData(),
            sessions
        });
    }

    /** @returns {Object} Shared local-mode metadata. */
    static #getModeData() {
        return Object.freeze({
            mode: "local",
            capabilities: Object.freeze({
                create: true,
                join: true,
                view: true,
                invite: false,
                aiFill: true,
                restart: true
            })
        });
    }

    /** Sends a welcome notification. */
    #sendWelcome(playerName) {
        this.#send(null, StateMapper.toMessage(
            Constants.STATUS.INFO,
            "Session Ready",
            `${playerName}, your AI opponents are ready.`
        ), null);
    }

    /** Sends a draw notification when cards were drawn. */
    #sendDrawNotification(count) {
        if (count > 0) {
            this.#send(null, StateMapper.toMessage(
                Constants.STATUS.INFO,
                "Cards Drawn",
                `+${count}`
            ), null);
        }
    }

    /** Converts failures to the canonical notification response. */
    #sendError(error) {
        const isUserError = error instanceof UserNotification;
        const message = error instanceof Error ? error.message : String(error);

        if (!isUserError) {
            console.error(error);
        }

        this.#send(null, StateMapper.toMessage(
            isUserError ? Constants.STATUS.WARNING : Constants.STATUS.ERROR,
            isUserError ? "Move not allowed" : "Something went wrong",
            message
        ), null);
    }

    /** Emits one canonical response. */
    #send(view, message, sync) {
        this.#responseHandler?.(StateMapper.toResponse(view, message, sync));
    }

    /** Stops server-era idle monitoring in the local game. */
    #stopIdleMonitoring(session) {
        for (const player of session.circle.players.values()) {
            player.stopIdleMonitoring();
        }
    }

    /** Reads saved local session configurations. */
    #readSessions() {
        const sessions = this.#readStoredSessions();

        for (const session of Constants.DEFAULT_SESSIONS) {
            sessions.set(Player.normalizeKey(session.name), {
                ...session,
                isDefault: true,
                playerCount: session.aiCount,
                createdAt: "",
                lastActiveAt: ""
            });
        }

        return sessions;
    }

    /** Reads user-created local session configurations. */
    #readStoredSessions() {
        const storage = globalThis.localStorage;

        if (storage === undefined) {
            return new Map(this.#memorySessions);
        }

        try {
            const sessions = JSON.parse(storage.getItem(LocalServer.#STORAGE_KEY) ?? "[]");
            const result = new Map();

            if (Array.isArray(sessions)) {
                for (const session of sessions) {
                    if (typeof session?.name === "string") {
                        result.set(Player.normalizeKey(session.name), session);
                    }
                }
            }

            return result;
        } catch (_error) {
            return new Map();
        }
    }

    /** Saves one local session configuration. */
    #saveSession(session) {
        const sessions = this.#readStoredSessions();
        sessions.set(Player.normalizeKey(session.name), session);
        this.#writeStoredSessions(sessions);
    }

    /** Removes a local session when its player leaves. */
    #deleteSession(sessionName) {
        const sessions = this.#readStoredSessions();
        sessions.delete(Player.normalizeKey(sessionName));
        this.#writeStoredSessions(sessions);
    }

    /** Writes user-created local session configurations. */
    #writeStoredSessions(sessions) {
        this.#memorySessions = sessions;

        try {
            if (sessions.size === 0) {
                globalThis.localStorage?.removeItem(LocalServer.#STORAGE_KEY);
            } else {
                globalThis.localStorage?.setItem(
                    LocalServer.#STORAGE_KEY,
                    JSON.stringify(Array.from(sessions.values()))
                );
            }
        } catch (_error) {}
    }

    /** @returns {string} Display date or empty string. */
    static #formatDate(value) {
        if (value === "" || value === null || value === undefined) {
            return "";
        }

        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }
}
