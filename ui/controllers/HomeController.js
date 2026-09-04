"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { Player } from "../../core/Player.js";
import { AlertController } from "./AlertController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { ViewController } from "./ViewController.js";

/** Controls the shared Local/Network home directory. */
export class HomeController extends ViewController {
    /** @type {Object|null} */
    #home = null;

    /** @type {Object} */
    #capabilities = {};

    /** @type {Function|null} */
    #modeHandler = null;

    /** @type {Function|null} */
    #gameHandler = null;

    /** @type {AlertController} */
    #alertController = new AlertController("#alert-dialog");

    /** @type {HTMLTableSectionElement} */
    #gameTableBody;

    /** @type {HTMLInputElement} */
    #playerNameInput;

    /** @type {HTMLInputElement} */
    #roomNameInput;

    /** @type {HTMLInputElement} */
    #playerLimitInput;

    /** @type {HTMLElement} */
    #connectionStatus;

    /** @type {HTMLInputElement} */
    #localModeInput;

    /** @type {HTMLInputElement} */
    #networkModeInput;

    /** Creates the shared Home controller. */
    constructor() {
        super("#home-view");
        this.#gameTableBody = DomUtils.require("#list-table-body", HTMLTableSectionElement);
        this.#playerNameInput = DomUtils.require("#player-name-input", HTMLInputElement);
        this.#roomNameInput = DomUtils.require("#room-name-input", HTMLInputElement);
        this.#playerLimitInput = DomUtils.require("#player-limit-input", HTMLInputElement);
        this.#connectionStatus = DomUtils.require("#connection-status", HTMLElement);
        this.#localModeInput = DomUtils.require("#local-mode-input", HTMLInputElement);
        this.#networkModeInput = DomUtils.require("#network-mode-input", HTMLInputElement);
    }

    /** @param {import("../../runtime/Client.js").Client} client - Active endpoint client. */
    setClient(client) {
        this.client = client;
    }

    /** @param {Function} handler - Mode-selection callback. */
    setModeHandler(handler) {
        this.#modeHandler = handler;
    }

    /** @param {Function} handler - Room-navigation callback. */
    setGameHandler(handler) {
        this.#gameHandler = handler;
    }

