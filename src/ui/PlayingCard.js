
"use strict";

import { NormalizeUtils } from "../core/NormalizeUtils.js";

/**
 * Interactive playing-card custom element.
 *
 * Game cards are draggable. Decorative cards opt out of interaction with the
 * `data-decorative` attribute. A release over the configured discard target
 * emits a card-drop event; any other release restores the card at its origin.
 * Game legality, turn ownership, and server communication remain controller
 * responsibilities.
 */
export class PlayingCard extends HTMLElement {
    /** @type {string} */
    static elementName = "playing-card";

    /** @type {HTMLElement|null} */
    static #discardTarget = null;

    /** @type {PlayingCard|null} */
    static #activeCard = null;

    /** @type {number} */
    static #dragThreshold = 6;

    /** @type {HTMLElement|null} */
    #dragHandle = null;

    /** @type {boolean} */
    #isInitialized = false;

    /** @type {boolean} */
    #areEventsBound = false;

    /** @type {number|null} */
    #dragResetTimeoutId = null;

    /** @type {{
     *     clone:HTMLElement|null,
     *     pointerId:number|null,
     *     startX:number,
     *     startY:number,
     *     offsetX:number,
     *     offsetY:number,
     *     didDrag:boolean
     * }}
     */
    #dragState = {
        clone: null,
        pointerId: null,
        startX: 0,
        startY: 0,
        offsetX: 0,
        offsetY: 0,
        didDrag: false
    };

    /**
     * Registers the discard target shared by playing-card elements.
     *
     * @param {string|HTMLElement} target - Target selector or element.
     * @throws {Error}
     */
    static setDiscardTarget(target) {
        let element = target;

        if (typeof target === "string") {
            element = document.querySelector(target);
        }

        if (!(element instanceof HTMLElement)) {
            throw new Error("Playing-card discard target is invalid.");
        }

        PlayingCard.#discardTarget = element;
    }

    /**
     * Creates and populates a playing-card element.
     *
     * @param {Object} card - Card data.
     * @param {Object} [options={}] - Interaction options.
     * @param {boolean} [options.isDraggable=true] - Whether pointer dragging is enabled.
     * @returns {PlayingCard} Created card element.
     * @throws {Error}
     */
    static create(card = {}, {isDraggable = true} = {}) {
        const element = document.createElement(PlayingCard.elementName);

        if (!(element instanceof PlayingCard)) {
            throw new Error("PlayingCard is not registered.");
        }

        element.dataset.isDraggable = String(isDraggable === true);
        element.update(card);

        return element;
    }

    /**
     * Initializes structure and behavior when connected.
     */
    connectedCallback() {
        if (!this.#isInitialized) {
            this.#initialize();
        }

        if (!this.hasAttribute("data-decorative") &&
            !this.hasAttribute("data-drag-clone") &&
            !this.#areEventsBound) {
            this.#bindEvents();
        }

        this.#updateAccessibility();
    }

    /**
     * Releases document state and listeners when disconnected.
     */
    disconnectedCallback() {
        if (this.#areEventsBound) {
            this.#unbindEvents();
        }

        this.#clearDragResetTimeout();
        this.#resetDrag(false);
    }

    /**
     * Updates card presentation and interaction state.
     *
     * @param {Object} card - Card data.
     * @param {string} [card.value] - Card value.
     * @param {string} card.suit - Card suit.
     * @param {number} [card.rotation] - Rotation in degrees.
     * @throws {Error}
     */
    update(card = {}) {
        const data = PlayingCard.#normalizeCard(card);

        this.dataset.value = data.value;
        this.dataset.suit = data.suit;

        this.setRotation(card.rotation);
        this.turnFaceUp();
        this.#updateAccessibility();
    }

    /**
     * Gets normalized card identity.
     *
     * @returns {{value:string,suit:string}} Card identity.
     * @throws {Error}
     */
    getCard() {
        return PlayingCard.#normalizeCard({
            value: this.dataset.value,
            suit: this.dataset.suit
        });
    }

    /**
     * Applies or clears card rotation.
     *
     * @param {*} rotation - Rotation in degrees.
     * @throws {Error}
     */
    setRotation(rotation) {
        this.style.removeProperty("--card-rotation");

        if (rotation !== undefined && rotation !== null) {
            const value = NormalizeUtils.number(rotation, "Card.rotation");

            this.style.setProperty("--card-rotation", `${value}deg`);
        }
    }

    /**
     * Shows the card face.
     */
    turnFaceUp() {
        this.dataset.isFaceDown = "false";
        this.#updateAccessibility();
    }

    /**
     * Hides the card face.
     */
    turnFaceDown() {
        this.dataset.isFaceDown = "true";
        this.#updateAccessibility();
    }

    /**
     * Checks whether the card face is hidden.
     *
     * @returns {boolean} True when face down.
     */
    isFaceDown() {
        return this.dataset.isFaceDown === "true";
    }

    /**
     * Toggles the visible card face.
     */
    toggleFace() {
        if (this.isFaceDown()) {
            this.turnFaceUp();
        } else {
            this.turnFaceDown();
        }
    }

    /**
     * Creates or adopts the card's internal light-DOM structure.
     */
    #initialize() {
        let dragHandle = this.querySelector(".playing-card-drag-handle");
        let center = this.querySelector(".playing-card-center");

        if (!(dragHandle instanceof HTMLElement) || !(center instanceof HTMLElement)) {
            dragHandle = document.createElement("div");
            dragHandle.className = "playing-card-drag-handle";

            center = document.createElement("div");
            center.className = "playing-card-center";

            this.replaceChildren(dragHandle, center);
        }

        this.#dragHandle = dragHandle;
        this.#isInitialized = true;

        if (this.hasAttribute("data-decorative")) {
            this.tabIndex = -1;
            this.setAttribute("aria-hidden", "true");
        } else {
            this.tabIndex = 0;
            this.setAttribute("role", "button");
        }

        if (this.dataset.isFaceDown !== "true") {
            this.dataset.isFaceDown = "false";
        }

        this.dataset.isDragging = "false";
    }

    /**
     * Binds element events.
     */
    #bindEvents() {
        if (this.#dragHandle === null) {
            throw new Error("Playing-card drag handle is missing.");
        }

        this.addEventListener("click", this.#handleClick);
        this.addEventListener("keydown", this.#handleKeyDown);
        if (this.dataset.isDraggable !== "false") {
            this.#dragHandle.addEventListener("pointerdown", this.#handlePointerDown);
        }

        this.#areEventsBound = true;
    }

    /**
     * Unbinds element events.
     */
    #unbindEvents() {
        this.removeEventListener("click", this.#handleClick);
        this.removeEventListener("keydown", this.#handleKeyDown);

        if (this.#dragHandle !== null) {
            this.#dragHandle.removeEventListener("pointerdown", this.#handlePointerDown);
        }

        this.#unbindDragEvents();

        this.#areEventsBound = false;
    }

    /**
     * Handles click-to-flip behavior.
     *
     * @param {MouseEvent} event - Click event.
     */
    #handleClick = event => {
        if (this.#dragState.didDrag) {
            this.#dragState.didDrag = false;
            this.#clearDragResetTimeout();
            event.preventDefault();
        } else {
            this.toggleFace();
        }
    };

    /**
     * Handles keyboard face toggling.
     *
     * @param {KeyboardEvent} event - Keyboard event.
     */
    #handleKeyDown = event => {
        const shouldToggle = event.key === "Enter" || event.key === " ";

        if (shouldToggle) {
            event.preventDefault();
            this.toggleFace();
        }
    };

    /**
     * Begins tracking a possible drag.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    #handlePointerDown = event => {
        const canStart = event.button === 0 &&
            (PlayingCard.#activeCard === null || PlayingCard.#activeCard === this);

        if (canStart && this.#dragHandle !== null) {
            const bounds = this.getBoundingClientRect();

            PlayingCard.#activeCard = this;
            this.#dragState.pointerId = event.pointerId;
            this.#dragState.startX = event.clientX;
            this.#dragState.startY = event.clientY;
            this.#dragState.offsetX = event.clientX - bounds.left;
            this.#dragState.offsetY = event.clientY - bounds.top;
            this.#dragState.didDrag = false;

            document.addEventListener("pointermove", this.#handlePointerMove);
            document.addEventListener("pointerup", this.#handlePointerUp);
            document.addEventListener("pointercancel", this.#handlePointerCancel);
            this.#dragHandle.setPointerCapture(event.pointerId);
        }
    };

    /**
     * Starts or updates an active drag.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    #handlePointerMove = event => {
        if (event.pointerId === this.#dragState.pointerId) {
            const distance = Math.hypot(
                event.clientX - this.#dragState.startX,
                event.clientY - this.#dragState.startY
            );

            if (this.#dragState.clone === null && distance >= PlayingCard.#dragThreshold) {
                this.#startDrag();
            }

            if (this.#dragState.clone !== null) {
                event.preventDefault();
                this.#moveDrag(event.clientX, event.clientY);
                this.#updateDiscardTarget(event.clientX, event.clientY);
            }
        }
    };

    /**
     * Finishes an active pointer interaction.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    #handlePointerUp = event => {
        if (event.pointerId === this.#dragState.pointerId) {
            const didDrag = this.#dragState.clone !== null;

            if (didDrag) {
                this.#dispatchDrop(event.clientX, event.clientY);
            }

            this.#resetDrag(didDrag);
        }
    };

    /**
     * Cancels an active pointer interaction.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    #handlePointerCancel = event => {
        if (event.pointerId === this.#dragState.pointerId) {
            this.#resetDrag(false);
        }
    };

    /**
     * Creates the visual drag clone.
     */
    #startDrag() {
        const clone = this.cloneNode(true);

        if (!(clone instanceof HTMLElement)) {
            throw new Error("Playing-card drag clone is invalid.");
        }

        clone.dataset.dragClone = "true";
        clone.dataset.isDragging = "false";

        this.#dragState.clone = clone;
        this.dataset.isDragging = "true";

        this.#moveDrag(this.#dragState.startX, this.#dragState.startY);
        document.body.appendChild(clone);
    }

    /**
     * Moves the visual drag clone.
     *
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     */
    #moveDrag(clientX, clientY) {
        const clone = this.#dragState.clone;

        if (clone !== null) {
            clone.style.left = `${clientX - this.#dragState.offsetX}px`;
            clone.style.top = `${clientY - this.#dragState.offsetY}px`;
        }
    }

    /**
     * Updates discard-target hover state.
     *
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     */
    #updateDiscardTarget(clientX, clientY) {
        const target = PlayingCard.#discardTarget;
        const clone = this.#dragState.clone;

        if (target !== null) {
            const isOver = PlayingCard.#containsPoint(target, clientX, clientY);
            const wasOver = target.dataset.isDragOver === "true";

            target.dataset.isDragOver = String(isOver);

            if (clone !== null) {
                clone.style.transform = isOver ? "rotate(0deg)" : "rotate(2deg)";
            }

            if (isOver && !wasOver) {
                target.dispatchEvent(new CustomEvent("drag_over", {
                    bubbles: true
                }));
            } else if (!isOver && wasOver) {
                target.dispatchEvent(new CustomEvent("drag_leave", {
                    bubbles: true
                }));
            }
        }
    }

    /**
     * Dispatches a card-drop event when released over the discard target.
     *
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     */
    #dispatchDrop(clientX, clientY) {
        const target = PlayingCard.#discardTarget;

        if (target !== null && PlayingCard.#containsPoint(target, clientX, clientY)) {
            target.dispatchEvent(new CustomEvent("card_drop", {
                bubbles: true,
                detail: {
                    card: this.getCard(),
                    source: this,
                    target
                }
            }));
        }
    }

    /**
     * Clears the active drag and target state.
     *
     * @param {boolean} didDrag - Whether the interaction became a drag.
     */
    #resetDrag(didDrag) {
        const target = PlayingCard.#discardTarget;
        const pointerId = this.#dragState.pointerId;

        this.#unbindDragEvents();

        if (target !== null && target.dataset.isDragOver === "true") {
            target.dataset.isDragOver = "false";
            target.dispatchEvent(new CustomEvent("drag_leave", {
                bubbles: true
            }));
        }

        if (this.#dragState.clone !== null) {
            this.#dragState.clone.remove();
        }

        if (this.#dragHandle !== null && pointerId !== null && this.#dragHandle.hasPointerCapture(pointerId)) {
            this.#dragHandle.releasePointerCapture(pointerId);
        }

        if (PlayingCard.#activeCard === this) {
            PlayingCard.#activeCard = null;
        }

        this.dataset.isDragging = "false";
        this.#dragState.clone = null;
        this.#dragState.pointerId = null;
        this.#dragState.startX = 0;
        this.#dragState.startY = 0;
        this.#dragState.offsetX = 0;
        this.#dragState.offsetY = 0;
        this.#dragState.didDrag = didDrag;

        this.#clearDragResetTimeout();

        if (didDrag) {
            this.#dragResetTimeoutId = window.setTimeout(function () {
                this.#dragState.didDrag = false;
                this.#dragResetTimeoutId = null;
            }.bind(this), 0);
        }
    }

    /**
     * Stops tracking the active pointer outside the card.
     */
    #unbindDragEvents() {
        document.removeEventListener("pointermove", this.#handlePointerMove);
        document.removeEventListener("pointerup", this.#handlePointerUp);
        document.removeEventListener("pointercancel", this.#handlePointerCancel);
    }

    /**
     * Clears the pending click-suppression timeout.
     */
    #clearDragResetTimeout() {
        if (this.#dragResetTimeoutId !== null) {
            window.clearTimeout(this.#dragResetTimeoutId);
            this.#dragResetTimeoutId = null;
        }
    }

    /**
     * Updates the accessible card description.
     */
    #updateAccessibility() {
        if (this.hasAttribute("data-decorative")) {
            this.removeAttribute("aria-label");
            return;
        }

        const value = this.dataset.value ?? "";
        const suit = this.dataset.suit ?? "";
        const identity = value ? `${value} of ${suit}` : suit;
        const face = this.isFaceDown() ? "face down" : "face up";

        this.setAttribute("aria-label", `${identity}, ${face}`);
    }

    /**
     * Checks whether a viewport point is inside an element.
     *
     * @param {HTMLElement} element - Element bounds to inspect.
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     * @returns {boolean} True when the point is inside.
     */
    static #containsPoint(element, clientX, clientY) {
        const bounds = element.getBoundingClientRect();

        return clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
    }

    /**
     * Normalizes playing-card model data.
     *
     * Suit-only cards are allowed; value-only cards are not.
     *
     * @param {*} card - Card model.
     * @returns {{value:string,suit:string}} Normalized card.
     * @throws {Error}
     */
    static #normalizeCard(card) {
        const source = NormalizeUtils.object(card, "Card");
        const suit = NormalizeUtils.requiredString(source.suit, "Card.suit").toLowerCase();
        let value = "";

        if (source.value !== undefined && source.value !== null && source.value !== "") {
            value = NormalizeUtils.requiredString(source.value, "Card.value").toLowerCase();
        }

        return {value, suit};
    }
}

if (!customElements.get(PlayingCard.elementName)) {
    customElements.define(PlayingCard.elementName, PlayingCard);
}
