// server/StateMapper.js

"use strict";

import { Constants } from "../public/scripts/Constants.js";

/**
 * Maps server domain state to client-ready payloads.
 */
export class StateMapper {
    /**
     * Builds a full server response.
     *
     * @param {string|null} view - View to render.
     * @param {Object|null} message - Message payload.
     * @param {Object|null} sync - View sync payload.
     * @returns {{view:string|null,message:Object|null,sync:Object|null}} Server response.
     */
    static toResponse(view = null, message = null, sync = null) {
        return Object.freeze({
            [Constants.RESPONSE_KEYS.VIEW]: view,
            [Constants.RESPONSE_KEYS.MESSAGE]: message,
            [Constants.RESPONSE_KEYS.SYNC]: sync
        });
    }

    /**
     * Builds message payload.
     *
     * @param {string} status - Message status.
     * @param {string} title - Message title.
     * @param {string} message - Message text.
     * @returns {{status:string,title:string,message:string}} Message payload.
     */
    static toMessage(status, title, message) {
        return Object.freeze({
            status,
            title,
            message
        });
    }

    /**
     * Builds a LobbyController-ready payload.
     *
     * @param {Iterable<import("./Room.js").Room>} rooms - Rooms.
     * @returns {{rooms:Object[]}} Lobby payload.
     */
    static toLobbyPayload(rooms) {
        const result = [];

        for (const room of rooms) {
            const state = room.toJSON();

            result.push(StateMapper.#toLobbyRoom(state));
        }

        return Object.freeze({
            rooms: result
        });
    }

    /**
     * Builds discard pile DTOs.
     *
     * @param {Object} state - Serialized room state.
     * @returns {Object[]} Discard pile DTOs.
     */
    static #toDiscardPile(state) {
        const cards = StateMapper.#toCards(state.discardPile);

        if (state.declaredSuit !== null) {
            cards.push(Object.freeze({
                suit: state.declaredSuit,
                rotation: 0
            }));
        }

        return cards;
    }

    /**
     * Builds a RoomController-ready payload.
     *
     * @param {import("./Room.js").Room} room - Room.
     * @param {string|null} playerName - Session player name.
     * @returns {Object} Room payload.
     */
    static toRoomPayload(room, playerName = null) {
        room.setSessionPlayer(playerName);

        const state = room.toJSON();

        return Object.freeze({
            ...StateMapper.#toRoomInfo(state),
            ...StateMapper.#toRoomGameplay(state)
        });
    }

    /**
     * Builds one lobby room DTO.
     *
     * @param {Object} state - Serialized room state.
     * @returns {Object} Lobby room DTO.
     */
    static #toLobbyRoom(state) {
        return Object.freeze({
            name: state.name,
            status: state.status,
            playerCount: state.circle?.playerCount ?? 0,
            visitorCount: StateMapper.#getCollectionCount(state.visitors),
            capacity: state.capacity,
            lastActiveAt: StateMapper.#formatDate(state.lastActiveAt),
            createdAt: StateMapper.#formatDate(state.createdAt)
        });
    }

    /**
     * Builds room identity/session/info DTO fields.
     *
     * @param {Object} state - Serialized room state.
     * @returns {Object} Room info DTO.
     */
    static #toRoomInfo(state) {
        return Object.freeze({
            session: state.session,

            name: state.name,
            status: state.status,

            playerCount: state.circle?.playerCount ?? 0,
            visitorCount: StateMapper.#getCollectionCount(state.visitors),
            capacity: state.capacity,

            lastActiveAt: StateMapper.#formatDate(state.lastActiveAt),
            createdAt: StateMapper.#formatDate(state.createdAt)
        });
    }

    /**
     * Builds room gameplay DTO fields.
     *
     * @param {Object} state - Serialized room state.
     * @returns {Object} Room gameplay DTO.
     */
    static #toRoomGameplay(state) {
        return Object.freeze({
            circle: StateMapper.#toCircle(state),
            discardPile: StateMapper.#toDiscardPile(state),

            deckCount: Array.isArray(state.deck?.cards) ? state.deck.cards.length : 0,
            winners: Array.isArray(state.winners) ? [...state.winners] : [],
            scores: StateMapper.#toScores(state.scores),

            isAwaitingSuit: state.isAwaitingSuit === true,
            declaredSuit: state.declaredSuit ?? null
        });
    }

    /**
     * Builds the browser-safe player-circle shape.
     *
     * Field names match the server-side circle; only collection and player values are
     * converted into JSON-safe representations.
     *
     * @param {Object} state - Serialized room state.
     * @returns {Object} Player circle DTO.
     */
    static #toCircle(state) {
        return Object.freeze({
            players: StateMapper.#toPlayers(state),
            playerCount: state.circle?.playerCount ?? 0,
            turnOwnerKey: state.circle?.turnOwnerKey ?? null,
            direction: state.circle?.direction ?? 1
        });
    }

    /**
     * Builds player DTOs.
     *
     * @param {Object} state - Serialized room state.
     * @returns {Object[]} Player DTOs.
     */
    static #toPlayers(state) {
        const players = [];
        const source = Array.isArray(state.circle?.players)
            ? state.circle.players
            : [];

        for (const player of source) {
            const hand = player.hand;
            const cards = StateMapper.#toCards(hand.cards);

            players.push(Object.freeze({
                key: player.key,
                name: player.name,
                hand: Object.freeze({
                    cards,
                    score: hand.score,
                    sortKey: hand.sortKey ?? Constants.CARD.SORT_OPTIONS[0]
                }),
                drawAllowance: player.drawAllowance,
                isWinner: player.isWinner === true
            }));
        }

        return players;
    }

    /**
     * Builds card DTOs.
     *
     * @param {*} cards - Serialized cards.
     * @returns {Object[]} Card DTOs.
     */
    static #toCards(cards) {
        const result = [];

        if (Array.isArray(cards)) {
            for (const card of cards) {
                result.push(Object.freeze({
                    value: card.value,
                    suit: card.suit,
                    score: card.score,
                    rotation: card.rotation
                }));
            }
        }

        return result;
    }

    /**
     * Builds score map.
     *
     * @param {*} scores - Scores value.
     * @returns {Object} Score map.
     */
    static #toScores(scores) {
        const result = {};

        if (typeof scores === "object" && scores !== null && !Array.isArray(scores)) {
            for (const [name, score] of Object.entries(scores)) {
                result[name] = score;
            }
        }

        return Object.freeze(result);
    }

    /**
     * Gets collection count from serialized arrays or count values.
     *
     * @param {*} value - Collection value.
     * @returns {number} Collection count.
     */
    static #getCollectionCount(value) {
        let count = 0;

        if (Array.isArray(value)) {
            count = value.length;
        } else if (typeof value === "number" && Number.isFinite(value)) {
            count = value;
        }

        return count;
    }

    /**
     * Formats a timestamp.
     *
     * @param {*} value - Timestamp value.
     * @returns {string} Formatted date.
     */
    static #formatDate(value) {
        const date = new Date(value);

        return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }
}
