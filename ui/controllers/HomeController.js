"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { Actor } from "../../core/Actor.js";
import { AlertController } from "./AlertController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { ViewController } from "./ViewController.js";
import { Card } from "../../core/Card.js";
import { PlayingCard } from "../PlayingCard.js";

/** Orders preview cards by Pick2 score. */
function compareCardScores(left, right) {
    return left.score - right.score;
}

/** Creates one static preview card. */
function createFanCard(card) {
    const element = PlayingCard.create(card);
    element.rotation = null;
    return element;
}

/** Renders the Pick2 Home preview fan. */
function renderSpecialCardFan() {
    const fan = document.querySelector("[data-game-preview]");
    if (!(fan instanceof HTMLElement)) return;

    const { SUIT, VALUE } = Constants.CARD;
    const cards = [
        new Card(VALUE.TWO.id, SUIT.CLUBS, 0),
        new Card(VALUE.EIGHT.id, SUIT.DIAMONDS, 0),
        new Card(VALUE.JACK.id, SUIT.SPADES, 0),
        new Card(VALUE.ACE.id, SUIT.HEARTS, 0),
        new Card(VALUE.SEVEN.id, SUIT.HEARTS, 0),
        new Card(VALUE.JOKER.id, SUIT.BLACK, 0),
        new Card(VALUE.ACE.id, SUIT.SPADES, 0)
    ].sort(compareCardScores);

    fan.replaceChildren(...cards.map(createFanCard));
}

/** Controls the shared Direct/Hosted home directory. */
export class HomeController extends ViewController {
    /** @type {Object|null} Latest authoritative transport snapshot. */
    #home = null;

    /** @type {Object} Current immutable UI capability or state record. */
    #capabilities = {};

    /** @type {Function|null} Optional application callback registered by the owning page. */
    #modeHandler = null;

    /** @type {Function|null} Optional application callback registered by the owning page. */
    #gameHandler = null;

    /** @type {AlertController} Notification dialog owned by this page controller. */
    #alertController = new AlertController("#alert-dialog");

    /** @type {HTMLTableSectionElement} Required table body replaced from authoritative state. */
    #gameTableBody;

    /** @type {HTMLInputElement} Required user-input control owned by this controller. */
    #playerNameInput;

    /** @type {HTMLInputElement} Required user-input control owned by this controller. */
    #roomNameInput;

    /** @type {HTMLInputElement} Required user-input control owned by this controller. */
    #playerLimitInput;

    /** @type {HTMLElement} Required UI element owned by this controller. */
    #connectionStatus;

    /** @type {HTMLInputElement} Required user-input control owned by this controller. */
    #directModeInput;

    /** @type {HTMLInputElement} Required user-input control owned by this controller. */
    #hostedModeInput;

    /** Creates the shared Home controller. */
    constructor() {
        super("#home-view");
        this.#gameTableBody = DomUtils.require("#list-table-body", HTMLTableSectionElement);
        this.#playerNameInput = DomUtils.require("#player-name-input", HTMLInputElement);
        this.#roomNameInput = DomUtils.require("#room-name-input", HTMLInputElement);
        this.#playerLimitInput = DomUtils.require("#player-limit-input", HTMLInputElement);
        this.#connectionStatus = DomUtils.require("#app-header > aside[data-status]", HTMLElement);
        this.#directModeInput = DomUtils.require("#direct-mode-input", HTMLInputElement);
        this.#hostedModeInput = DomUtils.require("#hosted-mode-input", HTMLInputElement);
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
        renderSpecialCardFan();
        await RoomRowUtils.load();

        DomUtils.require("#registration-form", HTMLFormElement).addEventListener(
            "submit",
            this.#handleRegistrationSubmit.bind(this)
        );
        DomUtils.require("#status-filter", HTMLSelectElement).addEventListener(
            "change",
            this.#handleStatusFilterChange.bind(this)
        );

        for (const input of [this.#directModeInput, this.#hostedModeInput]) {
            input.addEventListener("change", this.#handleModeChange.bind(this));
        }
    }

    /** Validates the registration form and submits the selected create, join, or view intent. */
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
    /** Selects Direct or Hosted mode and refreshes endpoint capabilities. @param {string} mode */
    selectMode(mode) {
        const isHosted = mode === "hosted";
        this.#directModeInput.checked = !isHosted;
        this.#hostedModeInput.checked = isHosted;
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
            if (!filter || room.state === filter) {
                const row = RoomRowUtils.create(room);

                row.tabIndex = 0;
                row.setAttribute("aria-label", `View room ${room.name}`);
                row.addEventListener("click", this.#openRoom.bind(this, room));
                row.addEventListener("keydown", this.#handleRoomKeyDown.bind(this, room));
                this.#gameTableBody.appendChild(row);
            }
        }

        if (this.#gameTableBody.childElementCount === 0) {
            this.#renderEmptyGameMessage();
        }

        DomUtils.require("#join-mode-input", HTMLInputElement).disabled = this.#capabilities.join !== true;
        DomUtils.require("#create-mode-input", HTMLInputElement).disabled = this.#capabilities.create !== true;
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
        const isHosted = this.#hostedModeInput.checked;
        const modeLabel = isHosted ? "Hosted" : "Direct";
        const connectionState = this.#connectionStatus.dataset.status ?? "connecting";

        const statusLabel =
            {
                connecting: "connecting",
                connected: "connected",
                disconnected: "disconnected",
                error: "connection error"
            }[connectionState] ?? "status unknown";

        this.#connectionStatus.setAttribute("aria-label", `Connection mode. ${modeLabel} ${statusLabel}.`);
    }

    /** Submits create or join room intent. */
    #submitRegistration() {
        let playerName;
        let roomName;

        try {
            playerName = ValidationUtils.namedString(
                this.#playerNameInput.value,
                "Player name",
                ValidationUtils.actorNameMaxLength
            );
            roomName = ValidationUtils.namedString(
                this.#roomNameInput.value,
                "Room name",
                ValidationUtils.roomNameMaxLength
            );
        } catch (error) {
            this.handleNotification({
                status: Constants.STATUS.WARNING,
                title: "Invalid name",
                message: error.message
            });
            return;
        }

        const modeInput = document.querySelector("input[name='registration-mode']:checked");
        const registrationMode = modeInput instanceof HTMLInputElement ? modeInput.value : "create";

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

        const action = registrationMode === "join" ? Constants.ACTIONS.JOIN : Constants.ACTIONS.CREATE;

        const data = {
            roomName,
            playerName,
            playerLimit: Number(this.#playerLimitInput.value || Constants.ROOM_PLAYER_LIMIT)
        };

        this.#gameHandler?.(action, data);
    }

    /** @returns {boolean} Whether the latest directory contains a room name. */
    #isGameListed(roomName) {
        const gameKey = Actor.normalizeKey(roomName);
        const rooms = Array.isArray(this.#home?.rooms) ? this.#home.rooms : [];

        for (const room of rooms) {
            if (typeof room?.name === "string" && Actor.normalizeKey(room.name) === gameKey) {
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

    /** Opens a selected Direct or Hosted room. */
    #openRoom(room) {
        const roomName = ValidationUtils.requiredString(room.name, "Room name");
        this.#gameHandler?.(Constants.ACTIONS.VIEW, { roomName });
    }
}