    /** Loads the room-row template and binds Home events. */
    /** Binds Home forms, filters, and mode controls. */
    async initialize() {
        await RoomRowUtils.load();

        DomUtils.require("#registration-form", HTMLFormElement)
            .addEventListener("submit", this.#handleRegistrationSubmit.bind(this));
        DomUtils.require("#status-filter", HTMLSelectElement)
            .addEventListener("change", this.#handleStatusFilterChange.bind(this));

        for (const input of [this.#localModeInput, this.#networkModeInput]) {
            input.addEventListener("change", this.#handleModeChange.bind(this));
        }
    }

    /** Handles room-registration form submission. */
    #handleRegistrationSubmit(event) {
        event.preventDefault();
        this.#submitRegistration();
    }

    /** Reapplies the selected room-status filter. */
    #handleStatusFilterChange() {
        this.render(this.#home);
    }

    /** Switches mode when a mode radio becomes selected. */
    #handleModeChange(event) {
        const input = event.currentTarget;

        if (input instanceof HTMLInputElement && input.checked) {
            this.#modeHandler?.(input.value);
        }
    }

    /** @param {string} mode - Active play mode. */
    /** Selects Local or Network mode and refreshes endpoint capabilities. @param {string} mode */
    selectMode(mode) {
        const isNetwork = mode === "network";
        this.#localModeInput.checked = !isNetwork;
        this.#networkModeInput.checked = isNetwork;
        this.#connectionStatus.dataset.status = "connecting";
        this.#gameTableBody.replaceChildren();
        this.#renderEmptyGameMessage();
        this.#renderConnectionStatus();
    }

    /** Requests the room directory after the selected transport opens. */
    /** Requests the Home directory when the endpoint opens. */
    handleClientOpen() {
        this.client?.request(Constants.ACTIONS.LIST, {});
    }

    /** Renders Home data received from the active endpoint. */
    /** Renders Home data received from the endpoint. @param {string} view @param {Object} home */
    handleData(view, home) {
        if (view === Constants.VIEWS.HOME) {
            this.#capabilities = ValidationUtils.object(home.capabilities, "Capabilities");
            this.render(home);
        }
    }

    /** Shows a user notification. */
    /** Displays a server notification in the shared alert overlay. @param {Object} message */
    handleNotification(message) {
        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /** Updates the shared connection badge. */
    /** Updates connection controls for the current endpoint status. @param {string} status */
    handleConnectionStatus(status) {
        this.#connectionStatus.dataset.status = status;
        this.#renderConnectionStatus();
    }

    /** Stores and renders Home state. */
    /** Renders the current Room directory. @param {Object} home - Home data. */
    render(home) {
        this.#home = home;
        this.#gameTableBody.replaceChildren();
        const filter = DomUtils.require("#status-filter", HTMLSelectElement).value;

        for (const room of Array.isArray(home?.rooms) ? home.rooms : []) {
            if (!filter || room.status === filter) {
                const row = RoomRowUtils.create(room);

                row.tabIndex = 0;
                row.setAttribute("aria-label", `View room ${room.roomName}`);
                row.addEventListener("click", this.#openRoom.bind(this, room));
                row.addEventListener("keydown", this.#handleRoomKeyDown.bind(this, room));
                this.#gameTableBody.appendChild(row);
            }
        }

        if (this.#gameTableBody.childElementCount === 0) {
            this.#renderEmptyGameMessage();
        }

        DomUtils.require("#join-mode-input", HTMLInputElement).disabled =
            this.#capabilities.join !== true;
        DomUtils.require("#create-mode-input", HTMLInputElement).disabled =
            this.#capabilities.create !== true;
    }

    /** Renders the empty registry row. */
    #renderEmptyGameMessage() {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 7;
        cell.textContent = "No rooms available.";
        row.className = "empty-row";
        row.appendChild(cell);
        this.#gameTableBody.appendChild(row);
    }

    /** Renders connection state and mode switching on one control. */
    #renderConnectionStatus() {
        const isNetwork = this.#networkModeInput.checked;
        const modeLabel = isNetwork ? "Network" : "Local";
        const connectionState = this.#connectionStatus.dataset.status ?? "connecting";
        const statusLabel = {
            connecting: "connecting",
            connected: "connected",
            disconnected: "disconnected",
            error: "connection error"
        }[connectionState] ?? "status unknown";
        this.#connectionStatus.setAttribute(
            "aria-label",
            `Connection mode. ${modeLabel} ${statusLabel}.`
        );
    }

    /** Submits create or join room intent. */
    #submitRegistration() {
        const playerName = ValidationUtils.optionalString(
            this.#playerNameInput.value,
            ""
        );
        const roomName = ValidationUtils.optionalString(this.#roomNameInput.value, "");
        const modeInput = document.querySelector("input[name='registration-mode']:checked");
        const registrationMode = modeInput instanceof HTMLInputElement ? modeInput.value : "create";

        if (!playerName || !roomName) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Missing fields",
                message: "Player and room are required."
            });
            return;
        }

        const isGameListed = this.#isGameListed(roomName);

        if (registrationMode === "join" && !isGameListed) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Room not found",
                message: `No room named “${roomName}” is available.`
            });
            return;
        }

        if (registrationMode === "create" && isGameListed) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Room already exists",
                message: `Choose another name or join “${roomName}”.`
            });
            return;
        }

        const action = registrationMode === "join"
            ? Constants.ACTIONS.JOIN
            : Constants.ACTIONS.CREATE;
        const data = {
            roomName,
            playerName,
            playerLimit: Number(this.#playerLimitInput.value || Constants.ROOM_PLAYER_LIMIT)
        };

        this.#gameHandler?.(action, data);
    }

    /** @returns {boolean} Whether the latest directory contains a room name. */
    #isGameListed(roomName) {
        const gameKey = Player.normalizeKey(roomName);
        const games = Array.isArray(this.#home?.rooms) ? this.#home.rooms : [];

        for (const room of games) {
            if (typeof room?.roomName === "string" && Player.normalizeKey(room.roomName) === gameKey) {
                return true;
            }
        }

        return false;
    }

    /** Opens a room from a keyboard-activated directory row. */
    #handleRoomKeyDown(room, event) {
        if (event.key === "Enter") {
            event.preventDefault();
            this.#openRoom(room);
        }
    }

    /** Opens a selected Local or Network room. */
    #openRoom(room) {
        const roomName = ValidationUtils.requiredString(room.roomName, "Room name");
        this.#gameHandler?.(Constants.ACTIONS.VIEW, {roomName});
    }
}
