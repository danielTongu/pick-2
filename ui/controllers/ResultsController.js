"use strict";

import { Constants } from "../../core/Constants.js";
import { ValidationUtils } from "../../core/ValidationUtils.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { PlayerDisplayUtils } from "../utilities/PlayerDisplayUtils.js";
import { PlayingCard } from "../PlayingCard.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the singleton round-end overlay already present in the page HTML.
 */
export class ResultsController extends ViewController {
    /** @type {Object[]} Actor or item snapshots currently rendered by the controller. */
    #actors = [];

    /** @type {HTMLElement} Required UI element owned by this controller. */
    #message;

    /** @type {HTMLTableSectionElement} Required table body replaced from authoritative state. */
    #statsBody;

    /** @type {HTMLElement} Required UI element owned by this controller. */
    #selectedActorItems;

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
        this.#selectedActorItems = DomUtils.requireChild(this.root, "#selected-player-items", HTMLElement);
        this.bindDismissButton("#results-dismiss-button");
    }

    /**
     * Shows the completed-round results overlay.
     *
     * @param {*} room - Room data containing the completed round.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    show(room) {
        const data = ResultsController.#normalizeRoom(room);

        this.#actors = data.actors;
        this.#render(data);

        super.show();
    }

    /** Clears stale results whenever the overlay is closed. */
    hide() {
        this.#actors = [];
        this.#message.textContent = "";
        this.#statsBody.replaceChildren();
        this.#selectedActorItems.replaceChildren();
        super.hide();
    }

    /**
     * Renders the overlay.
     *
     * @param {Object} room - Normalized Room data.
     */
    #render(room) {
        const winners = ResultsController.#getWinnerNames(room.actors);

        this.#message.textContent = ResultsController.#buildResultMessage(room.actorName, winners);
        this.#renderStats(room.actors);
        this.#selectedActorItems.replaceChildren();
    }

    /**
     * Renders the actor statistics table.
     *
     * @param {Object[]} actors - Actor data objects.
     */
    #renderStats(actors) {
        this.#statsBody.replaceChildren();

        for (const actor of actors) {
            this.#statsBody.appendChild(this.#createStatsRow(actor));
        }
    }

    /**
     * Creates one statistics row.
     *
     * @param {Object} actor - Actor data object.
     * @returns {HTMLTableRowElement} Statistics row.
     */
    #createStatsRow(actor) {
        const row = document.createElement("tr");

        row.dataset.actorName = actor.name;
        row.dataset.isSelected = "false";
        row.tabIndex = 0;
        row.setAttribute("aria-label", `View ${actor.name}'s cards`);
        row.setAttribute("aria-selected", "false");
        DomUtils.setBooleanState(row, "isWinner", actor.state === Constants.ACTOR_STATE.WON);

        row.appendChild(this.#createStatsCell(actor.name));
        row.appendChild(this.#createStatsCell(String(actor.collection.score)));
        row.appendChild(this.#createStatsCell(String(actor.collection.itemCount ?? actor.collection.items.length)));
        row.appendChild(this.#createStatsCell(actor.state === Constants.ACTOR_STATE.WON ? "Winner" : "Lost"));

        row.addEventListener("click", this.#selectActor.bind(this, actor.name));
        row.addEventListener("keydown", this.#handleStatsKeyDown.bind(this, actor.name));

        return row;
    }

    /** Selects a statistics row through its keyboard interaction. */
    #handleStatsKeyDown(actorName, event) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.#selectActor(actorName);
        }
    }

    /**
     * Selects one actor.
     *
     * @param {string} actorName - Actor name.
     */
    #selectActor(actorName) {
        const actor = this.#findActor(actorName);

        if (actor !== null) {
            this.#selectStatsRow(actorName);
            this.#renderActorItems(actor.collection.items);
        }
    }

    /**
     * Finds one actor.
     *
     * @param {string} actorName - Actor name.
     * @returns {Object|null} Matching actor.
     */
    #findActor(actorName) {
        let found = null;

        for (const actor of this.#actors) {
            if (actor.name === actorName) {
                found = actor;
                break;
            }
        }

        return found;
    }

    /**
     * Selects one statistics row.
     *
     * @param {string} actorName - Selected actor.
     */
    #selectStatsRow(actorName) {
        const rows = this.#statsBody.querySelectorAll("tr");

        for (const row of rows) {
            if (row instanceof HTMLTableRowElement) {
                const isSelected = row.dataset.actorName === actorName;

                DomUtils.setBooleanState(row, "isSelected", isSelected);
                row.setAttribute("aria-selected", String(isSelected));
            }
        }
    }

    /**
     * Renders one actor's items.
     *
     * @param {Object[]} items - Item data objects.
     */
    #renderActorItems(items) {
        this.#selectedActorItems.replaceChildren();

        for (const item of items) {
            this.#selectedActorItems.appendChild(PlayingCard.create(item));
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
     * @returns {{actors:Object[],actorName:string}} Normalized Room data.
     */
    static #normalizeRoom(room) {
        const source = ValidationUtils.object(room, "Room");
        const actorName = ValidationUtils.optionalString(source.localActorName, "");

        return {
            actors: PlayerDisplayUtils.localFirst(source.turnOrder?.actors, actorName),
            actorName
        };
    }

    /**
     * Returns display names for every actor whose final state is won.
     *
     * @param {Object[]} actors - Actor data objects.
     * @returns {string[]} Winner names.
     */
    static #getWinnerNames(actors) {
        const names = [];

        for (const actor of actors) {
            if (actor.state === Constants.ACTOR_STATE.WON) {
                names.push(actor.name);
            }
        }

        return names;
    }

    /**
     * Builds the results message.
     *
     * @param {string} actorName - Local actor.
     * @param {string[]} winners - Winner names.
     * @returns {string} Room-end message.
     */
    static #buildResultMessage(actorName, winners) {
        let message = "Room finished.";

        if (winners.length > 1) {
            message = "It is a tie.";
        } else if (winners.length === 1) {
            const isLocalActorWinner = winners[0] === actorName;
            message = isLocalActorWinner ? "You won. 🎉" : "You lost.";
        }

        return message;
    }
}
