
"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { AlertController } from "../ui/AlertController.js";
import { DomUtils } from "../ui/DomUtils.js";
import { NotificationUtils } from "../ui/NotificationUtils.js";

/**
 * Browser-tab service that owns websocket session state and server communication.
 */
export class ConnectionService {
    /** @type {AlertController} */
    #alertController = new AlertController("#alert-dialog");

    /** @type {string} */
    #tabId = ConnectionService.#getOrCreateTabId();

    /** @type {WebSocket|null} */
    #webSocket = null;

    /** @type {Object|null} */
    #appController = null;

    /** @type {number|null} */
    #reconnectTimeoutId = null;

    /** @type {number} */
    #reconnectAttempts = 0;

    /** @type {number} */
    #maxReconnectAttempts = 5;

    /** @type {string} */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /** @type {HTMLElement} */
    #connectionStatus;

    /** @type {HTMLElement} */
    #connectionLabel;

    /**
     * Creates a connection service.
     *
     * @throws {Error}
     */
    constructor() {
        this.#connectionStatus = DomUtils.require("#connection-status", HTMLElement);
        this.#connectionLabel = DomUtils.require("#connection-status-label", HTMLElement);
    }

    /**
     * Gets the active card sort key.
     *
     * @returns {string} Sort key.
     */
    get sortKey() {
        return this.#sortKey;
    }

    /**
     * Sets the active card sort key.
     *
     * @param {string} value - Sort key.
     */
    set sortKey(value) {
        this.#sortKey = NormalizeUtils.requiredString(value, "Sort key");
    }

    /**
     * Attaches the application controller.
     *
     * @param {Object} appController - Application controller.
     */
    setAppController(appController) {
        this.#appController = appController;
    }

    /**
     * Opens a websocket connection.
     */
    connect() {
        this.#reconnectAttempts = 0;
        this.#openConnection();
    }

