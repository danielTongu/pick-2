"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { Player } from "../../core/Player.js";
import { AlertController } from "./AlertController.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { NotificationUtils } from "../utilities/NotificationUtils.js";
import { RoomRowUtils } from "../utilities/RoomRowUtils.js";
import { ViewController } from "./ViewController.js";
import { Card } from "../../core/Card.js";
import { PlayingCard } from "../PlayingCard.js";

/** Controls the shared Direct/Hosted home directory. */
export class HomeController extends ViewController {
    /**
     * @type {Object|null} Latest authoritative transport snapshot.
     */
    #home = null;

    /**
     * @type {Object} Current immutable UI capability or state record.
     */
    #capabilities = {};

    /**
     * @type {Function|null} Optional application callback registered by the owning page.
     */
    #modeHandler = null;

    /**
     * @type {Function|null} Optional application callback registered by the owning page.
     */
    #roomHandler = null;

    /**
     * @type {AlertController} Notification dialog owned by this page controller.
     */
    #alertController = new AlertController("#alert-dialog");

    /**
     * @type {HTMLTableSectionElement} Required table body replaced from authoritative state.
     */
    #roomTableBody;

    /**
     * @type {HTMLInputElement} Required user-input control owned by this controller.
     */
    #playerNameInput;

    /**
     * @type {HTMLInputElement} Required user-input control owned by this controller.
     */
    #roomNameInput;

    /**
     * @type {HTMLInputElement} Required user-input control owned by this controller.
     */
    #playerLimitInput;

    /**
     * @type {HTMLElement} Required UI element owned by this controller.
     */
    #connectionStatus;

    /**
     * @type {HTMLInputElement} Required user-input control owned by this controller.
     */
    #directModeInput;

    /**
     * @type {HTMLInputElement} Required user-input control owned by this controller.
     */
    #hostedModeInput;

    // ---- Construction and session API ----

    /** Creates the shared Home controller. */
    constructor() {
        super("#home-view");
        this.#roomTableBody = DomUtils.require("#list-table-body", HTMLTableSectionElement);
        this.#playerNameInput = DomUtils.require("#player-name-input", HTMLInputElement);
        this.#roomNameInput = DomUtils.require("#room-name-input", HTMLInputElement);
        this.#playerLimitInput = DomUtils.require("#player-limit-input", HTMLInputElement);
        this.#connectionStatus = DomUtils.require("#app-header > aside", HTMLElement);
        this.#directModeInput = DomUtils.require("#direct-mode-input", HTMLInputElement);
        this.#hostedModeInput = DomUtils.require("#hosted-mode-input", HTMLInputElement);
    }

