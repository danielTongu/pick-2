// public/scripts/LobbyViewController.js

"use strict";

import { Constants } from "../Constants.js";
import { RoomTableRowUtils } from "../utils/RoomTableRowUtils.js";
import { DomUtils } from "../utils/DomUtils.js";
import { NormalizeUtils } from "../utils/NormalizeUtils.js";

/**
 * Controls the lobby view UI.
 */
export class LobbyViewController {
    /** @type {Object|null} */
    #lobby = null;

    /** @type {import("../ConnectionService.js").ConnectionService} */
    #connectionService;

    /** @type {HTMLElement} */
    #lobbyView;

    /** @type {HTMLTableSectionElement} */
    #roomTableBody;

    /** @type {HTMLButtonElement} */
    #submitButton;

    /** @type {HTMLSelectElement} */
    #statusFilter;

    /** @type {HTMLInputElement} */
    #playerNameInput;

    /** @type {HTMLInputElement} */
    #roomNameInput;

    /** @type {HTMLInputElement} */
    #capacityInput;

    /**
     * Creates a lobby view controller.
     *
     * @param {import("../ConnectionService.js").ConnectionService} client - Browser-tab client.
     */
    constructor(client) {
        this.#connectionService = client;

        this.#lobbyView = DomUtils.require("#lobby-view", HTMLElement);
        this.#roomTableBody = DomUtils.require("#room-list-table-body", HTMLTableSectionElement);

        this.#submitButton = DomUtils.require("#room-registration-submit-button", HTMLButtonElement);
        this.#statusFilter = DomUtils.require("#room-status-filter", HTMLSelectElement);

        this.#playerNameInput = DomUtils.require("#player-name-input", HTMLInputElement);
        this.#roomNameInput = DomUtils.require("#room-name-input", HTMLInputElement);
        this.#capacityInput = DomUtils.require("#room-capacity-input", HTMLInputElement);
    }

    /**
     * Initializes lobby dependencies and events.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        await RoomTableRowUtils.load();
        this.#bindEvents();
    }

    /**
     * Shows the lobby view.
     */
    show() {
        DomUtils.show(this.#lobbyView);
    }

    /**
     * Hides the lobby view.
     */
    hide() {
        DomUtils.hide(this.#lobbyView);
    }

    /**
     * Stores and renders lobby state.
     *
     * @param {Object|null} lobby - Lobby payload.
     */
    render(lobby) {
        this.#lobby = lobby;

        this.#roomTableBody.replaceChildren();

        for (const room of LobbyViewController.#getRooms(lobby)) {
            if (this.#isRoomVisible(room)) {
                this.#roomTableBody.appendChild(
                    this.#createRoomTableRow(room)
                );
            }
        }
    }

    /**
     * Binds lobby events.
     */
    #bindEvents() {
        this.#submitButton.addEventListener("click", function (event) {
            event.preventDefault();
            this.#submitRegistration();
        }.bind(this));

        this.#statusFilter.addEventListener("change", function () {
            this.render(this.#lobby);
        }.bind(this));
    }

    /**
     * Creates one clickable room table row.
     *
     * @param {Object} room - Room payload.
     * @returns {HTMLTableRowElement} Room row.
     */
    #createRoomTableRow(room) {
        const row = RoomTableRowUtils.create(room);

        row.addEventListener("click", function () {
            this.#admitVisitor(room);
        }.bind(this));

        return row;
    }

    /**
     * Requests admission to one room as a visitor.
     *
     * @param {Object} room - Room payload.
     */
    #admitVisitor(room) {
        const source = NormalizeUtils.object(room, "Room");

        const sent = this.#connectionService.send(
            Constants.ACTIONS.ADMIT_VISITOR,
            { roomName: NormalizeUtils.requiredString(source.name, "Room name") }
        );

        if (!sent) {
            this.#showDisconnectedAlert();
        }
    }

    /**
     * Submits the room registration form.
     */
    #submitRegistration() {
        const payload = this.#getRegistrationPayload();

        if (payload.roomName && payload.playerName) {
            this.#sendRegistration(payload);
        } else {
            this.#showMissingFieldsAlert();
        }
    }

    /**
     * Sends a registration request.
     *
     * @param {{mode:string,roomName:string,playerName:string,capacity:number}} payload - Registration payload.
     */
    #sendRegistration(payload) {
        const action = payload.mode === "create"
            ? Constants.ACTIONS.CREATE_ROOM
            : Constants.ACTIONS.ADMIT_PLAYER;

        const body = {
            roomName: payload.roomName,
            playerName: payload.playerName
        };

        if (action === Constants.ACTIONS.CREATE_ROOM) {
            body.capacity = payload.capacity;
        }

        this.#connectionService.send(action, body);
    }

    /**
     * Reads the room registration form.
     *
     * @returns {{mode:string,roomName:string,playerName:string,capacity:number}}
     * Registration payload.
     */
    #getRegistrationPayload() {
        const selectedMode = document.querySelector("input[name='mode']:checked");

        return {
            mode: selectedMode instanceof HTMLInputElement ? selectedMode.value : "join",
            roomName: NormalizeUtils.optionalString(this.#roomNameInput.value, ""),
            playerName: NormalizeUtils.optionalString(this.#playerNameInput.value, ""),
            capacity: NormalizeUtils.nonNegativeNumber(
                Number(this.#capacityInput.value || Constants.ROOM_MAX_CAPACITY),
                "Room capacity"
            )
        };
    }

    /**
     * Checks whether one room passes the current filter.
     *
     * @param {Object} room - Room payload.
     * @returns {boolean} True when visible.
     */
    #isRoomVisible(room) {
        const filter = NormalizeUtils.optionalString(this.#statusFilter.value, "");
        return !filter || room.status === filter;
    }

    /**
     * Shows a disconnected alert.
     */
    #showDisconnectedAlert() {
        this.#connectionService.showAlert({
            status: Constants.STATUS.WARNING,
            title: "Disconnected",
            message: "Try again in a moment."
        });
    }

    /**
     * Shows a missing-fields alert.
     */
    #showMissingFieldsAlert() {
        this.#connectionService.showAlert({
            status: Constants.STATUS.WARNING,
            title: "Missing Fields",
            message: "Player and room are required."
        });
    }

    /**
     * Gets lobby rooms.
     *
     * @param {Object|null} lobby - Lobby payload.
     * @returns {Object[]} Room payloads.
     */
    static #getRooms(lobby) {
        return Array.isArray(lobby?.rooms) ? lobby.rooms : [];
    }
}
