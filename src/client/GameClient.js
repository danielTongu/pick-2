"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";

/**
 * Browser-facing game API shared by Local and Network play.
 */
export class GameClient {
    /** @type {import("./Transport.js").Transport} */
    #transport;

    /** @type {Object|null} */
    #controller = null;

    /** @type {Function|null} */
    #statusHandler = null;

    /** @type {Function|null} */
    #syncHandler = null;

    /** @type {string} */
    #tabId = GameClient.#getTabId();

    /** @type {string} */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /**
     * @param {import("./Transport.js").Transport} transport - Local or WebSocket transport.
     */
    constructor(transport) {
        this.#transport = transport;
        this.#transport.onOpen = () => this.#controller?.handleClientOpen?.();
        this.#transport.onMessage = (raw) => this.#handleMessage(raw);
        this.#transport.onClose = () => this.#controller?.handleClientClose?.();
        this.#transport.onStatus = (status, label) => {
            this.#controller?.handleConnectionStatus?.(status, label);
            this.#statusHandler?.(status, label);
        };
    }

    /** @returns {string} Current hand sort key. */
    get sortKey() {
        return this.#sortKey;
    }

    /** @param {string} value - New hand sort key. */
    set sortKey(value) {
        this.#sortKey = NormalizeUtils.requiredString(value, "Sort key");
    }

    /** @param {Object} controller - Page controller. */
    setController(controller) {
        this.#controller = NormalizeUtils.object(controller, "Controller");
    }

    /** @param {Function} handler - Transport-status callback. */
    setStatusHandler(handler) {
        this.#statusHandler = handler;
    }

    /** @param {Function} handler - Successful synchronization callback. */
    setSyncHandler(handler) {
        this.#syncHandler = handler;
    }

    /** Opens the selected transport. */
    connect() {
        this.#transport.connect();
    }

    /** Closes the selected transport. */
    close() {
        this.#transport.close();
    }

    /**
     * Sends one canonical game action.
     *
     * @param {string} type - Action type.
     * @param {Object} [payload={}] - Action payload.
     * @returns {boolean} Whether the transport accepted the action.
     */
    send(type, payload = {}) {
        const actionType = NormalizeUtils.requiredString(type, "Action type");
        const actionPayload = NormalizeUtils.object(payload, "Action payload");

        return this.#transport.send({
            type: actionType,
            payload: {
                ...actionPayload,
                tabId: this.#tabId,
                sortKey: this.#sortKey
            }
        });
    }

    /**
     * Shows a notification through the active page controller.
     *
     * @param {*} message - Notification payload.
     */
    showAlert(message) {
        this.#controller?.handleNotification?.(message);
    }

    /** Parses and routes one transport response. */
    #handleMessage(raw) {
        const response = GameClient.#parseResponse(raw);

        if (response === null) {
            console.warn("Invalid game response:", raw);
            return;
        }

        if (response.sync !== null) {
            this.#controller?.handleSync?.(response.view, response.sync);
            this.#syncHandler?.(response.view, response.sync);
        }

        if (response.message !== null) {
            this.#controller?.handleNotification?.(response.message);
        }
    }

    /**
     * @param {*} raw - Object or serialized response.
     * @returns {{view:string|null,message:Object|null,sync:Object|null}|null} Parsed response.
     */
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
                sync: typeof parsed[Constants.RESPONSE_KEYS.SYNC] === "object" &&
                    parsed[Constants.RESPONSE_KEYS.SYNC] !== null
                    ? parsed[Constants.RESPONSE_KEYS.SYNC]
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
