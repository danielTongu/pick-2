"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { Player } from "../core/Player.js";
import { AlertController } from "./AlertController.js";
import { DomUtils } from "./DomUtils.js";
import { NotificationUtils } from "./NotificationUtils.js";
import { SessionRowUtils } from "./SessionRowUtils.js";
import { ViewController } from "./ViewController.js";

/** Controls the shared Local/Server game page. */
export class GameController extends ViewController {
    /** @type {Object|null} */
    #game = null;

    /** @type {Object} */
    #capabilities = {};

    /** @type {Function|null} */
    #modeHandler = null;

    /** @type {Function|null} */
    #sessionHandler = null;

    /** @type {AlertController} */
    #alertController = new AlertController("#alert-dialog");

    /** @type {HTMLTableSectionElement} */
    #sessionTableBody;

    /** @type {HTMLInputElement} */
    #playerNameInput;

    /** @type {HTMLInputElement} */
    #sessionNameInput;

    /** @type {HTMLInputElement} */
    #capacityInput;

    /** @type {HTMLFieldSetElement} */
    #connectionStatus;

    /** @type {HTMLInputElement} */
    #localModeInput;

    /** @type {HTMLInputElement} */
    #serverModeInput;

    /** @type {boolean} */
    #isServerAvailable = false;

    /** Creates the shared game controller. */
    constructor() {
        super("#game-view");
        this.#sessionTableBody = DomUtils.require("#session-list-table-body", HTMLTableSectionElement);
        this.#playerNameInput = DomUtils.require("#player-name-input", HTMLInputElement);
        this.#sessionNameInput = DomUtils.require("#session-name-input", HTMLInputElement);
        this.#capacityInput = DomUtils.require("#session-capacity-input", HTMLInputElement);
        this.#connectionStatus = DomUtils.require("#connection-status", HTMLFieldSetElement);
        this.#localModeInput = DomUtils.require("#local-mode-input", HTMLInputElement);
        this.#serverModeInput = DomUtils.require("#server-mode-input", HTMLInputElement);
    }

    /** @param {Object} client - Active game client. */
    setClient(client) {
        this.client = client;
    }

    /** @param {Function} handler - Mode-selection callback. */
    setModeHandler(handler) {
        this.#modeHandler = handler;
    }

    /** @param {Function} handler - Session-navigation callback. */
    setSessionHandler(handler) {
        this.#sessionHandler = handler;
    }

