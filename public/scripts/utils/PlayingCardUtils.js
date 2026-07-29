// public/utils/PlayingCardUtils.js

"use strict";

import { DomUtils } from "./DomUtils.js";
import { NormalizeUtils } from "./NormalizeUtils.js";
import { TemplateComponentUtils } from "./TemplateComponentUtils.js";

/**
 * Playing card fragment.
 */
export class PlayingCardUtils extends TemplateComponentUtils {
    /** @type {HTMLTemplateElement|null} */
    static template = null;

    /** @type {string} */
    static templateFile = "playing-card.html";

    /** @type {string} */
    static templateId = "playing-card-template";

    /** @type {string} */
    static componentUrl = import.meta.url;

    /** @type {string} */
    static rootTagName = "playing-card";

    /** @type {string} */
    static #jokerImageUrl = "";

    /** @type {string|null} */
    static #dropTargetSelector = null;

    /** @type {{value:string,suit:string}|null} */
    static #dragData = null;

    /** @type {HTMLElement|null} */
    static #dragClone = null;

    /** @type {HTMLElement|null} */
    static #originalCard = null;

    /** @type {HTMLElement|null} */
    static #pendingCard = null;

    /** @type {number} */
    static #pointerDownX = 0;

    /** @type {number} */
    static #pointerDownY = 0;

    /** @type {number} */
    static #dragThreshold = 6;

    /** @type {number} */
    static #offsetX = 0;

    /** @type {number} */
    static #offsetY = 0;

    /** @type {WeakSet<HTMLElement>} */
    static #flipBoundElements = new WeakSet();

    /** @type {WeakSet<HTMLElement>} */
    static #dragBoundHandles = new WeakSet();

    /** @type {WeakSet<HTMLElement>} */
    static #draggedElements = new WeakSet();

    /**
     * Loads the playing card template and supporting assets.
     *
     * @returns {Promise<void>}
     * @throws {Error}
     */
    static async load() {
        await super.load();

        if (!PlayingCardUtils.#jokerImageUrl) {
            PlayingCardUtils.#jokerImageUrl = new URL("../../images/joker.png", import.meta.url).href;
        }
    }

    /**
     * Registers the selector used as the drag-and-drop target.
     *
     * @param {string} selector - CSS selector identifying the drop target.
     * @throws {Error}
     */
    static setDiscardDropTarget(selector) {
        const normalizedSelector = NormalizeUtils.requiredString(selector, "Drop target selector");
        DomUtils.require(normalizedSelector, HTMLElement);

        PlayingCardUtils.#dropTargetSelector = normalizedSelector;
    }

    /**
     * Updates a playing card element.
     *
     * @param {HTMLElement} element - Playing card element.
     * @param {Object} card - Card model.
     * @param {string} card.value - Card value.
     * @param {string} card.suit - Card suit.
     * @param {boolean} [card.isDiscardable=false] - Whether this card may be dropped on the discard pile.
     * @param {number} [card.rotation] - Rotation angle in degrees.
     * @throws {Error}
     */
    static updateElement(element, card = {}) {
        super.updateElement(element, card);

        const data = PlayingCardUtils.#normalizeCard(card);

        element.dataset.value = data.value;
        element.dataset.suit = data.suit;

        PlayingCardUtils.#setRotation(element, card.rotation);
        PlayingCardUtils.turnFaceUp(element);
        PlayingCardUtils.#bindFlipEvent(element);
        PlayingCardUtils.#bindDragEvents(element);
        if (card.isDiscardable === true) {
            element.dataset.discardable = "";
        } else {
            delete element.dataset.discardable;
        }
    }

