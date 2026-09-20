"use strict";

/** Browser-facing request and response adapter for Pick 2. */

import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";

/** Explicit UI callbacks used while a Client connection is open. */
export class ClientEvents {
    /**
     * @param {Object} controller - Page controller receiving client events.
     * @param {Function|null} onStatus - Connection-status callback.
     * @param {Function|null} onData - View-data callback.
     */
    constructor(controller, onStatus, onData) {
        this.controller = controller;
        this.onStatus = onStatus;
        this.onData = onData;
        Object.freeze(this);
    }
}

/** Concrete event contract shared by browser endpoints. */
export class EndpointEvents {
    /**
     * @param {Function|null} receive - Raw response callback.
     * @param {Function|null} status - Connection-status callback.
     * @param {Function|null} open - Open callback.
     * @param {Function|null} close - Close callback.
     */
    constructor(receive, status, open, close) {
        this.receive = receive;
        this.status = status;
        this.open = open;
        this.close = close;
        Object.freeze(this);
    }
}

/** Browser-facing API over any endpoint that implements open(). */
export class Client {
    /** @type {string} Card ordering requested for room snapshots. */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /** @type {{open:Function}} Transport endpoint used to create the active connection. */
    #endpoint;

    /** @type {{request:Function,close:Function}|null} Active endpoint connection handle. */
    #connection = null;

    /** @type {Object|null} Page controller receiving connection, data, and notification events. */
    #controller = null;

    /** @type {Function|null} Optional observer for endpoint status changes. */
    #onStatus = null;

    /** @type {Function|null} Optional observer for accepted view snapshots. */
    #onData = null;

    /** @type {string} Session-stable identifier included with every request. */
    #tabId = Client.#getTabId();

    /** @param {{open:Function}} endpoint - Browser or Network endpoint. */
    constructor(endpoint) {
        const source = ValidationUtils.object(endpoint, "Endpoint");

        if (typeof source.open !== "function") {
            throw new Error("Endpoint.open must be a function.");
        }

        this.#endpoint = source;
    }

    /** @returns {string} Current card sort key. */
    get sortKey() {
        return this.#sortKey;
    }

    /** @param {string} value - Card sort key. */
    set sortKey(value) {
        this.#sortKey = ValidationUtils.requiredString(value, "Sort key");
    }

    /**
     * Opens the endpoint and binds its events.
     *
     * @param {ClientEvents} events - Explicit Client callbacks.
     */
    open(events) {
        if (this.#connection !== null) {
            return;
        }

        if (!(events instanceof ClientEvents)) {
            throw new Error("Client.open requires a ClientEvents instance.");
        }

        this.#controller = events.controller;
        this.#onStatus = events.onStatus;
        this.#onData = events.onData;
        this.#connection = this.#endpoint.open(
            new EndpointEvents(
                this.#receive.bind(this),
                this.#handleStatus.bind(this),
                this.#handleOpen.bind(this),
                this.#handleClose.bind(this)
            )
        );
    }

    /** Closes the active endpoint connection. */
    close() {
        const connection = this.#connection;
        this.#connection = null;
        connection?.close();
    }

    /**
     * Sends one canonical Room command request.
     *
     * @param {string} command - Command name from Constants.COMMANDS.
     * @param {Object} data - Command-specific data.
     * @returns {boolean} Whether the endpoint accepted the request.
     */
    request(command, data) {
        const normalizedCommand = ValidationUtils.requiredString(command, "Command");
        const commandData = ValidationUtils.object(data, "Command data");

        return (
            this.#connection?.request({
                command: normalizedCommand,
                data: {
                    ...commandData,
                    sortKey: this.#sortKey,
                    tabId: this.#tabId
                }
            }) ?? false
        );
    }

    /** Forwards a normalized notification to the active page controller. */
    showAlert(message) {
        this.#controller?.handleNotification?.(message);
    }

    /** Forwards endpoint status to the controller and optional status observer. */
    #handleStatus(status, label) {
        this.#controller?.handleConnectionStatus?.(status, label);
        this.#onStatus?.(status, label);
    }

    /** Notifies the page controller that the endpoint can accept requests. */
    #handleOpen() {
        this.#controller?.handleClientOpen?.();
    }

    /** Notifies the page controller that the endpoint connection closed. */
    #handleClose() {
        this.#controller?.handleClientClose?.();
    }

    /** Parses and routes one host response without exposing malformed payloads to controllers. */
    #receive(raw) {
        const response = Client.#parseResponse(raw);

        if (response === null) {
            console.warn("Invalid server response:", raw);
            return;
        }

        if (response.data !== null) {
            this.#controller?.handleData?.(response.view, response.data, response.message);
            this.#onData?.(response.view, response.data);
        }

        if (response.message !== null && response.view !== Constants.VIEWS.HOME) {
            this.#controller?.handleNotification?.(response.message);
        }
    }

    /** @returns {{view:string|null,message:Object|null,data:Object|null}|null} Canonical response, or null when parsing or validation fails. */
    static #parseResponse(raw) {
        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

            if (typeof parsed !== "object" || parsed === null) {
                return null;
            }

            return {
                view:
                    typeof parsed[Constants.RESPONSE_KEYS.VIEW] === "string"
                        ? parsed[Constants.RESPONSE_KEYS.VIEW]
                        : null,
                message:
                    typeof parsed[Constants.RESPONSE_KEYS.MESSAGE] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.MESSAGE] !== null
                        ? parsed[Constants.RESPONSE_KEYS.MESSAGE]
                        : null,
                data:
                    typeof parsed[Constants.RESPONSE_KEYS.DATA] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.DATA] !== null
                        ? parsed[Constants.RESPONSE_KEYS.DATA]
                        : null
            };
        } catch (_error) {
            return null;
        }
    }

    /** @returns {string} Existing session identifier, or a newly generated and persisted identifier. */
    static #getTabId() {
        const storage = globalThis.sessionStorage;
        let tabId = storage?.getItem("game.tabId") ?? "";

        if (!tabId) {
            tabId =
                globalThis.crypto?.randomUUID?.() ??
                `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            storage?.setItem("game.tabId", tabId);
        }

        return tabId;
    }
}
