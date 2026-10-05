"use strict";

import { CardCollection } from "../../core/CardCollection.js";
import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { CardListUtils } from "../utilities/CardListUtils.js";
import { ViewController } from "./ViewController.js";

/**
 * Controls the local-actor area within the shared Room play area.
 */
export class LocalActorController extends ViewController {
    /**
     * @type {Function|null} Optional application callback registered by the owning page.
     */
    #commandHandler = null;

    /**
     * @type {Function|null} Optional application callback registered by the owning page.
     */
    #sortHandler = null;

    /**
     * @type {HTMLElement} Required UI element owned by this controller.
     */
    #playRegion;

    /**
     * @type {HTMLSpanElement} Required actor identity and status output.
     */
    #actorStatus;

    /**
     * @type {HTMLSpanElement} Required text output synchronized during rendering.
     */
    #actorCardCount;

    /**
     * @type {HTMLSpanElement} Card-hand container and drop target.
     */
    #handElement;

    /**
     * @type {HTMLButtonElement} Required command control owned by this controller.
     */
    #drawButton;

    /**
     * @type {HTMLSpanElement} Required text output synchronized during rendering.
     */
    #drawAllowanceOutput;

    /**
     * @type {HTMLSelectElement} Required selection control owned by this controller.
     */
    #sortControl;

    /**
     * @type {HTMLElement|null} Optional UI output present only in supported room modes.
     */
    #idleSecondsOutput = null;

    /**
     * @type {HTMLButtonElement} Required command control owned by this controller.
     */
    #playButton;

    /**
     * @type {HTMLButtonElement} Required command control owned by this controller.
     */
    #passButton;

