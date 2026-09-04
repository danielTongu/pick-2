
"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { PlayingCard } from "../PlayingCard.js";
import { PlayerDisplayUtils } from "../utilities/PlayerDisplayUtils.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton round-end overlay already present in the page HTML.
 */
export class ResultsController extends ViewController {
    /** @type {Object[]} */
    #players = [];

    /** @type {HTMLElement} */
    #message;

    /** @type {HTMLTableSectionElement} */
    #statsBody;

    /** @type {HTMLElement} */
    #selectedPlayerCards;

    /**
     * Creates a results overlay controller.
     *
     * @param {string} selector - Room-end overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        super(selector);
        this.#message = DomUtils.requireChild(this.root, "#results-message", HTMLElement);
        this.#statsBody = DomUtils.requireChild(this.root, "#player-stats-body", HTMLTableSectionElement);
        this.#selectedPlayerCards = DomUtils.requireChild(this.root, "#selected-player-hand", HTMLElement);
        this.bindDismissButton("#results-dismiss-button");
    }

    /**
     * Shows the completed-round results overlay.
     *
     * @param {*} room - Room data containing the completed round.
     * @throws {Error}
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
        this.#statsBody.replaceChildren();
        this.#selectedPlayerCards.replaceChildren();
        super.hide();
    }

    /**
     * Renders the overlay.
     *
     * @param {Object} room - Normalized Room data.
     */
    #render(room) {
        const winners = ResultsController.#getWinnerNames(room.players);

        this.#message.textContent = ResultsController.#buildResultMessage(room.playerName, winners);
        this.#renderStats(room.players);
        this.#selectedPlayerCards.replaceChildren();
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
        row.dataset.isSelected = "false";
        row.tabIndex = 0;
        row.setAttribute("aria-label", `View ${player.name}'s cards`);
        row.setAttribute("aria-selected", "false");
        DomUtils.setBooleanState(row, "isWinner", player.isWinner);

        row.appendChild(this.#createStatsCell(player.name));
        row.appendChild(this.#createStatsCell(String(player.hand.score)));
        row.appendChild(this.#createStatsCell(String(player.hand.cards.length)));
        row.appendChild(this.#createStatsCell(player.isWinner ? "Winner" : "Lost"));

        row.addEventListener("click", this.#selectPlayer.bind(this, player.name));
        row.addEventListener("keydown", this.#handleStatsKeyDown.bind(this, player.name));

        return row;
    }

    /** Selects a statistics row through its keyboard interaction. */
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
            this.#renderPlayerCards(player.hand.cards);
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
     * Renders one player's cards.
     *
     * @param {Object[]} cards - Card data objects.
     */
    #renderPlayerCards(cards) {
        this.#selectedPlayerCards.replaceChildren();

        for (const card of cards) {
            this.#selectedPlayerCards.appendChild(PlayingCard.create(card, true));
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

    /**
     * Normalizes completed-Room data.
     *
     * @param {*} room - Room data.
     * @returns {{players:Object[],playerName:string}} Normalized Room data.
     */
    static #normalizeRoom(room) {
        const source = ValidationUtils.object(room, "Room");
        const playerName = ValidationUtils.optionalString(source.localPlayerName, "");

        return {
            players: PlayerDisplayUtils.localFirst(source.circle?.players, playerName),
            playerName
        };
    }

    /**
     * Gets winner names.
     *
     * @param {Object[]} players - Player data objects.
     * @returns {string[]} Winner names.
     */
    static #getWinnerNames(players) {
        const names = [];

        for (const player of players) {
            if (player.isWinner === true) {
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
     * @returns {string} Room-end message.
     */
    static #buildResultMessage(playerName, winners) {
        let message = "Room finished.";

        if (winners.length > 1) {
            message = "It is a tie.";
        } else if (winners.length === 1) {
            const isLocalPlayerWinner = winners[0] === playerName;
            const emojiGroup = isLocalPlayerWinner ? Constants.EMOJIS.winner : Constants.EMOJIS.silly;
            message = isLocalPlayerWinner ? `You won. ${emojiGroup.random}` : `You lost. ${emojiGroup.random}`;
        }

        return message;
    }

}
