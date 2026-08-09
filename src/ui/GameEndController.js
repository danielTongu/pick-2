
"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { DomUtils } from "./DomUtils.js";
import { PlayingCard } from "./PlayingCard.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton game-end overlay already present in the page HTML.
 */
export class GameEndController extends ViewController {
    /** @type {Object[]} */
    #players = [];

    /** @type {HTMLElement} */
    #message;

    /** @type {HTMLTableSectionElement} */
    #statsBody;

    /** @type {HTMLElement} */
    #playerCardsTitle;

    /** @type {HTMLElement} */
    #selectedPlayerCards;

    /**
     * Creates a game-end overlay controller.
     *
     * @param {string} selector - Game-end overlay selector.
     * @throws {Error}
     */
    constructor(selector) {
        super(selector);
        this.#message = DomUtils.requireChild(this.root, "#game-end-message", HTMLElement);
        this.#statsBody = DomUtils.requireChild(this.root, "#game-end-player-stats-body", HTMLTableSectionElement);
        this.#playerCardsTitle = DomUtils.requireChild(this.root, "#game-end-player-cards-panel h2", HTMLElement);
        this.#selectedPlayerCards = DomUtils.requireChild(this.root, "#game-end-selected-player-hand", HTMLElement);
        this.bindDismissButton("#game-end-dismiss-button");
    }

    /**
     * Shows the game-end overlay.
     *
     * @param {*} room - Room payload.
     * @throws {Error}
     */
    show(room) {
        const data = GameEndController.#normalizeRoom(room);

        this.#players = data.players;
        this.#render(data);

        super.show();
    }

    /**
     * Renders the overlay.
     *
     * @param {Object} room - Normalized room.
     */
    #render(room) {
        const winners = GameEndController.#getWinnerNames(room.players);

        this.#message.textContent = GameEndController.#getGameEndMessage(room.playerName, winners);
        this.#renderStats(room.players);

        if (room.players.length > 0) {
            this.#selectPlayer(room.players[0].name);
        } else {
            this.#playerCardsTitle.textContent = "Player Cards";
            this.#selectedPlayerCards.replaceChildren();
        }
    }

    /**
     * Renders the player statistics table.
     *
     * @param {Object[]} players - Player payloads.
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
     * @param {Object} player - Player payload.
     * @returns {HTMLTableRowElement} Statistics row.
     */
    #createStatsRow(player) {
        const row = document.createElement("tr");

        row.dataset.playerName = player.name;
        row.dataset.isSelected = "false";
        DomUtils.setBooleanState(row, "isWinner", player.isWinner);

        row.appendChild(this.#createStatsCell(player.name));
        row.appendChild(this.#createStatsCell(String(player.hand.score)));
        row.appendChild(this.#createStatsCell(String(player.hand.cards.length)));
        row.appendChild(this.#createStatsCell(player.isWinner ? "Winner" : "Lost"));

        row.addEventListener("click", function () {
            this.#selectPlayer(player.name);
        }.bind(this));

        return row;
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
            this.#playerCardsTitle.textContent = `${player.name}'s Cards`;
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
                DomUtils.setBooleanState(row, "isSelected", row.dataset.playerName === playerName);
            }
        }
    }

    /**
     * Renders one player's cards.
     *
     * @param {Object[]} cards - Card payloads.
     */
    #renderPlayerCards(cards) {
        this.#selectedPlayerCards.replaceChildren();

        for (const card of cards) {
            this.#selectedPlayerCards.appendChild(PlayingCard.create(card));
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
     * Normalizes room payload.
     *
     * @param {*} room - Room payload.
     * @returns {{players:Object[],playerName:string}} Normalized room.
     */
    static #normalizeRoom(room) {
        const source = NormalizeUtils.object(room, "Room");

        return {
            players: Array.isArray(source.circle?.players) ? source.circle.players : [],
            playerName: NormalizeUtils.optionalString(source.session?.playerName, "")
        };
    }

    /**
     * Gets winner names.
     *
     * @param {Object[]} players - Player payloads.
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
     * Builds the game-end message.
     *
     * @param {string} playerName - Local player.
     * @param {string[]} winners - Winner names.
     * @returns {string} Game-end message.
     */
    static #getGameEndMessage(playerName, winners) {
        let message = "Game finished.";

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
