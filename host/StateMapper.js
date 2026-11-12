"use strict";

import { Constants } from "../shared/Constants.js";

/** Maps Pick2 state into immutable transport objects. */
export class StateMapper {
    // ---- Transport envelopes ----

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
     * Maps a committed card action to its public notification without exposing drawn cards.
     * @param {string} command - Completed card command.
     * @param {Object} data - Validated action payload.
     * @param {import("../model/Card.js").Card[]|undefined} result - Drawn cards, if returned.
     * @param {string} matchState - Lifecycle state after the action.
     * @returns {Object} Frozen action notification.
     */
    static toActionMessage(command, data, result, matchState) {
        const action = Constants.ACTION_NOTIFICATIONS[command.toUpperCase()];
        let title = action.title;
        let message = action.message;
        if (command === Constants.COMMANDS.DISCARD) {
            message = message.replace("{value}", data.card.value).replace("{suit}", data.card.suit);
        } else if ((command === Constants.COMMANDS.DRAW || command === Constants.COMMANDS.PASS) && result.length > 0) {
            title = Constants.ACTION_NOTIFICATIONS.CARDS_ADDED.title.replace("{number}", result.length);
            message = Constants.ACTION_NOTIFICATIONS.CARDS_ADDED.message.replace("{cards}", result.length === 1 ? "Card" : "Cards");
            if (command === Constants.COMMANDS.PASS || (matchState === Constants.ROOM_STATE.ACTIVE && result.length > 1)) {
                message += ` ${Constants.EMOJIS.silly.random}`;
            }
        }
        return this.toMessage(action.status, title, message);
    }

    // ---- Home and Room snapshots ----

    /**

     * Maps a room registry to the Home directory payload.
     * @param {Iterable<import("../model/Room.js").Room>} rooms - Registered Rooms.
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
     * @param {import("../model/Room.js").Room|Object} source - Room or serialized state.
     * @returns {Object} Public Room summary.
     */
    static toRoomInfo(source) {
        const room = typeof source?.toJSON === "function" ? source.toJSON() : (source ?? {});
        const match = room.match ?? {};
        const playerCount = match.turnOrder?.playerCount;

        return Object.freeze({
            name: room.name,
            match: Object.freeze({
                state: match.state,
                isKnockout: match.isKnockout === true,
                turnOrder: Object.freeze({
                    playerCount: Number.isInteger(playerCount) ? playerCount : StateMapper.collectionCount(match.turnOrder?.players)
                })
            }),
            playerLimit: room.playerLimit,
            viewers: StateMapper.collectionCount(room.viewers),
            lastActiveAt: StateMapper.formatDate(room.lastActiveAt),
            createdAt: StateMapper.formatDate(room.createdAt)
        });
    }

    /**

     * Maps a complete Room model to the immutable player-specific transport snapshot.
     * @param {import("../model/Room.js").Room} room - Authoritative Room.
     * @param {string|null} playerName - Recipient's seated Player name.
     * @returns {Object} Recipient-specific Room data.
     */
    static toRoomData(room, playerName) {
        const state = room.toJSON();
        return Object.freeze({
            localPlayerName: playerName,
            ...StateMapper.toRoomInfo(state),
            match: Object.freeze({
                state: state.match.state,
                turnOrder: StateMapper.#toTurnOrder(state.match, playerName),
                collections: Object.freeze({
                    play: Object.freeze({ items: StateMapper.#toPlayedCards(state.match) }),
                    draw: Object.freeze({
                        itemCount: Array.isArray(state.match.collections?.draw?.items) ? state.match.collections.draw.items.length : 0
                    })
                }),
                isKnockout: state.match.isKnockout === true,
                isKnockoutComplete: state.match.isKnockoutComplete === true,
                nextMatchAvailable: state.match.nextMatchAvailable === true,
                pending: state.match.pending ?? null,
                declaredSuit: state.match.declaredSuit ?? null
            }),
        });
    }

    // ---- Player and card snapshots ----

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

     * Maps ordered players and the public turn cursor without leaking domain internals.
     * @param {Object} state - Serialized Room state.
     * @param {string|null} playerName - Recipient whose own hand may be exposed.
     * @returns {Object} Public turn order.
     */
    static #toTurnOrder(state, playerName) {
        return Object.freeze({
            players: StateMapper.#toPlayers(state, playerName),
            playerCount: state.turnOrder?.playerCount ?? 0,
            ownerKey: state.turnOrder?.ownerKey ?? null,
            direction: state.turnOrder?.direction ?? 1
        });
    }

    /**

     * Maps public player state and counts, exposing cards and penalty only to their owner until the match finishes.
     * @param {Object} state - Serialized Room state.
     * @param {string|null} playerName - Recipient whose own hand may be exposed.
     * @returns {Object[]} Recipient-specific Player records.
     */
    static #toPlayers(state, playerName) {
        const players = Array.isArray(state.turnOrder?.players) ? state.turnOrder.players : [];
        return players.map(function mapPlayer(player) {
            const collection = player.collection ?? {};
            const canSeeHand = player.name === playerName || state.state === Constants.ROOM_STATE.FINISHED;
            return Object.freeze({
                key: player.key,
                name: player.name,
                collection: Object.freeze({
                    items: canSeeHand ? StateMapper.#toCards(collection.items) : [],
                    itemCount: StateMapper.collectionCount(collection.items),
                    penalty: canSeeHand ? collection.penalty : null
                }),
                drawAllowance: player.drawAllowance,
                state: player.state
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

    // ---- Snapshot value normalization ----

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
}