    /** Binds Home forms, filters, and mode controls. */
    async initialize() {
        this.#renderSpecialCardFan();
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

    /**
     * @param {import("../Session.js").Session} view - Active Home session.
     */
    setView(view) {
        this.view = view;
    }

    /**
     * @param {Function} handler - Mode-selection callback.
     */
    setModeHandler(handler) {
        this.#modeHandler = handler;
    }

    /**
     * @param {Function} handler - Room-navigation callback.
     */
    setRoomHandler(handler) {
        this.#roomHandler = handler;
    }

    /**
     * Selects Direct or Hosted mode and refreshes endpoint capabilities.
     * @param {string} mode - Active play mode.
     */
    selectMode(mode) {
        DomUtils.require("#list-panel", HTMLElement).dataset.directoryState = "empty";
        const isHosted = mode === "hosted";
        this.#directModeInput.checked = !isHosted;
        this.#hostedModeInput.checked = isHosted;
        this.#connectionStatus.dataset.connectionStatus = "connecting";
        this.#roomTableBody.replaceChildren();
        this.#renderEmptyRoomMessage();
        this.#renderConnectionStatus();
    }

    // ---- Transport callbacks ----

    /** Requests the Home directory when the endpoint opens. */
    handleClientOpen() {
        this.view?.request(Constants.COMMANDS.LIST, {});
    }

    /**
     * Renders Home data received from the endpoint.
     * @param {string} view
     * @param {Object} home
     */
    handleData(view, home) {
        if (view === Constants.VIEWS.HOME) {
            this.#capabilities = ValidationUtils.object(home.capabilities, "Capabilities");
            this.render(home);
        }
    }

    /**
     * Displays a server notification in the shared alert overlay.
     * @param {Object} message
     */
    handleNotification(message) {
        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /**
     * Updates connection controls for the current endpoint status.
     * @param {string} status
     */
    handleConnectionStatus(status) {
        this.#connectionStatus.dataset.connectionStatus = status;
        this.#renderConnectionStatus();
    }

    // ---- Directory and header rendering ----

    /**
     * Renders the current Room directory.
     * @param {Object} home - Home data.
     */
    render(home) {
        this.#home = home;
        this.#roomTableBody.replaceChildren();
        const filter = DomUtils.require("#status-filter", HTMLSelectElement).value;

        for (const room of Array.isArray(home?.rooms) ? home.rooms : []) {
            if (!filter || room.match.state === filter) {
                const row = RoomRowUtils.create(room);

                row.tabIndex = 0;
                row.setAttribute("aria-label", `View room ${room.name}`);
                row.addEventListener("click", this.#openRoom.bind(this, room));
                row.addEventListener("keydown", this.#handleRoomKeyDown.bind(this, room));
                this.#roomTableBody.appendChild(row);
            }
        }

        if (this.#roomTableBody.childElementCount === 0) {
            this.#renderEmptyRoomMessage();
        }

        DomUtils.require("#list-panel", HTMLElement).dataset.directoryState = this.#roomTableBody.querySelector("tr:not(#empty-row)") === null ? "empty" : "populated";
        DomUtils.require("#join-mode-input", HTMLInputElement).disabled = this.#capabilities.join !== true;
        DomUtils.require("#create-mode-input", HTMLInputElement).disabled = this.#capabilities.create !== true;
    }

    /** Renders the empty registry row. */
    #renderEmptyRoomMessage() {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 8;
        cell.textContent = "No rooms available.";
        row.id = "empty-row";
        row.appendChild(cell);
        this.#roomTableBody.appendChild(row);
    }

    /** Renders connection state and mode switching on one control. */
    #renderConnectionStatus() {
        const isHosted = this.#hostedModeInput.checked;
        const modeLabel = isHosted ? "Live" : "Local";
        const connectionState = this.#connectionStatus.dataset.connectionStatus ?? "connecting";

        const statusLabel =
            {
                connecting: "connecting",
                reconnecting: "reconnecting",
                connected: "connected",
                disconnected: "disconnected",
                error: "connection error"
            }[connectionState] ?? "status unknown";

        this.#connectionStatus.setAttribute("aria-label", `Connection mode. ${modeLabel} ${statusLabel}.`);
    }

    // ---- Registration and mode events ----

    /**
     * Validates the registration form and submits the selected create, join, or view intent.
     * @param {SubmitEvent} event - Registration submission.
     */
    #handleRegistrationSubmit(event) {
        event.preventDefault();
        this.#submitRegistration();
    }

    /** Submits create or join room intent. */
    #submitRegistration() {
        let playerName;
        let roomName;

        try {
            playerName = ValidationUtils.namedString(
                this.#playerNameInput.value,
                "Player name",
                ValidationUtils.PLAYER_NAME_MAX_LENGTH
            );
            roomName = ValidationUtils.namedString(
                this.#roomNameInput.value,
                "Room name",
                ValidationUtils.ROOM_NAME_MAX_LENGTH
            );
        } catch (error) {
            this.handleNotification({
                ...Constants.ACTION_NOTIFICATIONS.INVALID_NAME,
                message: error.message
            });
            return;
        }

        const modeInput = document.querySelector("input[name='registration-mode']:checked");
        const registrationMode = modeInput instanceof HTMLInputElement ? modeInput.value : "create";

        const isRoomListed = this.#isRoomListed(roomName);

        if (registrationMode === "join" && !isRoomListed) {
            this.handleNotification({
                ...Constants.ACTION_NOTIFICATIONS.ROOM_NOT_FOUND
            });
            return;
        }

        if (registrationMode === "create" && isRoomListed) {
            this.handleNotification({
                ...Constants.ACTION_NOTIFICATIONS.ROOM_ALREADY_EXISTS
            });
            return;
        }

        const command = registrationMode === "join" ? Constants.COMMANDS.JOIN : Constants.COMMANDS.CREATE;

        const data = {
            roomName,
            playerName,
            playerLimit: Number(this.#playerLimitInput.value || Constants.ROOM_PLAYER_LIMIT)
        };

        this.#roomHandler?.(command, data);
    }

    /**
     * @param {string} roomName - Room name to find.
     * @returns {boolean} Whether the latest directory contains the room name.
     */
    #isRoomListed(roomName) {
        const roomKey = Player.normalizeKey(roomName);
        const rooms = Array.isArray(this.#home?.rooms) ? this.#home.rooms : [];

        for (const room of rooms) {
            if (typeof room?.name === "string" && Player.normalizeKey(room.name) === roomKey) {
                return true;
            }
        }

        return false;
    }

    /** Reapplies the selected room-status filter. */
    #handleStatusFilterChange() {
        this.render(this.#home);
    }

    /**
     * Switches mode when a mode radio becomes selected.
     * @param {Event} event - Mode-input change.
     */
    #handleModeChange(event) {
        const input = event.currentTarget;

        if (input instanceof HTMLInputElement && input.checked) {
            this.#modeHandler?.(input.value);
        }
    }

    // ---- Room navigation ----

    /**
     * Opens a room from a keyboard-activated directory row.
     * @param {Object} room - Selected directory room.
     * @param {KeyboardEvent} event - Row key event.
     */
    #handleRoomKeyDown(room, event) {
        if (event.key === "Enter") {
            event.preventDefault();
            this.#openRoom(room);
        }
    }

    /**
     * Opens a selected Direct or Hosted room.
     * @param {Object} room - Selected directory room.
     */
    #openRoom(room) {
        const roomName = ValidationUtils.requiredString(room.name, "Room name");
        this.#roomHandler?.(Constants.COMMANDS.VIEW, { roomName });
    }

    // ---- Home card preview ----

    /** Renders the Home preview fan using the canonical card comparator. */
    #renderSpecialCardFan() {
        const fan = document.querySelector("#card-fan");
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
        ].sort(Card.compareByRank);
        fan.replaceChildren(...cards.map(HomeController.#createFanCard));
    }

    /**
     * Creates one static Home preview card.
     * @param {Card} card - Card to display.
     * @returns {PlayingCard} Preview element.
     */
    static #createFanCard(card) {
        const element = PlayingCard.create(card);
        element.rotation = null;
        return element;
    }
}
