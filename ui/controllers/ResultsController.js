"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { PlayingCard } from "../PlayingCard.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton match-end overlay already present in the page HTML.
 */
export class ResultsController extends ViewController {
    /**
     * @type {Object[]} Player or item snapshots currently rendered by the controller.
     */
    #players = [];

    /**
     * @type {HTMLElement} Required UI element owned by this controller.
     */
    #message;

    /**
     * @type {HTMLTableSectionElement} Required table body replaced from authoritative state.
     */
    #statsBody;

    /**
     * @type {HTMLElement} Required UI element owned by this controller.
     */
    #selectedPlayerItems;

    /** @type {HTMLElement} Configurable match context. */
    #context;

    /**
     * Creates a results overlay controller.
     *
     * @param {string} selector - Room-end overlay selector.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(selector) {
        super(selector);
        this.#message = DomUtils.requireChild(this.root, "#results-message", HTMLElement);
        this.#statsBody = DomUtils.requireChild(this.root, "#player-stats-body", HTMLTableSectionElement);
        this.#selectedPlayerItems = DomUtils.requireChild(this.root, "#selected-player-items", HTMLElement);
        this.#context = DomUtils.requireChild(this.root, "#results-context", HTMLElement);
        this.bindDismissButton("#results-dismiss-button");
    }

    /**
     * Rotates player snapshots to begin with the local player without mutating turn order.
     *
     * @param {Object[]|null} players - Players in authoritative turn order.
     * @param {string|null} localPlayerName - Local player name, when present.
     * @returns {Object[]} Players in local-first display order.
     */
    static localFirst(players, localPlayerName) {
        if (!Array.isArray(players)) return [];

        const localIndex = players.findIndex(function findLocal(player) {
            return player?.name === localPlayerName;
        });
        if (localIndex <= 0) return players;

        return players.slice(localIndex).concat(players.slice(0, localIndex));
    }

    /**
     * Normalizes completed-Room data.
     *
     * @param {*} room - Room data.
     * @returns {{players:Object[],playerName:string,isKnockout:boolean,isKnockoutComplete:boolean}} Normalized Room data.
     */
    static #normalizeRoom(room) {
        const source = ValidationUtils.object(room, "Room");
        const playerName = ValidationUtils.optionalString(source.localPlayerName, "");

