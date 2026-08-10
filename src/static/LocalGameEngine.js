"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { AIPlayer } from "../core/Player.js";
import { Room } from "../core/Room.js";
import { StateMapper } from "../core/StateMapper.js";

/**
 * Runs one self-contained Pick 2 table entirely inside the browser.
 *
 * The engine owns one human seat and the AI seats configured in shared
 * constants. It exposes the same action vocabulary as the original network
 * client, but never opens a socket or persists state outside the current page.
 */
export class LocalGameEngine {
    /** @type {Room|null} */
    #room = null;

    /** @type {string|null} */
    #playerName = null;

    /** @type {string|null} */
    #departedPlayerName = null;

    /** @type {boolean} */
    #isBusy = false;

    /** @type {number} */
    #operationId = 0;

    /** @type {Function|null} */
    #stateHandler = null;

    /**
     * Registers a callback that receives each browser-safe room snapshot.
     *
     * @param {Function|null} handler - Snapshot callback.
     */
    set onStateChange(handler) {
        this.#stateHandler = typeof handler === "function" ? handler : null;
    }

    /**
     * Gets whether an action or AI turn is currently running.
     *
     * @returns {boolean} True while the table is resolving an action.
     */
    get isBusy() {
        return this.#isBusy;
    }

    /**
     * Gets the local player's display name.
     *
     * @returns {string|null} The occupied human seat, if any.
     */
    get playerName() {
        return this.#playerName;
    }

    /**
     * Creates a fresh waiting table with the configured AI opponents.
     *
     * @returns {Promise<Object>} Initial room snapshot.
     */
    async reset() {
        this.#operationId += 1;
        this.#isBusy = false;
        this.#stopIdleMonitoring();

        if (this.#room !== null) {
            this.#room.onAnyChange = null;
        }

        this.#playerName = null;
        this.#departedPlayerName = null;
        const room = new Room("AI Table", Constants.ROOM_MAX_CAPACITY);

        this.#room = room;
        room.onAnyChange = function () {
            this.#emitState(room);
        }.bind(this);

        for (const name of Constants.STATIC_OPPONENT_NAMES) {
            await room.admitPlayer(name, true);
        }

        this.#stopIdleMonitoring();
        return this.snapshot();
    }

    /**
     * Removes the browser user while allowing an active AI game to continue.
     *
     * @returns {Promise<Object>} Settled room snapshot.
     */
    async leave() {
        this.#requireRoom();

        if (this.#playerName === null) {
            throw new Error("The local seat is not occupied.");
        }

        const room = this.#room;
        const playerName = this.#playerName;
        const operationId = ++this.#operationId;

        this.#isBusy = true;
        this.#emitState(room);

        try {
            if (room.status === Constants.STATUS.FINISHED) {
                await room.stopGame();
            }

            await this.#resolvePendingSuitBeforeLeaving(room, playerName);
            await room.evictPlayer(playerName);

            if (this.#isCurrentOperation(room, operationId)) {
                this.#playerName = null;
                this.#departedPlayerName = room.isGameActive() ? playerName : null;
                this.#emitState(room);
                await this.#runAutomatedTurns(room, operationId);

                if (
                    this.#isCurrentOperation(room, operationId) &&
                    room.status === Constants.STATUS.FINISHED &&
                    this.#departedPlayerName !== null
                ) {
                    await room.stopGame();

                    if (!room.isPlayerPresent(playerName)) {
                        await room.admitPlayer(playerName, false);
                    }

                    this.#playerName = playerName;
                    this.#departedPlayerName = null;
                }
            }
        } finally {
            if (this.#isCurrentOperation(room, operationId)) {
                this.#isBusy = false;
                this.#stopIdleMonitoring(room);
                this.#emitState(room);
            }
        }

        return this.snapshot();
    }

    /**
     * Stops autonomous play on the existing table and restores the local seat.
     *
     * @returns {Promise<Object>} Waiting room snapshot.
     */
    async stop() {
        this.#requireRoom();

        if (this.#departedPlayerName === null) {
            throw new Error("There is no autonomous game to stop.");
        }

        const room = this.#room;
        const playerName = this.#departedPlayerName;
        const operationId = ++this.#operationId;

        this.#isBusy = true;

        try {
            await room.stopGame();

            if (this.#isCurrentOperation(room, operationId)) {
                if (!room.isPlayerPresent(playerName)) {
                    await room.admitPlayer(playerName, false);
                }

                this.#playerName = playerName;
                this.#departedPlayerName = null;
            }
        } finally {
            if (this.#isCurrentOperation(room, operationId)) {
                this.#isBusy = false;
                this.#stopIdleMonitoring(room);
                this.#emitState(room);
            }
        }

        return this.snapshot();
    }

    /**
     * Occupies the fourth seat with the browser user.
     *
     * @param {string} name - Player display name.
     * @returns {Promise<Object>} Updated room snapshot.
     */
    async join(name) {
        this.#requireRoom();

        if (this.#playerName !== null) {
            throw new Error("The local seat is already occupied.");
        }

        const normalizedName = NormalizeUtils.requiredString(name, "Player name");
        const player = await this.#room.admitPlayer(normalizedName, false);

        this.#playerName = player.name;
        this.#departedPlayerName = null;
        this.#stopIdleMonitoring();
        this.#emitState();

        return this.snapshot();
    }