    /** Loads the session template and binds game events. */
    async initialize() {
        await SessionRowUtils.load();

        DomUtils.require("#session-registration-form", HTMLFormElement).addEventListener("submit", (event) => {
            event.preventDefault();
            this.#submitRegistration();
        });
        DomUtils.require("#session-status-filter", HTMLSelectElement).addEventListener("change", () => {
            this.render(this.#game);
        });

        for (const input of [this.#localModeInput, this.#serverModeInput]) {
            input.addEventListener("change", () => {
                if (input.checked) {
                    this.#modeHandler?.(input.value);
                }
            });
        }
    }

    /** @param {boolean} isAvailable - Whether Server play is reachable. */
    setServerAvailable(isAvailable) {
        this.#isServerAvailable = isAvailable;
        this.#serverModeInput.disabled = !isAvailable && !this.#serverModeInput.checked;
        this.#renderConnectionStatus();
    }

    /** @param {string} mode - Active play mode. */
    selectMode(mode) {
        const isServer = mode === "server";
        this.#localModeInput.checked = !isServer;
        this.#serverModeInput.checked = isServer;
        this.#serverModeInput.disabled = !this.#isServerAvailable && !isServer;
        this.#connectionStatus.dataset.status = "connecting";
        this.#sessionTableBody.replaceChildren();
        this.#renderEmptySessionMessage();
        this.#renderConnectionStatus();
    }

    /** Requests the game after the selected transport opens. */
    handleClientOpen() {
        this.client?.send(Constants.ACTIONS.LIST);
    }

    /** Renders a game synchronization response. */
    handleSync(view, game) {
        if (view === Constants.VIEWS.GAME) {
            this.#capabilities = NormalizeUtils.object(game.capabilities ?? {}, "Capabilities");
            this.render(game);
        }
    }

    /** Shows a user notification. */
    handleNotification(message) {
        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /** Updates the shared connection badge. */
    handleConnectionStatus(status) {
        this.#connectionStatus.dataset.status = status;
        this.#renderConnectionStatus();
    }

    /** Stores and renders game state. */
    render(game) {
        this.#game = game;
        this.#sessionTableBody.replaceChildren();
        const filter = DomUtils.require("#session-status-filter", HTMLSelectElement).value;

        for (const session of Array.isArray(game?.sessions) ? game.sessions : []) {
            if (!filter || session.status === filter) {
                const row = SessionRowUtils.create(session);
                row.addEventListener("click", () => this.#openSession(session));
                this.#sessionTableBody.appendChild(row);
            }
        }

        if (this.#sessionTableBody.childElementCount === 0) {
            this.#renderEmptySessionMessage();
        }

        DomUtils.require("#join-mode-input", HTMLInputElement).disabled =
            this.#capabilities.join !== true;
        DomUtils.require("#create-mode-input", HTMLInputElement).disabled =
            this.#capabilities.create !== true;
    }

    /** Renders the empty registry row. */
    #renderEmptySessionMessage() {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 7;
        cell.textContent = "No sessions available.";
        row.className = "empty-session-row";
        row.appendChild(cell);
        this.#sessionTableBody.appendChild(row);
    }

    /** Renders connection state and mode switching on one control. */
    #renderConnectionStatus() {
        const isServer = this.#serverModeInput.checked;
        const modeLabel = isServer ? "Server" : "Local";
        const connectionState = this.#connectionStatus.dataset.status ?? "connecting";
        const statusLabel = {
            connecting: "connecting",
            connected: "connected",
            disconnected: "disconnected",
            error: "connection error"
        }[connectionState] ?? "status unknown";
        const description = `Connection mode. ${modeLabel} ${statusLabel}.`;
        const accessibleDescription = this.#isServerAvailable || isServer
            ? description
            : `${description} Server unavailable.`;

        this.#connectionStatus.setAttribute("aria-label", accessibleDescription);
    }

    /** Submits create or join session intent. */
    #submitRegistration() {
        const playerName = NormalizeUtils.optionalString(
            this.#playerNameInput.value,
            ""
        );
        const sessionName = NormalizeUtils.optionalString(this.#sessionNameInput.value, "");
        const modeInput = document.querySelector("input[name='registration-mode']:checked");
        const registrationMode = modeInput instanceof HTMLInputElement ? modeInput.value : "create";

        if (!playerName || !sessionName) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Missing fields",
                message: "Player and session are required."
            });
            return;
        }

        const isSessionListed = this.#isSessionListed(sessionName);

        if (registrationMode === "join" && !isSessionListed) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Session not found",
                message: `No session named “${sessionName}” is available.`
            });
            return;
        }

        if (registrationMode === "create" && isSessionListed) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Session already exists",
                message: `Choose another name or join “${sessionName}”.`
            });
            return;
        }

        const action = registrationMode === "join"
            ? Constants.ACTIONS.JOIN
            : Constants.ACTIONS.CREATE;
        const payload = {
            sessionName,
            playerName,
            capacity: Number(this.#capacityInput.value || Constants.SESSION_MAX_CAPACITY)
        };

        this.#sessionHandler?.(action, payload);
    }

    /** @returns {boolean} Whether the latest registry contains a session name. */
    #isSessionListed(sessionName) {
        const sessionKey = Player.normalizeKey(sessionName);
        const sessions = Array.isArray(this.#game?.sessions) ? this.#game.sessions : [];

        return sessions.some((session) =>
            typeof session?.name === "string" && Player.normalizeKey(session.name) === sessionKey
        );
    }

    /** Opens a selected Local or Server session. */
    #openSession(session) {
        const sessionName = NormalizeUtils.requiredString(session.name, "Session name");
        this.#sessionHandler?.(Constants.ACTIONS.VIEW, {sessionName});
    }
}
