"use strict";

import { Constants } from "./Constants.js";

/** Maps Pick2 state into immutable transport objects. */
export class StateMapper {
    /**
     * Builds the transport response envelope.
     * @param {string|null} view - Destination view.
     * @param {Object|null} message - Optional notification.
     * @param {Object|null} data - Authoritative state snapshot.
     * @returns {Object} Frozen response.
     */
    static toResponse(view, message, data) {
        return Object.freeze({ view, message, data });
    }

    /**

     * Builds an immutable user-notification payload.
     * @param {string} status - Notification status.
     * @param {string} title - Notification title.
     * @param {string} message - Notification detail.
     * @returns {Object} Frozen notification.
     */
    static toMessage(status, title, message) {
        return Object.freeze({ status, title, message });
    }

    /**

     * Maps a room registry to the Home directory payload.
     * @param {Iterable<import("./Room.js").Room>} rooms - Registered Rooms.
     * @returns {Object} Frozen Home data.
     */
    static toHomeData(rooms) {
        return Object.freeze({
            rooms: Array.from(rooms, function mapRoom(room) {
                return StateMapper.toRoomInfo(room);
            })
        });
    }

    /**

     * Maps room identity, lifecycle, membership, and activity fields.
     * @param {import("./Room.js").Room|Object} source - Room or serialized state.
     * @returns {Object} Public Room summary.
     */
    static toRoomInfo(source) {
        const room = typeof source?.toJSON === "function" ? source.toJSON() : (source ?? {});
        const actorCount = room.turnOrder?.actorCount;

        return Object.freeze({
            name: room.name,
            state: room.state,
            turnOrder: Object.freeze({
                actorCount: Number.isInteger(actorCount)
                    ? actorCount
                    : StateMapper.collectionCount(room.turnOrder?.actors)
            }),
            actorLimit: room.actorLimit,
            viewers: StateMapper.collectionCount(room.viewers),
            lastActiveAt: StateMapper.formatDate(room.lastActiveAt),
            createdAt: StateMapper.formatDate(room.createdAt)
        });
    }

    /**

     * Counts arrays, sets, maps, serialized collections, or numeric counts.
     * @param {*} value - Collection or count.
     * @returns {number} Public count.
     */
    static collectionCount(value) {
        if (Number.isFinite(value)) return value;
        if (Number.isInteger(value?.size)) return value.size;
        return Array.isArray(value) ? value.length : 0;
    }

    /**

     * Formats a timestamp as ISO text, or returns an empty string when invalid.
     * @param {*} value - Date-compatible timestamp.
     * @returns {string} ISO timestamp or empty text.
     */
    static formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }

    /**

     * Maps a complete Room model to the immutable actor-specific transport snapshot.
     * @param {import("./Room.js").Room} room - Authoritative Room.
     * @param {string|null} actorName - Recipient's seated Actor name.
     * @returns {Object} Recipient-specific Room data.
     */
    static toRoomData(room, actorName) {
        const state = room.toJSON();
        return Object.freeze({
            localActorName: actorName,
            ...StateMapper.toRoomInfo(state),
            turnOrder: StateMapper.#toTurnOrder(state),
            collections: Object.freeze({
                play: Object.freeze({ items: StateMapper.#toPlayedCards(state) }),
                draw: Object.freeze({
                    itemCount: Array.isArray(state.collections?.draw?.items) ? state.collections.draw.items.length : 0
                })
            }),
            winners: Array.isArray(state.winners) ? [...state.winners] : [],
            pending: state.pending ?? null,
            declaredSuit: state.declaredSuit ?? null
        });
    }

    /**

     * Maps public play items and appends a suit-only declaration marker when active.
     * @param {Object} state - Serialized Room state.
     * @returns {Object[]} Public play cards.
     */
    static #toPlayedCards(state) {
        const cards = StateMapper.#toCards(state.collections?.play?.items);
        if (state.declaredSuit !== null) {
            cards.push(Object.freeze({ suit: state.declaredSuit, rotation: 0 }));
        }
        return cards;
    }

    /**

     * Maps ordered actors and the public turn cursor without leaking domain internals.
     * @param {Object} state - Serialized Room state.
     * @returns {Object} Public turn order.
     */
    static #toTurnOrder(state) {
        return Object.freeze({
            actors: StateMapper.#toActors(state),
            actorCount: state.turnOrder?.actorCount ?? 0,
            ownerKey: state.turnOrder?.ownerKey ?? null,
            direction: state.turnOrder?.direction ?? 1
        });
    }

    /**

     * Maps actor identity, public state, collection data, and draw allowance.
     * @param {Object} state - Serialized Room state.
     * @returns {Object[]} Public Actor records.
     */
    static #toActors(state) {
        const actors = Array.isArray(state.turnOrder?.actors) ? state.turnOrder.actors : [];
        return actors.map(function mapActor(actor) {
            const collection = actor.collection ?? {};
            return Object.freeze({
                key: actor.key,
                name: actor.name,
                collection: Object.freeze({
                    items: StateMapper.#toCards(collection.items),
                    penalty: collection.penalty,
                    sortKey: collection.sortKey ?? Constants.CARD.SORT_OPTIONS[0]
                }),
                drawAllowance: actor.drawAllowance,
                state: actor.state
            });
        });
    }

    /**

     * Maps card-like values to immutable transport-safe card records.
     * @param {Object[]|undefined} cards - Serialized cards.
     * @returns {Object[]} Public card records.
     */
    static #toCards(cards) {
        if (!Array.isArray(cards)) return [];
        return cards.map(function mapCard(card) {
            return Object.freeze({
                value: card.value,
                suit: card.suit,
                rank: card.rank,
                rotation: card.rotation
            });
        });
    }
}
