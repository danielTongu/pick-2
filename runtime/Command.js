"use strict";

import { ValidationUtils } from "../core/ValidationUtils.js";

/** Validated command request received by Host. */
export class HostRequest {
    /**
     * @param {string} command - Canonical command name.
     * @param {Object} data - Command payload.
     */
    constructor(command, data) {
        this.command = command;
        this.data = data;
        Object.freeze(this);
    }

    /**
     * @param {*} raw - Untrusted endpoint request.
     * @returns {HostRequest} Validated request.
     */
    static parse(raw) {
        const request = ValidationUtils.object(raw, "Request");
        const command = ValidationUtils.requiredString(request.command, "Command");
        const data = request.data === undefined ? {} : ValidationUtils.object(request.data, "Command data");

        return new HostRequest(command, data);
    }
}



/** Shared, progressively resolved state for one Host command. */
export class CommandContext {
    /**
     * @param {import("./Session.js").PeerSession} peer - Requesting peer.
     * @param {HostRequest} request - Validated request.
     */
    constructor(peer, request) {
        this.peer = peer;
        this.request = request;
        this.tabId = null;
        this.session = null;
        this.roomKey = null;
        this.room = null;
    }

    /**
     * @returns {string} Canonical command name.
     */
    get command() {
        return this.request.command;
    }

    /**
     * @returns {Object} Canonical command payload.
     */
    get data() {
        return this.request.data;
    }

    /**
     * @returns {CommandContext} This resolved context.
     */
    identifyTab() {
        this.tabId = ValidationUtils.requiredString(this.data.tabId, "tabId");
        return this;
    }

    /**
     * @param {import("./Session.js").RoomSession|null} session - Current room session.
     * @returns {CommandContext} This context.
     */
    attachSession(session) {
        this.session = session;
        return this;
    }

    /**
     * @param {string} roomKey - Normalized room key.
     * @param {import("../core/Room.js").Room} room - Room model.
     * @returns {CommandContext} This context.
     */
    attachRoom(roomKey, room) {
        this.roomKey = roomKey;
        this.room = room;
        return this;
    }

    /**
     * @returns {string|null} Authenticated seated-player name.
     */
    get playerName() {
        return this.session?.playerName ?? null;
    }
}



/** Dispatches Host commands without exposing the handler table to request processing. */
export class CommandRouter {
    /**
     * @param {Object<string, function(CommandContext): Promise<void>>} handlers - Built-in handlers.
     * @param {function(CommandContext): Promise<void>} fallback - Game-command handler.
     */
    constructor(handlers, fallback) {
        this.handlers = Object.freeze({ ...handlers });
        this.fallback = fallback;
        Object.freeze(this);
    }

    /**
     * @param {import("./Host.js").Host} receiver - Owning Host.
     * @param {CommandContext} context - Resolved command.
     * @returns {Promise<void>}
     */
    async dispatch(receiver, context) {
        const handler = this.handlers[context.command] ?? this.fallback;
        await handler.call(receiver, context);
    }
}