        return {
            players: ResultsController.localFirst(source.match.turnOrder?.players, playerName),
            playerName,
            isKnockout: source.match.isKnockout === true,
            isKnockoutComplete: source.match.isKnockoutComplete === true
        };
    }

    /**
     * Returns display names for every player whose final state is won.
     *
     * @param {Object[]} players - Player data objects.
     * @returns {string[]} Winner names.
     */
    static #getWinnerNames(players) {
        const names = [];

        for (const player of players) {
            if (player.state === Constants.PLAYER_STATE.WON) {
                names.push(player.name);
            }
        }

        return names;
    }

    /**
     * Builds the results message.
     *
     * @param {string} playerName - Local player.
     * @param {string[]} winners - Winner names.
     * @param {Object} room - Normalized Room data.
     * @returns {string} Room-end message.
     */
    static #buildResultMessage(playerName, winners, room) {
        let message = "Room finished.";

        if (room.isKnockout && !room.isKnockoutComplete) {
            const player = room.players.find(function matchesLocal(candidate) { return candidate.name === playerName; });
            return player?.state === Constants.PLAYER_STATE.QUALIFIED
                ? "You qualified for the next match."
                : "You were eliminated.";
        }
        if (room.isKnockout && winners.length !== 1) {
            return "Knockout finished in a tie.";
        }

        if (winners.length > 1) {
            message = "It is a tie.";
        } else if (winners.length === 1) {
            const isLocalPlayerWinner = winners[0] === playerName;
            message = isLocalPlayerWinner ? "You won 🎉" : "You lost 😂";
        }

        return message;
    }

    /**
     * Shows the completed-match results overlay.
     *
     * @param {*} room - Room data containing the completed match.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    show(room) {
        const data = ResultsController.#normalizeRoom(room);

        this.#players = data.players;
        this.#render(data);

        super.show();
    }

    /** Clears stale results whenever the overlay is closed. */
    hide() {
        this.#players = [];
        this.#message.textContent = "";
        this.#context.textContent = "";
        this.#statsBody.replaceChildren();
        this.#selectedPlayerItems.replaceChildren();
        super.hide();
    }

    /**
     * Renders the overlay.
     *
     * @param {Object} room - Normalized Room data.
     */
    #render(room) {
        const winners = ResultsController.#getWinnerNames(room.players);

        this.#message.textContent = ResultsController.#buildResultMessage(room.playerName, winners, room);
        this.#context.textContent = room.isKnockout ? "Knockout match results" : "Statistics for this game";
        this.#renderStats(room.players);
        this.#selectedPlayerItems.replaceChildren();
    }

    /**
     * Renders the player statistics table.
     *
     * @param {Object[]} players - Player data objects.
     */
    #renderStats(players) {
        this.#statsBody.replaceChildren();

        for (const player of players) {
            this.#statsBody.appendChild(this.#createStatsRow(player));
        }
    }

    /**
     * Creates one statistics row.
     *
     * @param {Object} player - Player data object.
     * @returns {HTMLTableRowElement} Statistics row.
     */
    #createStatsRow(player) {
        const row = document.createElement("tr");

        row.dataset.playerName = player.name;
        row.dataset.playerState = player.state;
        row.dataset.isSelected = "false";
        row.tabIndex = 0;
        row.setAttribute("aria-label", `View ${player.name}'s cards`);
        row.setAttribute("aria-selected", "false");
        DomUtils.setBooleanState(row, "isWinner", player.state === Constants.PLAYER_STATE.WON);

        row.appendChild(this.#createStatsCell(player.name));
        row.appendChild(this.#createStatsCell(String(player.collection.penalty)));
        row.appendChild(this.#createStatsCell(String(player.collection.itemCount ?? player.collection.items.length)));
        const labels = {
            [Constants.PLAYER_STATE.WON]: "Winner",
            [Constants.PLAYER_STATE.LOST]: "Lost",
            [Constants.PLAYER_STATE.QUALIFIED]: "Qualified",
            [Constants.PLAYER_STATE.ELIMINATED]: "Eliminated"
        };
        row.appendChild(this.#createStatsCell(labels[player.state] ?? player.state));

        row.addEventListener("click", this.#selectPlayer.bind(this, player.name));
        row.addEventListener("keydown", this.#handleStatsKeyDown.bind(this, player.name));

        return row;
    }

    /**
     * Selects a statistics row through its keyboard interaction.
     * @param {string} playerName - Row player name.
     * @param {KeyboardEvent} event - Row key event.
     */
    #handleStatsKeyDown(playerName, event) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.#selectPlayer(playerName);
        }
    }

    /**
     * Selects one player.
     *
     * @param {string} playerName - Player name.
     */
    #selectPlayer(playerName) {
        const player = this.#findPlayer(playerName);

        if (player !== null) {
            this.#selectStatsRow(playerName);
            this.#renderPlayerItems(player.collection.items);
        }
    }

    /**
     * Finds one player.
     *
     * @param {string} playerName - Player name.
     * @returns {Object|null} Matching player.
     */
    #findPlayer(playerName) {
        let found = null;

        for (const player of this.#players) {
            if (player.name === playerName) {
                found = player;
                break;
            }
        }

        return found;
    }

    /**
     * Selects one statistics row.
     *
     * @param {string} playerName - Selected player.
     */
    #selectStatsRow(playerName) {
        const rows = this.#statsBody.querySelectorAll("tr");

        for (const row of rows) {
            if (row instanceof HTMLTableRowElement) {
                const isSelected = row.dataset.playerName === playerName;

                DomUtils.setBooleanState(row, "isSelected", isSelected);
                row.setAttribute("aria-selected", String(isSelected));
            }
        }
    }

    /**
     * Renders one player's items.
     *
     * @param {Object[]} items - Item data objects.
     */
    #renderPlayerItems(items) {
        this.#selectedPlayerItems.replaceChildren();

        for (const item of items) {
            this.#selectedPlayerItems.appendChild(PlayingCard.create(item));
        }
    }

    /**
     * Creates one table cell.
     *
     * @param {string} text - Cell text.
     * @returns {HTMLTableCellElement} Table cell.
     */
    #createStatsCell(text) {
        const cell = document.createElement("td");
        cell.textContent = text;
        return cell;
    }
}
