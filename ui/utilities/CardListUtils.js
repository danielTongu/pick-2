import { PlayingCard } from "../PlayingCard.js";

/** Reconciles a card region without replacing cards that are still present. */
export class CardListUtils {
    /** Returns the unique value-and-suit identity of a room card. */
    static #key(card) {
        return JSON.stringify([card.value ?? "", card.suit]);
    }

    /** Indexes cards currently displayed in one region. */
    static #index(container) {
        const elements = new Map();
        for (const element of container.children) {
            if (element instanceof PlayingCard) elements.set(this.#key(element), element);
        }
        return elements;
    }

    /** Keeps a matching element when its interaction target is unchanged. */
    static #match(card, destination, existing) {
        if (existing?.destination !== destination) {
            existing?.remove();
            return PlayingCard.create(card, destination);
        }

        if (existing.dataset.rank !== String(card.rank ?? "") ||
            existing.rotation !== (card.rotation ?? null)) {
            existing.update(card);
        }
        return existing;
    }

    /** Inserts new cards and moves only elements whose order changed. */
    static #place(container, elements) {
        let next = null;
        for (let index = elements.length - 1; index >= 0; index -= 1) {
            const element = elements[index];
            if (element.parentElement !== container || element.nextElementSibling !== next) {
                container.insertBefore(element, next);
            }
            next = element;
        }
    }

    /** Updates cards in display order, preserving matching elements and their focus. */
    static update(container, cards, destination = null) {
        const existing = this.#index(container);
        const ordered = [];

        for (const card of cards) {
            const key = this.#key(card);
            ordered.push(this.#match(card, destination, existing.get(key)));
            existing.delete(key);
        }

        for (const element of existing.values()) element.remove();
        this.#place(container, ordered);
    }
}
