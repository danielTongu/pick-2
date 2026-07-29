// public/scripts/AppController.js

"use strict";

import { Constants } from "../Constants.js";
import { DomUtils } from "../utils/DomUtils.js";
import { PlayingCardUtils } from "../utils/PlayingCardUtils.js";

/**
 * Coordinates application startup, server sync routing, and view switching.
 */
export class AppController {
    /** @type {import("../ConnectionService.js").ConnectionService} */
    #connectionService;

    /** @type {import("./LobbyViewController.js").LobbyViewController} */
    #lobbyViewController;

    /** @type {import("./RoomViewController.js").RoomViewController} */
    #roomViewController;

    /**
     * Creates the application controller.
     *
     * @param {import("../ConnectionService.js").ConnectionService} client - Browser-tab client.
     * @param {import("./LobbyViewController.js").LobbyViewController} lobbyView - Lobby view controller.
     * @param {import("./RoomViewController.js").RoomViewController} roomView - Room view controller.
     */
    constructor(client, lobbyView, roomView) {
        this.#connectionService = client;
        this.#lobbyViewController = lobbyView;
        this.#roomViewController = roomView;
        this.#connectionService.setAppController(this);
    }

    /**
     * Starts the application.
     *
     * @returns {Promise<void>}
     */
    async start() {
        AppController.#renderCopyrightYear();

        await Promise.all([
            this.#lobbyViewController.initialize(),
            this.#roomViewController.initialize()
        ]);

        AppController.#synchronizeCardSortOptions();
        AppController.#synchronizeGameGuideCardScores();
        AppController.#renderGameGuideSpecialCards();
        this.#showLobby();
        this.#connectionService.connect();
    }

    /**
     * Synchronizes the card-sort control with the canonical sort options.
     */
    static #synchronizeCardSortOptions() {
        const select = DomUtils.require("#card-sort-key-select", HTMLSelectElement);
        const optionsByValue = new Map(Array.from(select.options, function (option) {
            return [option.value, option];
        }));

        for (const sortKey of Constants.CARD.SORT_OPTIONS) {
            let option = optionsByValue.get(sortKey);

            if (!option) {
                option = document.createElement("option");
                option.value = sortKey;
                select.appendChild(option);
            }

            option.textContent = sortKey;
            optionsByValue.delete(sortKey);
        }

        for (const unsupportedOption of optionsByValue.values()) {
            unsupportedOption.remove();
        }
    }

    /**
     * Synchronizes displayed guide scores with the canonical card-score rules.
     */
    static #synchronizeGameGuideCardScores() {
        const scoreTables = DomUtils.require("#scores-tables");
        const scoreCells = scoreTables.querySelectorAll("td[data-card-value][data-card-suit]");

        for (const scoreCell of scoreCells) {
            const { cardValue, cardSuit } = scoreCell.dataset;
            scoreCell.textContent = String(Constants.getCardScore(cardValue, cardSuit));
        }
    }

    /**
     * Renders the example cards associated with each special-card guide list.
     */
    static #renderGameGuideSpecialCards() {
        const { VALUE, SUIT } = Constants.CARD;
        const ordinarySuits = [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS, SUIT.SPADES];
        const suitedCards = function (value, suits = ordinarySuits) {
            return suits.map(function (suit) {
                return { value, suit };
            });
        };
        const cardsByListId = Object.freeze({
            "all-eights": suitedCards(VALUE.EIGHT.id),
            "all-jacks": suitedCards(VALUE.JACK.id),
            "aces-except-spades": suitedCards(VALUE.ACE.id, [SUIT.CLUBS, SUIT.DIAMONDS, SUIT.HEARTS]),
            "all-twos": suitedCards(VALUE.TWO.id),
            "all-jokers": suitedCards(VALUE.JOKER.id, [SUIT.BLACK, SUIT.RED]),
            "ace-of-spades": suitedCards(VALUE.ACE.id, [SUIT.SPADES]),
            "seven-of-hearts": suitedCards(VALUE.SEVEN.id, [SUIT.HEARTS])
        });

        for (const [listId, cards] of Object.entries(cardsByListId)) {
            const cardList = DomUtils.require(`#${listId}`, HTMLElement);
            cardList.replaceChildren(...cards.map(function (card) {
                return PlayingCardUtils.create(card);
            }));
            cardList.removeAttribute("id");
        }
    }

    /**
     * Renders the current year in the application copyright notice.
     */
    static #renderCopyrightYear() {
        const year = String(new Date().getFullYear());
        const yearElement = DomUtils.require("#copyright-year", HTMLTimeElement);

        yearElement.dateTime = year;
        yearElement.textContent = year;
    }

    /**
     * Requests the lobby state.
     */
    #requestLobby() {
        const sent = this.#connectionService.send(Constants.ACTIONS.VIEW_LOBBY);

        if (!sent) {
            this.#showDisconnectedAlert();
        }
    }

    /**
     * Shows a disconnected warning.
     */
    #showDisconnectedAlert() {
        this.#connectionService.showAlert({
            status: Constants.STATUS.WARNING,
            title: "Disconnected",
            message: "Try again in a moment."
        });
    }

    /**
     * Shows the lobby view.
     */
    #showLobby() {
        this.#roomViewController.hide();
        this.#lobbyViewController.show();
    }

    /**
     * Handles websocket open.
     */
    handleClientOpen() {
        this.#requestLobby();
    }

    /**
     * Routes a server sync payload.
     *
     * @param {string|null} viewName - Server view name.
     * @param {Object} sync - View payload.
     */
    handleSync(viewName, sync) {
        if (viewName === Constants.VIEWS.LOBBY) {
            this.#handleLobbySync(sync);
        } else if (viewName === Constants.VIEWS.ROOM) {
            this.#handleRoomSync(sync);
        } else {
            console.warn("Unhandled view sync:", viewName, sync);
        }
    }


    /**
     * Handles a lobby sync.
     *
     * @param {Object} lobby - Lobby payload.
     */
    #handleLobbySync(lobby) {
        this.#lobbyViewController.render(lobby);
        this.#showLobby();
    }

    /**
     * Handles a room sync.
     *
     * @param {Object} room - Room payload.
     */
    #handleRoomSync(room) {
        this.#roomViewController.render(room);
        this.#showRoom();
    }

    /**
     * Shows the room view.
     */
    #showRoom() {
        this.#lobbyViewController.hide();
        this.#roomViewController.show();
    }
}