    /**
     * Reads the card model from an existing playing card element.
     *
     * @param {HTMLElement} element - Playing card element.
     * @returns {{value:string,suit:string}} Card model.
     * @throws {Error}
     */
    static getCard(element) {
        PlayingCardUtils.assertRootElement(element);

        return PlayingCardUtils.#normalizeCard({
            value: element.dataset.value,
            suit: element.dataset.suit
        });
    }

    /**
     * Shows the face of a playing card.
     *
     * @param {HTMLElement} element - Playing card element.
     * @returns {HTMLElement} Updated element.
     * @throws {Error}
     */
    static turnFaceUp(element) {
        PlayingCardUtils.assertRootElement(element);

        DomUtils.setBooleanState(element, "isFaceDown", false);

        return element;
    }

    /**
     * Hides the face of a playing card.
     *
     * @param {HTMLElement} element - Playing card element.
     * @returns {HTMLElement} Updated element.
     * @throws {Error}
     */
    static turnFaceDown(element) {
        PlayingCardUtils.assertRootElement(element);

        DomUtils.setBooleanState(element, "isFaceDown", true);

        return element;
    }

    /**
     * Toggles the visible face of a playing card.
     *
     * @param {HTMLElement} element - Playing card element.
     * @throws {Error}
     */
    static toggleFace(element) {
        PlayingCardUtils.assertRootElement(element);

        if (element.dataset.isFaceDown === "true") {
            PlayingCardUtils.turnFaceUp(element);
        } else {
            PlayingCardUtils.turnFaceDown(element);
        }
    }

    /**
     * Binds click-to-flip behavior once.
     *
     * @param {HTMLElement} element - Playing card element.
     */
    static #bindFlipEvent(element) {
        if (!PlayingCardUtils.#flipBoundElements.has(element)) {
            PlayingCardUtils.#flipBoundElements.add(element);
            element.addEventListener("click", PlayingCardUtils.#onCardClick);
        }
    }

    /**
     * Configures the card's dedicated drag handle and binds pointer-down behavior once.
     *
     * @param {HTMLElement} element - Playing card element.
     * @throws {Error}
     */
    static #bindDragEvents(element) {
        PlayingCardUtils.#requireDropTarget();

        const handle = element.querySelector(".playing-card-drag-handle");

        if (!(handle instanceof HTMLElement)) {
            throw new Error("Playing card drag handle is missing.");
        }

        handle.style.touchAction = "none";
        handle.style.userSelect = "none";

        if (!PlayingCardUtils.#dragBoundHandles.has(handle)) {
            PlayingCardUtils.#dragBoundHandles.add(handle);
            handle.addEventListener("pointerdown", PlayingCardUtils.#onPointerDown);
        }
    }

    /**
     * Returns the configured drop target.
     *
     * @returns {HTMLElement} Drop target element.
     * @throws {Error}
     */
    static #requireDropTarget() {
        let target = null;

        if (PlayingCardUtils.#dropTargetSelector !== null) {
            target = DomUtils.require(PlayingCardUtils.#dropTargetSelector, HTMLElement);
        }

        if (!(target instanceof HTMLElement)) {
            throw new Error("Cannot enable drag: no valid drop target is configured.");
        }

        return target;
    }

    /**
     * Returns the configured drop target when available.
     *
     * @returns {HTMLElement|null} Drop target element.
     */
    static #getDropTarget() {
        let target = null;

        if (PlayingCardUtils.#dropTargetSelector !== null) {
            const element = document.querySelector(PlayingCardUtils.#dropTargetSelector);

            if (element instanceof HTMLElement) {
                target = element;
            }
        }

        return target;
    }

    /**
     * Handles click-to-flip interaction.
     *
     * @param {Event} event - Click event.
     */
    static #onCardClick(event) {
        const element = event.currentTarget;

        if (element instanceof HTMLElement) {
            if (PlayingCardUtils.#draggedElements.has(element)) {
                PlayingCardUtils.#draggedElements.delete(element);
                event.preventDefault();
                return;
            }

            PlayingCardUtils.toggleFace(element);
        }
    }

    /**
     * Handles pointer down on a playing card's drag handle.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    static #onPointerDown(event) {
        const handle = event.currentTarget;
        const element = handle instanceof HTMLElement
            ? handle.closest(PlayingCardUtils.rootTagName)
            : null;

        if (element instanceof HTMLElement && event.button === 0) {
            PlayingCardUtils.#pendingCard = element;
            PlayingCardUtils.#pointerDownX = event.clientX;
            PlayingCardUtils.#pointerDownY = event.clientY;

            document.addEventListener("pointermove", PlayingCardUtils.#onPointerMove);
            document.addEventListener("pointerup", PlayingCardUtils.#onPointerUp);
            document.addEventListener("pointercancel", PlayingCardUtils.#onPointerUp);
        }
    }

    /**
     * Starts dragging a playing card.
     *
     * @param {HTMLElement} element - Source playing card element.
     * @param {{clientX:number,clientY:number}} event - Pointer coordinates.
     */
    static #startDrag(element, event) {
        const rect = element.getBoundingClientRect();

        PlayingCardUtils.#originalCard = element;
        PlayingCardUtils.#offsetX = event.clientX - rect.left;
        PlayingCardUtils.#offsetY = event.clientY - rect.top;
        PlayingCardUtils.#dragData = PlayingCardUtils.getCard(element);
        PlayingCardUtils.#dragClone = PlayingCardUtils.#createDragClone(element);

        PlayingCardUtils.#updateClonePosition(event.clientX, event.clientY);

        document.body.appendChild(PlayingCardUtils.#dragClone);
        DomUtils.setBooleanState(element, "isDragging", true);

        PlayingCardUtils.#draggedElements.add(element);
    }


    /**
     * Creates the visual clone used during dragging.
     * This must be appended to the body, then enable the dragging flag of the original element.
     * Styling is already provided in card.css
     *
     * @param {HTMLElement} element - Source playing card element.
     * @returns {HTMLElement} Drag clone element.
     */
    static #createDragClone(element) {
        const clone = element.cloneNode(true);
        DomUtils.assertElement(clone);
        return clone;
    }

    /**
     * Handles pointer movement during dragging.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    static #onPointerMove(event) {
        if (PlayingCardUtils.#originalCard === null && PlayingCardUtils.#pendingCard !== null) {
            const deltaX = event.clientX - PlayingCardUtils.#pointerDownX;
            const deltaY = event.clientY - PlayingCardUtils.#pointerDownY;

            if (Math.hypot(deltaX, deltaY) < PlayingCardUtils.#dragThreshold) {
                return;
            }

            PlayingCardUtils.#startDrag(PlayingCardUtils.#pendingCard, {
                clientX: PlayingCardUtils.#pointerDownX,
                clientY: PlayingCardUtils.#pointerDownY
            });
        }

        if (PlayingCardUtils.#originalCard === null) {
            return;
        }

        event.preventDefault();
        PlayingCardUtils.#updateClonePosition(event.clientX, event.clientY);

        const dropTarget = PlayingCardUtils.#getDropTarget();

        if (dropTarget instanceof HTMLElement && PlayingCardUtils.#isOriginalCardDiscardable()) {
            PlayingCardUtils.#updateDropTargetState(dropTarget, event.clientX, event.clientY);
        } else {
            PlayingCardUtils.#clearDropTargetState(dropTarget);
        }
    }

    /**
     * Updates drop target hover state.
     *
     * @param {HTMLElement} dropTarget - Drop target element.
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     */
    static #updateDropTargetState(dropTarget, clientX, clientY) {
        const isOver = PlayingCardUtils.#isPointInside(dropTarget, clientX, clientY);

        if (PlayingCardUtils.#dragClone) {
            PlayingCardUtils.#dragClone.style.transform = isOver ? "rotate(0deg)" : "rotate(2deg)";
        }

        if (isOver && dropTarget.dataset.isDragOver !== "true") {
            DomUtils.setBooleanState(dropTarget, "isDragOver", true);
            dropTarget.dispatchEvent(new CustomEvent("drag_over", { bubbles: true }));
        } else if (!isOver && dropTarget.dataset.isDragOver === "true") {
            DomUtils.setBooleanState(dropTarget, "isDragOver", false);
            dropTarget.dispatchEvent(new CustomEvent("drag_leave", { bubbles: true }));
        }
    }

    /**
     * Handles pointer release or cancellation.
     *
     * @param {PointerEvent} event - Pointer event.
     */
    static #onPointerUp(event) {
        const dropTarget = PlayingCardUtils.#getDropTarget();

        if (PlayingCardUtils.#originalCard !== null) {
            PlayingCardUtils.#clearDropTargetState(dropTarget);
            PlayingCardUtils.#dispatchDropIfNeeded(dropTarget, event.clientX, event.clientY);
        }

        PlayingCardUtils.#resetDragState();
    }

    /**
     * Dispatches a card drop event when released over the drop target.
     *
     * @param {HTMLElement|null} dropTarget - Drop target element.
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     */
    static #dispatchDropIfNeeded(dropTarget, clientX, clientY) {
        if (dropTarget instanceof HTMLElement &&
            PlayingCardUtils.#dragData !== null &&
            PlayingCardUtils.#isOriginalCardDiscardable() &&
            PlayingCardUtils.#isPointInside(dropTarget, clientX, clientY)
        ) {
            const dropEvent = new CustomEvent("card_drop", {
                bubbles: true,
                detail: {
                    card: PlayingCardUtils.#dragData,
                    source: PlayingCardUtils.#originalCard,
                    target: dropTarget
                }
            });

            dropTarget.dispatchEvent(dropEvent);
        }
    }

    /**
     * Clears drop target hover state.
     *
     * @param {HTMLElement|null} dropTarget - Drop target element.
     */
    static #clearDropTargetState(dropTarget) {
        if (dropTarget instanceof HTMLElement && dropTarget.dataset.isDragOver === "true") {
            DomUtils.setBooleanState(dropTarget, "isDragOver", false);
            dropTarget.dispatchEvent(new CustomEvent("drag_leave", { bubbles: true }));
        }
    }

    /**
     * Checks whether a viewport point is inside an element.
     *
     * @param {HTMLElement} element - Element to check.
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     * @returns {boolean} True when the point is inside the element.
     */
    static #isPointInside(element, clientX, clientY) {
        const rect = element.getBoundingClientRect();

        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    /**
     * Checks whether the card currently being dragged may be discarded.
     *
     * @returns {boolean} True when the original card is discardable.
     */
    static #isOriginalCardDiscardable() {
        return PlayingCardUtils.#originalCard?.hasAttribute("data-discardable") === true;
    }

    /**
     * Clears the current drag state and removes drag listeners.
     */
    static #resetDragState() {
        document.removeEventListener("pointermove", PlayingCardUtils.#onPointerMove);
        document.removeEventListener("pointerup", PlayingCardUtils.#onPointerUp);
        document.removeEventListener("pointercancel", PlayingCardUtils.#onPointerUp);

        if (PlayingCardUtils.#dragClone) {
            PlayingCardUtils.#dragClone.remove();
        }

        if (PlayingCardUtils.#originalCard) {
            const draggedCard = PlayingCardUtils.#originalCard;
            DomUtils.setBooleanState(PlayingCardUtils.#originalCard, "isDragging", false);

            setTimeout(function () {
                PlayingCardUtils.#draggedElements.delete(draggedCard);
            }, 0);
        }

        PlayingCardUtils.#dragData = null;
        PlayingCardUtils.#dragClone = null;
        PlayingCardUtils.#originalCard = null;
        PlayingCardUtils.#pendingCard = null;
        PlayingCardUtils.#pointerDownX = 0;
        PlayingCardUtils.#pointerDownY = 0;
        PlayingCardUtils.#offsetX = 0;
        PlayingCardUtils.#offsetY = 0;
    }

    /**
     * Updates the drag clone viewport position.
     *
     * @param {number} clientX - Pointer X coordinate.
     * @param {number} clientY - Pointer Y coordinate.
     */
    static #updateClonePosition(clientX, clientY) {
        if (PlayingCardUtils.#dragClone) {
            PlayingCardUtils.#dragClone.style.left = `${clientX - PlayingCardUtils.#offsetX}px`;
            PlayingCardUtils.#dragClone.style.top = `${clientY - PlayingCardUtils.#offsetY}px`;
        }
    }

    /**
     * Normalizes playing card model data.
     *
     * Suit-only cards are allowed.
     * Value-only cards are not.
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

    /**
     * Applies a discard-pile rotation.
     *
     * @param {HTMLElement} element - Playing card element.
     * @param {*} rotation - Rotation angle.
     * @throws {Error}
     */
    static #setRotation(element, rotation) {
        element.style.removeProperty("--card-rotation");

        if (rotation !== undefined && rotation !== null) {
            const normalizedRotation = NormalizeUtils.number(rotation, "Card.rotation");

            element.style.setProperty("--card-rotation", `${normalizedRotation}deg`);
        }
    }
}