    /**
     * Sends an action to the server.
     *
     * @param {string} type - Action type.
     * @param {Object} payload - Action payload.
     * @returns {boolean} True when sent.
     */
    send(type, payload = {}) {
        const actionType = NormalizeUtils.requiredString(type, "Action type");
        const actionPayload = NormalizeUtils.object(payload, "Action payload");
        const canSend = this.#webSocket instanceof WebSocket && this.#webSocket.readyState === WebSocket.OPEN;

        if (canSend) {
            this.#webSocket.send(JSON.stringify({
                type: actionType,
                payload: {
                    ...actionPayload,
                    tabId: this.#tabId,
                    sortKey: this.#sortKey
                }
            }));
        }

        return canSend;
    }

    /**
     * Shows alert overlay.
     *
     * @param {*} message - Message payload.
     */
    showAlert(message) {
        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /**
     * Opens the raw websocket and binds lifecycle events.
     */
    #openConnection() {
        this.#renderConnectionStatus(Constants.STATUS.CONNECTING, "Connecting...");

        this.#webSocket = new WebSocket(ConnectionService.#getWebSocketUrl());

        this.#webSocket.addEventListener("open", this.#handleWebSocketOpen.bind(this));
        this.#webSocket.addEventListener("message", this.#handleWebSocketMessage.bind(this));
        this.#webSocket.addEventListener("close", this.#handleWebSocketClose.bind(this));
        this.#webSocket.addEventListener("error", this.#handleWebSocketError.bind(this));
    }

    /**
     * Handles websocket open event.
     */
    #handleWebSocketOpen() {
        this.#cancelReconnect();
        this.#reconnectAttempts = 0;
        this.#renderConnectionStatus(Constants.STATUS.CONNECTED, "Connected");

        if (this.#appController !== null && typeof this.#appController.handleClientOpen === "function") {
            this.#appController.handleClientOpen();
        }
    }

    /**
     * Handles websocket message event.
     *
     * @param {MessageEvent} event - Websocket message event.
     */
    #handleWebSocketMessage(event) {
        const response = ConnectionService.#parseResponse(event.data);

        if (response !== null) {
            this.#handleResponse(response);
        } else {
            console.warn("Invalid websocket response:", event.data);
        }
    }

    /**
     * Handles websocket close event.
     */
    #handleWebSocketClose() {
        this.#renderConnectionStatus(Constants.STATUS.DISCONNECTED, "Disconnected");
        this.#scheduleReconnect();
    }

    /**
     * Handles websocket error event.
     */
    #handleWebSocketError() {
        this.#renderConnectionStatus(Constants.STATUS.ERROR, "Error");
        this.#closeWebSocketConnection();
    }

    /**
     * Handles a parsed server response.
     *
     * @param {{view:string|null,message:Object|null,sync:Object|null}} response - Server response.
     */
    #handleResponse(response) {
        if (response.sync !== null && this.#appController !== null && typeof this.#appController.handleSync === "function") {
            this.#appController.handleSync(response.view, response.sync);
        }

        if (response.message !== null) {
            this.showAlert(response.message);
        }
    }

    /**
     * Schedules websocket reconnect.
     */
    #scheduleReconnect() {
        if (this.#reconnectAttempts < this.#maxReconnectAttempts) {
            if (this.#reconnectTimeoutId === null) {
                const delay = Math.min(
                    1000 * Math.pow(2, this.#reconnectAttempts),
                    30000
                );

                this.#reconnectAttempts += 1;

                this.#reconnectTimeoutId = window.setTimeout(function () {
                    this.#reconnectTimeoutId = null;
                    this.#openConnection();
                }.bind(this), delay);
            }
        } else {
            this.#renderConnectionStatus(Constants.STATUS.ERROR, "Connection Failed");
        }
    }

    /**
     * Cancels pending reconnect.
     */
    #cancelReconnect() {
        if (this.#reconnectTimeoutId !== null) {
            window.clearTimeout(this.#reconnectTimeoutId);
            this.#reconnectTimeoutId = null;
        }
    }

    /**
     * Closes websocket safely.
     */
    #closeWebSocketConnection() {
        if (this.#webSocket instanceof WebSocket) {
            try {
                this.#webSocket.close();
            } catch (_error) {}
        }
    }

    /**
     * Updates connection status elements.
     *
     * @param {string} status - Connection status.
     * @param {string} text - Label text.
     */
    #renderConnectionStatus(status, text) {
        this.#connectionStatus.dataset.status = NormalizeUtils.requiredString(status, "Connection status");
        this.#connectionLabel.textContent = NormalizeUtils.requiredString(text, "Connection status text");
    }

    /**
     * Builds websocket URL from current location.
     *
     * @returns {string} Websocket URL.
     */
    static #getWebSocketUrl() {
        const protocol = location.protocol === "https:" ? "wss" : "ws";

        return `${protocol}://${location.host}`;
    }

    /**
     * Parses a raw server response.
     *
     * @param {*} raw - Raw websocket payload.
     * @returns {{view:string|null,message:Object|null,sync:Object|null}|null} Parsed response.
     */
    static #parseResponse(raw) {
        let response = null;

        try {
            const parsed = JSON.parse(raw);

            if (typeof parsed === "object" && parsed !== null) {
                response = {
                    view: typeof parsed[Constants.RESPONSE_KEYS.VIEW] === "string"
                        ? parsed[Constants.RESPONSE_KEYS.VIEW]
                        : null,

                    message: typeof parsed[Constants.RESPONSE_KEYS.MESSAGE] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.MESSAGE] !== null
                        ? parsed[Constants.RESPONSE_KEYS.MESSAGE]
                        : null,

                    sync: typeof parsed[Constants.RESPONSE_KEYS.SYNC] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.SYNC] !== null
                        ? parsed[Constants.RESPONSE_KEYS.SYNC]
                        : null
                };
            }
        } catch (_error) {
            response = null;
        }

        return response;
    }

    /**
     * Gets or creates stable browser-tab id.
     *
     * @returns {string} Browser-tab id.
     */
    static #getOrCreateTabId() {
        let tabId = sessionStorage.getItem("tabId");

        if (!tabId) {
            if (crypto.randomUUID) {
                tabId = crypto.randomUUID();
            } else {
                tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            }

            sessionStorage.setItem("tabId", tabId);
        }

        return tabId;
    }
}