    /**
     * Creates an actor-area controller.
     *
     * @param {string} selector - Actor-area selector.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    constructor(selector) {
        super(selector);
        const playRegion = this.root.closest('[data-has-local-actor]');

        if (!(playRegion instanceof HTMLElement)) {
            throw new Error("Actor area must belong to the room play area.");
        }

        this.#playRegion = playRegion;
        this.#actorStatus = DomUtils.requireChild(this.root, "[data-actor-name]", HTMLSpanElement);
        this.#actorCardCount = DomUtils.requireChild(this.root, "[data-item-count]", HTMLSpanElement);
        this.#handElement = DomUtils.requireChild(this.root, "#actor-hand > .playing-card-area", HTMLSpanElement);
        this.#drawButton = DomUtils.requireChild(this.root, "#draw-button", HTMLButtonElement);
        this.#drawAllowanceOutput = DomUtils.requireChild(this.root, "[data-draw-allowance]", HTMLSpanElement);
        const idleSecondsOutput = this.root.querySelector("[data-idle-seconds]");

        if (idleSecondsOutput instanceof HTMLElement) {
            this.#idleSecondsOutput = idleSecondsOutput;
        }

        this.#sortControl = DomUtils.requireChild(this.root, "#sort-key-select", HTMLSelectElement);
        this.#playButton = DomUtils.requireChild(this.root, "#room-play-button", HTMLButtonElement);
        this.#passButton = DomUtils.requireChild(this.root, "#turn-pass-button", HTMLButtonElement);

        if (this.#idleSecondsOutput !== null) {
            const idleSeconds = Constants.ROOM_WAIT_MS / 1000;
            this.#idleSecondsOutput.dataset.idleSeconds = String(idleSeconds);
        }
    }

    /**
     * Sets the callback invoked for local-actor commands.
     *
     * @param {Function} handler - Command callback.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    setCommandHandler(handler) {
        if (typeof handler !== "function") {
            throw new Error("Local actor command handler must be a function.");
        }

        this.#commandHandler = handler;
    }

    /**
     * Sets the callback invoked when the sort key changes.
     *
     * @param {Function} handler - Sort callback.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    setSortHandler(handler) {
        if (typeof handler !== "function") {
            throw new Error("Local actor sort handler must be a function.");
        }

        this.#sortHandler = handler;
    }

    /**
     * Initializes local-actor event bindings.
     */
    initialize() {
        this.#bindCommandButton(this.#drawButton, Constants.COMMANDS.DRAW);
        this.#bindCommandButton(this.#passButton, Constants.COMMANDS.PASS);
        this.#bindCommandButton(this.#playButton, Constants.COMMANDS.START);

        this.#sortControl.addEventListener(
            "change",
            function () {
                this.#submitSortChange();
            }.bind(this)
        );
    }

    /**
     * Shows and updates the actor area.
     *
     * @param {Object} actor - Actor data.
     * @param {Object} room - Room data.
     * @param {string} sortKey - Selected sort key.
     * @throws {Error} When required markup, callback, or input data violates the controller contract.
     */
    show(actor, room, sortKey) {
        this.#playRegion.dataset.hasLocalActor = "true";
        this.#renderRootState(actor);
        this.#renderHeader(actor);
        this.#renderControls(actor, room, sortKey);
        this.#renderCards(actor, room, sortKey);
    }

    /**
     * Clears and hides the actor area.
     */
    hide() {
        this.#clear();
        this.#playRegion.dataset.hasLocalActor = "false";
    }

    /**
     * Clears local-actor UI state.
     */
    #clear() {
        this.root.dataset.actorState = Constants.ACTOR_STATE.READY;
        this.#actorStatus.dataset.actorName = "";
        this.#actorCardCount.dataset.itemCount = "0";
        this.#drawAllowanceOutput.dataset.drawAllowance = "0";
        this.#handElement.replaceChildren();
    }

    /**
     * Binds one button to one local-actor command.
     *
     * @param {HTMLButtonElement} button - Button element.
     * @param {string} command - Room command.
     */
    #bindCommandButton(button, command) {
        button.addEventListener(
            "click",
            function (event) {
                event.preventDefault();
                this.#submitCommand(command);
            }.bind(this)
        );
    }

    /**
     * Submits a local-actor command.
     *
     * @param {string} command - Room command.
     */
    #submitCommand(command) {
        if (this.#commandHandler !== null) {
            this.#commandHandler(command);
        }
    }

    /**
     * Submits the selected sort key.
     */
    #submitSortChange() {
        if (this.#sortHandler !== null) {
            this.#sortHandler(this.#sortControl.value);
        }
    }

    /**
     * Renders turn ownership and final actor state on the local-area root.
     * @param {Object} actor - Local actor snapshot.
     */
    #renderRootState(actor) {
        this.root.dataset.actorState = actor.state;
    }

    /**
     * Renders the canonical local actor identity and item count.
     * @param {Object} actor - Local actor snapshot.
     */
    #renderHeader(actor) {
        this.#actorStatus.dataset.actorName = actor.name ?? "";
        this.#actorCardCount.dataset.itemCount = String(actor.collection.items.length);
    }

    /**
     * Renders draw allowance, sort selection, and the Play action label.
     * @param {Object} actor - Local actor snapshot.
     * @param {Object} room - Authoritative room snapshot.
     * @param {string} sortKey - Selected hand sort order.
     */
    #renderControls(actor, room, sortKey) {
        this.#drawAllowanceOutput.dataset.drawAllowance = String(actor.drawAllowance);
        this.#sortControl.value = sortKey;
        this.#playButton.dataset.mode = room.match.nextMatchAvailable === true
            ? Constants.PLAY_BUTTON_MODE.NEXT_MATCH
            : Constants.PLAY_BUTTON_MODE.CHOOSE;

    }

    /**
     * Renders the sorted local collection and enables dragging only when discarding is legal.
     * @param {Object} actor - Local actor snapshot.
     * @param {Object} room - Authoritative room snapshot.
     * @param {string} sortKey - Selected hand sort order.
     */
    #renderCards(actor, room, sortKey) {
        const orderedCards = new CardCollection(actor.collection.items).sorted(sortKey);
        const ownerKey = room.match.turnOrder?.ownerKey ?? null;
        const allowsFreeTransactions = room.match.state === Constants.ROOM_STATE.WAITING
            || (room.match.state === Constants.ROOM_STATE.FINISHED && !room.match.isKnockout);
        const canDiscard = room.match.pending === null && (allowsFreeTransactions
            || (room.match.state === Constants.ROOM_STATE.ACTIVE && (!ownerKey || ownerKey === actor.key)));
        const destination = canDiscard ? DomUtils.require("#table-play-area > [data-is-drag-over]", HTMLElement) : null;

        CardListUtils.update(this.#handElement, orderedCards.reverse(), destination);
    }

}
