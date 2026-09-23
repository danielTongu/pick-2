"use strict";

/** Browser-facing request and response adapter for Pick 2. */

import { Constants } from "../core/Constants.js";
import { ValidationUtils } from "../core/ValidationUtils.js";
import { Endpoint, EndpointEvents, Connection } from "./Transport.js";

/** Explicit UI callbacks used while a Client connection is open. */
export class ClientEvents {
    /**
     * @param {import("../ui/controllers/ViewController.js").ViewController} controller - Page controller receiving events.
     * @param {(function(string, string): void)|null} onStatus - Connection-status callback.
     * @param {(function(string|null, Object): void)|null} onData - View-data callback.
     */
    constructor(controller, onStatus, onData) {
        this.controller = controller;
        this.onStatus = onStatus;
        this.onData = onData;
        Object.freeze(this);
    }
}



/** Browser-facing API over any endpoint that implements open(). */
export class Client {
    /**
     * @type {string} Card ordering requested for room snapshots.
     */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /**
     * @type {Endpoint} Transport endpoint used to create the active connection.
     */
    #endpoint;

    /**
     * @type {Connection|null} Active endpoint connection handle.
     */
    #connection = null;

    /**
     * @type {import("../ui/controllers/ViewController.js").ViewController|null} Active page controller.
     */
    #controller = null;

    /**
     * @type {(function(string, string): void)|null} Optional endpoint-status observer.
     */
    #onStatus = null;

    /**
     * @type {(function(string|null, Object): void)|null} Optional view-data observer.
     */
    #onData = null;

    /**
     * @type {string} Session-stable identifier included with every request.
     */
    #tabId = Client.#getTabId();

    /**
     * @param {Endpoint} endpoint - Direct or WebSocket endpoint.
     */
    constructor(endpoint) {
        const source = ValidationUtils.object(endpoint, "Endpoint");

        if (typeof source.open !== "function") {
            throw new Error("Endpoint.open must be a function.");
        }

        this.#endpoint = source;
    }

    /**
     * @returns {string} Current card sort key.
     */
    get sortKey() {
        return this.#sortKey;
    }

    /**
     * @param {string} value - Card sort key.
     */
    set sortKey(value) {
        const sortKey = ValidationUtils.requiredString(value, "Sort key");
        if (!Constants.CARD.SORT_OPTIONS.includes(sortKey)) {
            throw new Error(`Invalid card sort key: ${sortKey}`);
        }
        this.#sortKey = sortKey;
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

    /**
     * @param {string} status - Connection status.
     * @param {string} label - Display label.
     */
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

    /**
     * @param {Object|string} raw - Raw endpoint response.
     */
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

    /**
     * @param {Object|string} raw - Raw endpoint response.
     * @returns {{view:string|null,message:Object|null,data:Object|null}|null} Canonical response, or null.
     */
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

    /**
     * @returns {string} Existing session identifier, or a newly generated and persisted identifier.
     */
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
