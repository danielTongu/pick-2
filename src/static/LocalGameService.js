"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { UserNotification } from "../core/UserNotification.js";
import { AlertController } from "../ui/AlertController.js";
import { NotificationUtils } from "../ui/NotificationUtils.js";
import { LocalGameEngine } from "./LocalGameEngine.js";

/**
 * Adapts the local game engine to the existing browser controllers.
 */
export class LocalGameService {
    /** @type {AlertController} */
    #alertController = new AlertController("#alert-dialog");

    /** @type {LocalGameEngine} */
    #engine = new LocalGameEngine();

    /** @type {Object|null} */
    #appController = null;

    /** @type {string} */
    #sortKey = Constants.CARD.SORT_OPTIONS[0];

    /**
     * Creates the local table service and wires state propagation.
     */
    constructor() {
        this.#engine.onStateChange = function (room) {
            this.#appController?.handleRoomSync(room);
        }.bind(this);
    }

    /** @returns {string} Current hand sort key. */
    get sortKey() {
        return this.#sortKey;
    }

    /** @param {string} value - New hand sort key. */
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
     * Creates the initial three-AI waiting table.
     *
     * @returns {Promise<void>}
     */
    async connect() {
        const room = await this.#engine.reset();
        this.#appController?.handleRoomSync(room);
    }

    /**
     * Seats the browser user at the table.
     *
     * @param {string} name - Player display name.
     * @returns {Promise<void>}
     */
    async join(name) {
        try {
            await this.#engine.join(name);
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * Removes the browser user and lets the AI players finish an active game.
     *
     * @returns {Promise<void>}
     */
    async leave() {
        this.#sortKey = Constants.CARD.SORT_OPTIONS[0];

        try {
            await this.#engine.leave();
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * Stops autonomous play while retaining the current table.
     *
     * @returns {Promise<void>}
     */
    async stop() {
        this.#sortKey = Constants.CARD.SORT_OPTIONS[0];

        try {
            await this.#engine.stop();
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * Replaces the current game with a fresh waiting table.
     *
     * @returns {Promise<void>}
     */
    async reset() {
        this.#sortKey = Constants.CARD.SORT_OPTIONS[0];
        const room = await this.#engine.reset();
        this.#appController?.handleRoomSync(room);
    }

    /**
     * Dispatches a game action without blocking DOM event handlers.
     *
     * @param {string} type - Game action.
     * @param {Object} [payload={}] - Action payload.
     * @returns {boolean} True when the action was accepted for processing.
     */
    send(type, payload = {}) {
        if (this.#engine.isBusy || this.#engine.playerName === null) {
            return false;
        }

        void this.#engine.act(type, payload, this.#sortKey).catch(function (error) {
            this.#handleError(error);
        }.bind(this));

        return true;
    }

    /**
     * Shows an alert overlay.
     *
     * @param {*} message - Notification data.
     */
    showAlert(message) {
        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /**
     * Converts action failures into user-facing alerts.
     *
     * @param {*} error - Failure value.
     */
    #handleError(error) {
        console.error(error);
        this.showAlert({
            status: error instanceof UserNotification ? Constants.STATUS.WARNING : Constants.STATUS.ERROR,
            title: error instanceof UserNotification ? "Move not allowed" : "Something went wrong",
            message: error instanceof Error ? error.message : String(error)
        });
    }
}