    /**
     * Applies one local-player action, then resolves consecutive AI turns.
     *
     * @param {string} type - Action identifier from {@link Constants.ACTIONS}.
     * @param {Object} [payload={}] - Action data.
     * @param {string} [sortKey="none"] - Local hand sort key.
     * @returns {Promise<Object>} Settled room snapshot.
     */
    async act(type, payload = {}, sortKey = Constants.CARD.SORT_OPTIONS[0]) {
        this.#requireRoom();

        if (this.#isBusy) {
            throw new Error("Please wait for the current turn to finish.");
        }

        if (this.#playerName === null) {
            throw new Error("Join the table before playing.");
        }

        const room = this.#room;
        const operationId = ++this.#operationId;

        this.#isBusy = true;
        this.#emitState(room);

        try {
            await this.#applyHumanAction(type, payload, sortKey);
            await this.#runAutomatedTurns(room, operationId);
        } finally {
            if (this.#isCurrentOperation(room, operationId)) {
                this.#isBusy = false;
                this.#stopIdleMonitoring(room);
                this.#emitState(room);
            }
        }

        return this.snapshot();
    }

    /**
     * Returns a UI-ready immutable room snapshot.
     *
     * @returns {Object} Current table state.
     */
    snapshot() {
        this.#requireRoom();

        return Object.freeze({
            ...StateMapper.toRoomPayload(this.#room, this.#playerName),
            canStop: this.#departedPlayerName !== null,
            isBusy: this.#isBusy
        });
    }

    /**
     * Applies one action on behalf of the human player.
     *
     * @param {string} type - Action type.
     * @param {Object} payload - Action payload.
     * @param {string} sortKey - Hand sort key.
     * @returns {Promise<void>}
     */
    async #applyHumanAction(type, payload, sortKey) {
        if (type === Constants.ACTIONS.START_GAME) {
            await this.#room.startGame();
        } else if (type === Constants.ACTIONS.DRAW_CARD) {
            await this.#room.drawCards(this.#playerName, sortKey);
        } else if (type === Constants.ACTIONS.PASS_PLAYER) {
            await this.#room.passTurn(this.#playerName, sortKey);
        } else if (type === Constants.ACTIONS.DISCARD_CARD) {
            const card = NormalizeUtils.object(payload.card, "Card");
            await this.#room.discardCard(this.#playerName, card.value, card.suit, sortKey);
        } else if (type === Constants.ACTIONS.SUIT_CHANGE) {
            await this.#room.declareSuit(payload.suit);
        } else {
            throw new Error(`Unsupported local action: ${type}.`);
        }
    }

    /**
     * Continues play until the turn reaches the human or the game ends.
     *
     * @returns {Promise<void>}
     */
    async #runAutomatedTurns(room, operationId) {
        let actionCount = 0;

        while (this.#isCurrentOperation(room, operationId) && room.isGameActive()) {
            const player = room.circle.getTurnOwner();

            if (!(player instanceof AIPlayer)) {
                break;
            }

            actionCount += 1;

            if (actionCount > 250) {
                throw new Error("The AI turn limit was exceeded.");
            }

            this.#emitState(room);

            if (room.status === Constants.STATUS.PENDING) {
                await player.chooseSuit(room);
            } else {
                await player.takeTurn(room);
            }
        }
    }

    /**
     * Completes a departing human's required suit choice before removing them.
     *
     * @param {Room} room - Active room.
     * @param {string} playerName - Departing player name.
     * @returns {Promise<void>}
     */
    async #resolvePendingSuitBeforeLeaving(room, playerName) {
        const player = room.circle.getPlayer(playerName);
        const isPendingForPlayer = room.status === Constants.STATUS.PENDING &&
            room.circle.turnOwnerKey === player.key;

        if (isPendingForPlayer) {
            const suits = [
                Constants.CARD.SUIT.HEARTS,
                Constants.CARD.SUIT.DIAMONDS,
                Constants.CARD.SUIT.CLUBS,
                Constants.CARD.SUIT.SPADES
            ];
            const counts = Object.fromEntries(suits.map((suit) => [suit, 0]));

            for (const card of player.hand.cards) {
                if (counts[card.suit] !== undefined) {
                    counts[card.suit] += 1;
                }
            }

            const suit = suits.reduce(function (bestSuit, candidateSuit) {
                return counts[candidateSuit] > counts[bestSuit] ? candidateSuit : bestSuit;
            });

            await room.declareSuit(suit);
        }
    }

    /**
     * Checks whether an asynchronous game operation still owns the current table.
     *
     * @param {Room} room - Operation room.
     * @param {number} operationId - Operation token.
     * @returns {boolean} Whether the operation is current.
     */
    #isCurrentOperation(room, operationId) {
        return this.#room === room && this.#operationId === operationId;
    }

    /**
     * Emits the latest state to the registered listener.
     */
    #emitState(room = this.#room) {
        if (room !== null && room === this.#room && this.#stateHandler !== null) {
            this.#stateHandler(this.snapshot());
        }
    }

    /**
     * Disables server-era inactivity handling for this single-page table.
     */
    #stopIdleMonitoring(room = this.#room) {
        if (room !== null) {
            for (const player of room.circle.players.values()) {
                player.stopIdleMonitoring();
            }
        }
    }

    /**
     * Ensures the table has been initialized.
     */
    #requireRoom() {
        if (this.#room === null) {
            throw new Error("The local table has not been initialized.");
        }
    }
}
