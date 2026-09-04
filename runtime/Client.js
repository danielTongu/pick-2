"use strict";

/** Browser-facing request and response adapter shared by both play modes. */

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
    #endpoint;
    #connection = null;
    #controller = null;
    #onStatus = null;
    #onData = null;
    #tabId = Client.#getTabId();
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /** @param {{open:Function}} endpoint - Browser or Network endpoint. */
    constructor(endpoint) {
        const source = ValidationUtils.object(endpoint, "Endpoint");

        if (typeof source.open !== "function") {
            throw new Error("Endpoint.open must be a function.");
        }

        this.#endpoint = source;
    }

    /** @returns {string} Current hand sort key. */
    get sortKey() {
        return this.#sortKey;
    }

    /** @param {string} value - New hand sort key. */
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
        this.#connection = this.#endpoint.open(new EndpointEvents(
            this.#receive.bind(this),
            this.#handleStatus.bind(this),
            this.#handleOpen.bind(this),
            this.#handleClose.bind(this)
        ));
    }

    /** Closes the active endpoint connection. */
    close() {
        const connection = this.#connection;
        this.#connection = null;
        connection?.close();
    }

    /**
     * Sends one canonical Room action request.
     *
     * @param {string} action - Action name from Constants.ACTIONS.
     * @param {Object} data - Action-specific data.
     * @returns {boolean} Whether the endpoint accepted the request.
     */
    request(action, data) {
        const normalizedAction = ValidationUtils.requiredString(action, "Action");
        const actionData = ValidationUtils.object(data, "Action data");

        return this.#connection?.request({
            action: normalizedAction,
            data: {
                ...actionData,
                tabId: this.#tabId,
                sortKey: this.#sortKey
            }
        }) ?? false;
    }

    /** Shows a notification through the active page controller. */
    showAlert(message) {
        this.#controller?.handleNotification?.(message);
    }

    #handleStatus(status, label) {
        this.#controller?.handleConnectionStatus?.(status, label);
        this.#onStatus?.(status, label);
    }

    #handleOpen() {
        this.#controller?.handleClientOpen?.();
    }

    #handleClose() {
        this.#controller?.handleClientClose?.();
    }

    /** Routes one structured host response. */
    #receive(raw) {
        const response = Client.#parseResponse(raw);

        if (response === null) {
            console.warn("Invalid server response:", raw);
            return;
        }

        if (response.data !== null) {
            this.#controller?.handleData?.(response.view, response.data);
            this.#onData?.(response.view, response.data);
        }

        if (response.message !== null) {
            this.#controller?.handleNotification?.(response.message);
        }
    }

    /** @returns {{view:string|null,message:Object|null,data:Object|null}|null} */
    static #parseResponse(raw) {
        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

            if (typeof parsed !== "object" || parsed === null) {
                return null;
            }

            return {
                view: typeof parsed[Constants.RESPONSE_KEYS.VIEW] === "string"
                    ? parsed[Constants.RESPONSE_KEYS.VIEW]
                    : null,
                message: typeof parsed[Constants.RESPONSE_KEYS.MESSAGE] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.MESSAGE] !== null
                    ? parsed[Constants.RESPONSE_KEYS.MESSAGE]
                    : null,
                data: typeof parsed[Constants.RESPONSE_KEYS.DATA] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.DATA] !== null
                    ? parsed[Constants.RESPONSE_KEYS.DATA]
                    : null
            };
        } catch (_error) {
            return null;
        }
    }

    /** @returns {string} Stable browser-tab identifier. */
    static #getTabId() {
        const storage = globalThis.sessionStorage;
        let tabId = storage?.getItem("pick2.tabId") ?? "";

        if (!tabId) {
            tabId = globalThis.crypto?.randomUUID?.() ??
                `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            storage?.setItem("pick2.tabId", tabId);
        }

        return tabId;
    }
}
