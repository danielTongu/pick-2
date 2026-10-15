"use strict";

import { Serializable } from "./Serializable.js";
import { Constants } from "./Constants.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { UserNotification } from "./UserNotification.js";
import { Player } from "./Player.js";
import { TurnOrder } from "./TurnOrder.js";
import { CardCollection } from "./CardCollection.js";
import { Card } from "./Card.js";
import { BotPlayer } from "./BotPlayer.js";

/** Owns a Pick2 room, its membership, and all item rules. */
export class Room extends Serializable {

    /** @type {number} Default number of cards dealt to each player. */
    static INITIAL_ITEM_COUNT = 7;

    /** @type {Promise<*>} Tail of serialized room mutations. */
    #operationQueue = Promise.resolve();

    // ---- Construction and queries ----

    /**
     * Creates a room with a given name and player limit.
     *
     * @param {string} roomName - Match room name.
     * @param {number} playerLimit - Maximum number of seated players.
     * @throws {Error} When a value violates an internal room invariant.
     */
    constructor(roomName, playerLimit = Constants.ROOM_PLAYER_LIMIT) {
        super();
        this.name = ValidationUtils.namedString(roomName, "Room name", ValidationUtils.ROOM_NAME_MAX_LENGTH);
        this.playerLimit = Room.#normalizePlayerLimit(playerLimit);
        this.match = new Match();
        this.createdAt = Date.now();
        this.lastActiveAt = this.createdAt;
        this.viewers = new Set();
        this.onAnyChange = null;
        this.onPlayerIdle = null;
    }

    /** Returns whether the room has no seated players. */
    isEmpty() {
        return this.match.turnOrder.players.size === 0;
    }

    /** Returns whether player capacity has been reached. */
    isFull() {
        return this.match.turnOrder.players.size >= this.playerLimit;
    }

    /**

     * Returns whether a normalized player identity is seated.
     * @param {string} playerNameOrKey - Player name or normalized key.
     * @returns {boolean} Whether the Player is seated.
     */
    hasPlayer(playerNameOrKey) {
        try {
            return this.match.turnOrder.has(playerNameOrKey);
        } catch (_error) {
            return false;
        }
    }

    /**
     * Returns whether turn-based play rules are currently active.
     *
     * @returns {boolean} Whether the match is active.
     */
    isMatchActive() {
        return this.match.state === Constants.ROOM_STATE.ACTIVE;
    }

    /** Serializes room identity and its nested match without duplicating match fields. */
    toJSON() {
        return {
            ...super.toJSON(null, ["match"]),
            match: {
                ...this.match.toJSON(),
                isKnockout: this.match instanceof Knockout,
                isKnockoutComplete: this.match instanceof Knockout && this.match.isKnockoutComplete
            }
        };
    }

    /**
     * Normalizes a declared suit.
     *
     * @param {*} value - Suit.
     * @returns {string} Normalized suit.
     * @throws {UserNotification} When the suit is missing or unsupported.
     */
    static normalizeSuit(value) {
        const suit = typeof value === "string" ? value.trim().toLowerCase() : "";
        if (!Constants.isStandardSuit(suit)) throw new UserNotification(`Invalid suit: ${suit}`);
        return suit;
    }

    // ---- Membership ----

    /**
     * Adds a viewer.
     *
     * @param {string} tabId - Viewer tab ID.
     */
    view(tabId) {
        const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
        let wasAdded = false;

        if (normalizedTabId.length > 0) {
            const previousViewerCount = this.viewers.size;

            this.viewers.add(normalizedTabId);
            wasAdded = this.viewers.size > previousViewerCount;

            if (wasAdded) {
                this.#publishMutation(false);
            }
        }
    }

    /**
     * Removes a viewer.
     *
     * @param {string} tabId - Viewer tab ID.
     */
    leaveViewer(tabId) {
        const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
        let wasRemoved = false;

        if (normalizedTabId.length > 0) {
            wasRemoved = this.viewers.delete(normalizedTabId);

            if (wasRemoved) {
                this.#publishMutation(false);
            }
        }
    }

    /**

     * Adds a human or automated player through the serialized operation queue.
     * @param {string} playerName - Name of the Player to seat.
     * @param {boolean} [isAutomated] - Whether the Player is a Bot.
     * @param {string|null} [viewerKey] - Viewer tab to promote, if any.
     * @returns {Promise<Player>} Added Player.
     */
    async joinPlayer(playerName, isAutomated = false, viewerKey = null) {
        return this._enqueue(
            /** Adds a player as one serialized room mutation. */
            function joinOperation() {
                const normalizedViewerKey = Room.#optionalText(viewerKey);

                if (this.isMatchActive()) {
                    throw new UserNotification("Room already in progress.");
                }
                if (this.match instanceof Knockout && !this.match.isKnockoutComplete) {
                    throw new UserNotification("Players cannot join a knockout after it starts.");
                }
                if (this.isFull()) {
                    throw new UserNotification("Room is full.");
                }
                if (normalizedViewerKey && !this.viewers.has(normalizedViewerKey)) {
                    throw new UserNotification("Viewer not found.");
                }

                const player = isAutomated ? new BotPlayer(playerName) : new Player(playerName, { drawAllowance: 1 });

                this.match.turnOrder.add(player);
                this.viewers.delete(normalizedViewerKey);
                this.#publishMutation();
                return player;
            }.bind(this)
        );
    }

    /**

     * Removes a seated player and releases its items.
     * @param {string} playerNameOrKey - Player name or normalized key.
     * @returns {Promise<Player>} Removed Player.
     */
    async removePlayer(playerNameOrKey) {
        return this.#removePlayer(playerNameOrKey, null);
    }

    /**

     * Removes a player and registers the same client as a viewer.
     * @param {string} playerNameOrKey - Player name or normalized key.
     * @param {string} viewerKey - Viewer tab to register.
     * @returns {Promise<Player>} Removed Player.
     */
    async movePlayerToView(playerNameOrKey, viewerKey) {
        return this.#removePlayer(playerNameOrKey, viewerKey);
    }

    /**
     * Repopulates the completed knockout's retained bot names as lost players.
     * @returns {Promise<void>} Resolves when retained bots are restored.
     */
    async restoreLostBots() {
        return this._enqueue(function restoreOperation() {
            if (!(this.match instanceof Knockout) || !this.match.isKnockoutComplete) {
                return;
            }
            const names = this.match.lostBotNames;
            while (names.length > 0) {
                const player = new BotPlayer(names[0]);
                if (this.isFull() || this.hasPlayer(player.key)) {
                    throw new UserNotification("Bot cannot return to this room yet.");
                }
                player.state = Constants.PLAYER_STATE.LOST;
                this.match.turnOrder.add(player);
                names.shift();
                this.#publishMutation();
            }
        }.bind(this));
    }

    // ---- Match lifecycle and commands ----

    /**
     * Starts a match in the room.
     *
     * @param {boolean|null} knockout - Initial Knockout choice, or null to continue.
     * @returns {Promise<Player[]>} Eliminated players removed when advancing a knockout.
     */
    async startMatch(knockout = null) {
        return this._enqueue(
            /** Initializes the Pick 2 match inside the room queue. */
            function startOperation() {
                const isKnockout = this.#beforeStartMatch(knockout);
                let eliminated = [];
                if (this.match instanceof Knockout && this.match.nextMatchAvailable) {
                    eliminated = this.match.prepareNextMatch();
                } else {
                    this.match = isKnockout ? new Knockout(this.match.turnOrder) : new Match(this.match.turnOrder);
                }

                this.match.resetMatchState();
                this.match.setCollection("draw", CardCollection.createDeck(true));
                this.#dealInitialItem();
                this.#dealInitialHands();
                this.#selectRandomFirstPlayer();
                this.match.state = Constants.ROOM_STATE.ACTIVE;
                this.#publishMutation();
                return eliminated;
            }.bind(this)
        );
    }

    /**
     * Resumes waiting-state transactions after completed results were visible.
     *
     * Players, hands, the deck, and the discard pile remain unchanged.
     * Starting another match performs the separate full reset.
     *
     * @returns {Promise<void>}
     */
    async resumeWaiting() {
        return this._enqueue(
            /** Resumes waiting transactions inside the room queue. */
            function resumeWaitingOperation() {
                const wasFinished = this.match.state === Constants.ROOM_STATE.FINISHED;

                if (wasFinished) {
                    if (this.match instanceof Knockout) return;
                    this.match.state = Constants.ROOM_STATE.WAITING;
                    this.match.pending = null;
                    this.match.declaredSuit = null;
                    this.match.turnOrder.setOwner(null);

                    this.#publishMutation();
                }
            }.bind(this)
        );
    }

    /**
     * Dispatches a card command through the room's existing serialized actions.
     * The action methods remain available to existing callers and tests.
     * @param {string} command - Canonical command.
     * @param {string} playerName - Acting player's name.
     * @param {Object} data - Command payload.
     * @returns {Promise<*>} Action result.
     */
    async perform(command, playerName, data = {}) {
        switch (command) {
            case Constants.COMMANDS.DRAW:
                return this.drawItems(playerName, data.sortKey);
            case Constants.COMMANDS.PASS:
                return this.passTurn(playerName, data.sortKey);
            case Constants.COMMANDS.DISCARD: {
                const card = Card.from(data.card);
                return this.playItem(playerName, card.value, card.suit, data.sortKey);
            }
            case Constants.COMMANDS.DECLARE:
                return this.declareSuit(data.suit, ValidationUtils.requiredString(playerName, "Player name"));
            default:
                throw new UserNotification("Unknown match command.");
        }
    }

    /**
     * Serializes a legal draw, applies allowances, sorts the hand, and advances state when required.
     *
     * @param {string} playerName - Player name.
     * @param {string} sortKey - The sort key.
     * @returns {Promise<Card[]>} Drawn items.
     */
    async drawItems(playerName, sortKey = "none") {
        return this._enqueue(
            /** Draws items inside the room queue. */
            function drawItemsOperation() {
                let drawnItems = [];

                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    const player = this.match.turnOrder.get(playerName);

                    this.#assertCanAct(player);
                    player.collection.sort(sortKey);

                    const usesPlayingRules =
                        this.match.state === Constants.ROOM_STATE.ACTIVE && this.match.turnOrder.ownerKey !== null;
                    const drawCount = usesPlayingRules ? player.drawAllowance : 1;

                    if (drawCount <= 0) {
                        throw new UserNotification("No draw allowance remaining.");
                    }

                    drawnItems = this.#drawItemsForPlayer(player, drawCount);

                    if (usesPlayingRules) {
                        player.drawAllowance = 0;

                        if (drawCount > 1) {
                            this.#advanceTurn(1, 1);
                        }
                    }

                    this.#publishMutation();
                }

                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Serializes a legal pass, commits hand order, and advances to the next player.
     *
     * @param {string} playerName - Player name.
     * @param {string} sortKey - Items sort order keyword
     * @returns {Promise<Card[]>} Items drawn while passing.
     */
    async passTurn(playerName, sortKey = "none") {
        return this._enqueue(
            /** Passes the active turn inside the room queue. */
            function passTurnOperation() {
                const drawnItems = [];

                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    const player = this.match.turnOrder.get(playerName);

                    this.#assertCanAct(player);
                    player.collection.sort(sortKey);

                    if (this.match.state === Constants.ROOM_STATE.ACTIVE && this.match.turnOrder.ownerKey !== null) {
                        const remainingDrawAllowance = Math.max(0, player.drawAllowance);

                        if (remainingDrawAllowance > 0) {
                            drawnItems.push(...this.#drawItemsForPlayer(player, remainingDrawAllowance));
                        }

                        player.drawAllowance = 0;
                        this.#advanceTurn(1, 1);
                    }

                    player.recordActivity();
                    this.#publishMutation();
                }
                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Serializes a legal discard, applies card effects, and advances or finishes the match.
     *
     * @param {string} playerName - Player name.
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {string} sortKey - Items sort order keyword
     * @returns {Promise<Card[]>} Items drawn as a result.
     */
    async playItem(playerName, value, suit, sortKey = "none") {
        return this._enqueue(
            /** Discards an item inside the room queue. */
            function playItemOperation() {
                const drawnItems = [];

                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    const player = this.match.turnOrder.get(playerName);
                    const item = new Card(value, suit);

                    this.#assertCanAct(player);
                    player.collection.sort(sortKey);
                    this.#assertPlayerHasItem(player, item);
                    this.#assertItemIsPlayable(item);

                    this.#applyDiscard(player, item);
                    player.recordActivity();

                    this.#publishMutation();
                }

                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Resolves the pending wild-card decision and advances to the next player.
     *
     * @param {string} suit - Declared suit.
     * @param {string|null} playerName - Requesting player; null is reserved for trusted internal callers.
     * @returns {Promise<void>}
     */
    async declareSuit(suit, playerName = null) {
        return this._enqueue(
            /** Declares the pending suit inside the room queue. */
            function declareSuitOperation() {
                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    if (this.match.pending?.command !== Constants.COMMANDS.DECLARE) {
                        throw new UserNotification("No suit pending declaration.");
                    }

                    const player = this.match.turnOrder.requireOwner();
                    if (playerName !== null && this.match.turnOrder.get(playerName)?.key !== player.key) {
                        throw new UserNotification("Not your turn.");
                    }
                    this.match.declaredSuit = Room.normalizeSuit(suit);
                    this.match.pending = null;
                    this.match.state = Constants.ROOM_STATE.ACTIVE;

                    this.#advanceTurn(1, 1);
                    player.recordActivity();
                    this.#publishMutation();
                }

            }.bind(this)
        );
    }

    // ---- Activity and serialized mutations ----

    /**
     * Updates room activity timestamp.
     *
     * @returns {number} Last active timestamp.
     */
    recordActivity() {
        this.lastActiveAt = Date.now();
        return this.lastActiveAt;
    }

    /**
     * Notifies the host of a room state change.
     */
    notifyStateChange() {
        if (typeof this.onAnyChange === "function") {
            this.onAnyChange(this);
        }
    }

    /**

     * Serializes a room mutation behind all previously requested mutations.
     * @param {function(): *} operation - Room mutation to execute.
     * @returns {Promise<*>} Operation result.
     */
    _enqueue(operation) {
        const result = this.#operationQueue.then(operation);
        this.#operationQueue = result.catch(function ignoreFailure() {});
        return result;
    }

    /** Applies the hosted idle policy to the currently eligible human players. */
    _refreshIdleMonitoring() {
        for (const player of this.match.turnOrder.players.values()) {
            const isBot = player instanceof BotPlayer;
            const awaitingKnockout = this.match.state === Constants.ROOM_STATE.FINISHED && this.match.nextMatchAvailable;
            const shouldTrack = !isBot && (!awaitingKnockout || player.state === Constants.PLAYER_STATE.QUALIFIED) &&
                (!this.isMatchActive() || player.key === this.match.turnOrder.ownerKey);

            if (shouldTrack) {
                player.onIdle = function handleIdle(idlePlayer) {
                    if (typeof this.onPlayerIdle === "function") this.onPlayerIdle(idlePlayer.name);
                }.bind(this);
                player.recordActivity();
            } else {
                player.stopIdleMonitoring();
            }
        }
    }

    /**

     * Returns a departing player’s cards to the draw collection and reshuffles it.
     * @param {Card[]} items - Released cards.
     */
    _storeReleasedItems(items) {
        this.match.collections.draw.addMany(items);
        this.match.collections.draw.shuffle();
    }

    /** Records a mutation, refreshes eligible idle timers, and publishes room state. */
    #publishMutation(refreshIdle = true) {
        this.recordActivity();
        if (refreshIdle) this._refreshIdleMonitoring();
        this.notifyStateChange();
    }

    // ---- Membership transitions ----

    /**

     * Serializes player removal, item recovery, viewer conversion, activity, and publication.
     * @param {string} playerNameOrKey - Player name or normalized key.
     * @param {string|null} viewerKey - Viewer tab to register, if any.
     * @returns {Promise<Player>} Removed Player.
     */
    async #removePlayer(playerNameOrKey, viewerKey) {
        return this._enqueue(
            /** Removes a player as one serialized room mutation. */
            function removeOperation() {
                const player = this.match.turnOrder.get(playerNameOrKey);
                const wasKnockoutDuel = this.match instanceof Knockout && this.isMatchActive() &&
                    this.match.turnOrder.players.size === 2;
                const items = player.collection?.clear() ?? [];
                player.stopIdleMonitoring();
                this.match.turnOrder.remove(player.key);
                this._storeReleasedItems(items);
                this.#afterPlayerRemoved(player, viewerKey, wasKnockoutDuel);
                return player;
            }.bind(this)
        );
    }

    /**

     * Restores a valid match or turn state after a player leaves.
     * @param {Player} player - Departing Player.
     * @param {string|null} viewerKey - Viewer tab to register, if any.
     * @param {boolean} wasKnockoutDuel - Whether a departure ended an active one-on-one.
     */
    #afterPlayerRemoved(player, viewerKey, wasKnockoutDuel) {
        if (this.isMatchActive()) {
            if (this.match.turnOrder.players.size < 2) {
                if (wasKnockoutDuel) {
                    const survivor = this.match.turnOrder.players.values().next().value;
                    this.match.finishByForfeit(survivor, player);
                } else {
                    this.match.resetMatchState();
                }
            } else {
                const isTurnOwnerRemoved =
                    this.match.turnOrder.ownerKey === null || this.match.turnOrder.ownerKey === player.key;

                if (isTurnOwnerRemoved) {
                    this.#advanceTurn(1, 1);
                }
            }
        }

        if (this.match instanceof Knockout) this.match.afterPlayerRemoved();

        const normalizedViewerKey = Room.#optionalText(viewerKey);
        if (normalizedViewerKey) this.viewers.add(normalizedViewerKey);
        this.#publishMutation();
    }

    // ---- Match preparation and turn control ----

    /** Validates the selected or continuing match type inside the Room queue. */
    #beforeStartMatch(knockout) {
        this.#assertMatchNotStarted();
        this.#assertMinimumPlayerCount();
        if (knockout !== null && typeof knockout !== "boolean") {
            throw new UserNotification("Choose whether to start a knockout.");
        }
        if (this.match instanceof Knockout && this.match.nextMatchAvailable && knockout === false) {
            throw new UserNotification("Finish the current knockout first.");
        }
        if (this.match instanceof Knockout && this.match.isKnockoutComplete && knockout === null) {
            throw new UserNotification("Choose a new game to play.");
        }
        return knockout ?? (this.match instanceof Knockout);
    }

    /**
     * Asserts the room is not already active.
     */
    #assertMatchNotStarted() {
        if (this.isMatchActive()) {
            throw new UserNotification("Match already active.");
        }
    }

    /**
     * Asserts the room has enough players to start a match.
     */
    #assertMinimumPlayerCount() {
        if (this.match.turnOrder.players.size < 2) {
            throw new UserNotification("Need at least two players.");
        }
    }

    /**
     * Deals initial hands to all players.
     */
    #dealInitialHands() {
        const totalNeeded = this.match.turnOrder.players.size * Room.INITIAL_ITEM_COUNT;

        this.#ensureDeckCapacity(totalNeeded);
        this.match.disperseItems("draw", Room.INITIAL_ITEM_COUNT);
    }

    /**
     * Pushes the initial discard item.
     */
    #dealInitialItem() {
        this.#ensureDeckCapacity(1);

        const items = [...this.match.collections.draw];
        let ordinaryItem = null;

        for (const item of items) {
            if (!item.isSpecial()) {
                ordinaryItem = item;
                break;
            }
        }
        const selectedItem = ordinaryItem ?? items[items.length - 1];
        this.match.moveItem("draw", "play", selectedItem);
    }

    /**
     * Picks a random first player.
     */
    #selectRandomFirstPlayer() {
        const playerKeys = Array.from(this.match.turnOrder.players.keys());
        const randomIndex = Math.floor(Math.random() * playerKeys.length);

        this.match.turnOrder.setOwner(playerKeys[randomIndex]);
    }

    /**
     * Advances the turn to the next player.
     *
     * @param {number} drawAllowance - Draw allowance for the next player.
     * @param {number} steps - Number of players to advance.
     */
    #advanceTurn(drawAllowance = 1, steps = 1) {
        const moved = this.match.turnOrder.move(steps);

        if (moved) {
            const player = this.match.turnOrder.requireOwner();

            player.drawAllowance = drawAllowance;
            player.recordActivity();
        }
    }

    // ---- Card rules and draw collection ----

    /**
     * Asserts a player can perform the requested command.
     *
     * @param {Player|null} player - Acting player.
     */
    #assertCanAct(player) {
        if (player === null || player === undefined) {
            throw new UserNotification(`Player not found.`);
        }

        if (this.match.pending !== null) {
            throw new UserNotification("Room is waiting for suit declaration.");
        }

        const isAnotherPlayersTurn =
            this.match.state === Constants.ROOM_STATE.ACTIVE &&
            this.match.turnOrder.ownerKey !== null && this.match.turnOrder.ownerKey !== player.key;

        if (isAnotherPlayersTurn) {
            throw new UserNotification("Not your turn.");
        }
    }

    /**
     * Asserts a player has an item.
     *
     * @param {Player} player - Player.
     * @param {Card} item - Card to check.
     */
    #assertPlayerHasItem(player, item) {
        for (const playerItem of player.collection) {
            if (playerItem.value === item.value && playerItem.suit === item.suit) {
                return true;
            }
        }

        throw new UserNotification("Item " + item.id + " is no longer in your collection.");
    }

    /**
     * Asserts a item can legally be played.
     *
     * @param {Card} item - Card to check.
     */
    #assertItemIsPlayable(item) {
        const usesPlayingRules =
            this.match.state === Constants.ROOM_STATE.ACTIVE && this.match.turnOrder.ownerKey !== null;

        if (usesPlayingRules) {
            const turnOwner = this.match.turnOrder.requireOwner();
            const drawAllowance = turnOwner.drawAllowance;
            const isLegal = item.isLegalOn(this.match.getTopItem(), this.match.declaredSuit, drawAllowance);

            if (!isLegal) {
                throw new UserNotification("Item " + item.id + " cannot be played.");
            }
        }
    }

    /**
     * Plays a item and applies its effects.
     *
     * @param {Player} player - Acting player.
     * @param {Card} item - Card to play.
     */
    #applyDiscard(player, item) {
        this.match.putItem(player.key, "play", item);

        if (this.match.state === Constants.ROOM_STATE.ACTIVE) {
            this.match._lastDiscardPlayerKey = player.key;
            player.drawAllowance = 0;
            this.match.declaredSuit = null;

            if (item.isMatchEndingMove(player.collection.items.length)) {
                this.match.finishMatch();
            } else if (item.isSuitChange()) {
                this.match.pending = { command: Constants.COMMANDS.DECLARE, playerKey: player.key };
            } else {
                const playerCount = this.match.turnOrder.players.size;

                if (item.isSkip(playerCount)) {
                    this.#advanceTurn(1, 2);
                } else if (item.isReverse(playerCount)) {
                    this.match.turnOrder.reverse();
                    this.#advanceTurn(1, 1);
                } else if (item.isDrawFour()) {
                    this.#advanceTurn(4, 1);
                } else if (item.isDrawTwo()) {
                    this.#advanceTurn(2, 1);
                } else {
                    this.#advanceTurn(1, 1);
                }
            }
        }
    }

    /**
     * Draws items for a player.
     *
     * @param {Player} player - Target player.
     * @param {number} count - Number of items.
     * @returns {Card[]} Drawn items.
     */
    #drawItemsForPlayer(player, count) {
        this.#ensureDeckCapacity(count);
        const items = this.match.takeItems(player.key, "draw", count);
        player.recordActivity();

        return items;
    }

    /**
     * Ensures the deck has enough items.
     *
     * @param {number} needed - Number of items needed.
     */
    #ensureDeckCapacity(needed) {
        if (this.match.collections.draw.items.length < needed) {
            this.#refillDrawCollection();
        }

        if (this.match.collections.draw.items.length < needed) {
            throw new Error("Not enough items in deck.");
        }
    }

    /**
     * Refills the deck from the discard pile.
     */
    #refillDrawCollection() {
        if (this.match.collections.play.items.length > 1) {
            const topItem = this.match.collections.play.take();
            const refillItems = this.match.collections.play.clear();

            this.match.collections.draw.addMany(refillItems);
            this.match.collections.draw.shuffle();
            this.match.collections.play.add(topItem);
        }
    }

    // ---- Input normalization ----

    /**

     * Normalizes optional external text without throwing.
     * @param {*} value - Optional input.
     * @returns {string} Trimmed text or empty text.
     */
    static #optionalText(value) {
        return typeof value === "string" ? value.trim() : "";
    }

    /**
     * Normalizes the Room player limit.
     *
     * @param {*} value - Value.
     * @returns {number} Player limit.
     * @throws {Error} When a value violates an internal room invariant.
     */
    static #normalizePlayerLimit(value) {
        const isValid = Number.isInteger(value) && value >= 2 && value <= Constants.ROOM_PLAYER_LIMIT;

        if (!isValid) {
            throw new UserNotification(`Limit must be between 2 and ${Constants.ROOM_PLAYER_LIMIT}.`);
        }

        return value;
    }
}



/** Owns one ordinary match's cards, turn order, lifecycle, and outcome. */
export class Match extends Serializable {

    /** @type {string[]|null} Lost bot names; ordinary matches retain none. */
    lostBotNames = null;

    // ---- Construction and collection access ----

    /** Creates a waiting match using the room's existing seated players. */
    constructor(turnOrder = new TurnOrder()) {
        super();
        this.state = Constants.ROOM_STATE.WAITING;
        this.pending = null;
        this.collections = {
            draw: CardCollection.createDeck(true),
            play: new CardCollection()
        };
        this.turnOrder = turnOrder;
        this.declaredSuit = null;
        this._lastDiscardPlayerKey = null;
    }

    /** Registers a named card collection. */
    setCollection(name, collection) {
        const key = ValidationUtils.requiredString(name, "Collection name");
        ValidationUtils.instanceOf(collection, CardCollection, "Room collection");
        this.collections[key] = collection;
        return collection;
    }

    /** Returns a named card collection. */
    getCollection(name) {
        const key = ValidationUtils.requiredString(name, "Collection name");
        const collection = this.collections[key];
        if (!(collection instanceof CardCollection)) throw new Error(`Room collection does not exist: ${key}`);
        return collection;
    }

    /** Returns a discard by offset from the top. */
    getTopItem(offset = 0) {
        if (this.collections.play.items.length === 0) return null;
        const normalizedOffset = Math.abs(offset) % this.collections.play.items.length;
        const index = this.collections.play.items.length - 1 - normalizedOffset;
        return this.collections.play.items[index] ?? null;
    }

    /** Resolves the player who made the latest active-match discard. */
    getLastDiscardPlayer() {
        return this._lastDiscardPlayerKey === null
            ? null : (this.turnOrder.players.get(this._lastDiscardPlayerKey) ?? null);
    }

    // ---- Card transfers ----

    /** Transfers a card from a player into a match collection. */
    putItem(playerNameOrKey, destinationName, item) {
        const player = this.turnOrder.get(playerNameOrKey);
        const destination = this.getCollection(destinationName);
        this.#assertTransferAllowed();
        return this.#moveItem(player.collection, destination, item);
    }

    /** Transfers the top card from a match collection to a player. */
    takeItem(playerNameOrKey, sourceName) {
        const player = this.turnOrder.get(playerNameOrKey);
        const source = this.getCollection(sourceName);
        const item = source.peek();
        if (item === null) return null;
        this.#assertTransferAllowed();
        return this.#moveItem(source, player.collection, item);
    }

    /** Transfers up to a requested number of cards to a player. */
    takeItems(playerNameOrKey, sourceName, count) {
        ValidationUtils.nonNegativeInteger(count, "Item count");
        const items = [];
        for (let index = 0; index < count; index += 1) {
            const item = this.takeItem(playerNameOrKey, sourceName);
            if (item === null) break;
            items.push(item);
        }
        return items;
    }

    /** Transfers a card between match-owned collections. */
    moveItem(sourceName, destinationName, item) {
        const source = this.getCollection(sourceName);
        const destination = this.getCollection(destinationName);
        this.#assertTransferAllowed();
        return this.#moveItem(source, destination, item);
    }

    /** Deals a fixed number of cards to every player in turn order. */
    disperseItems(sourceName, count) {
        ValidationUtils.nonNegativeInteger(count, "Item count");
        const dispersed = [];
        for (let pass = 0; pass < count; pass += 1) {
            for (const player of this.turnOrder) {
                const item = this.takeItem(player.key, sourceName);
                if (item === null) return dispersed;
                dispersed.push(item);
            }
        }
        return dispersed;
    }

    // ---- Match outcomes ----

    /** Records ordinary lowest-penalty winners. */
    resolveOutcome() {
        let minimumPenalty = Infinity;
        for (const player of this.turnOrder.players.values()) {
            minimumPenalty = Math.min(minimumPenalty, player.collection.penalty);
        }
        for (const player of this.turnOrder.players.values()) {
            player.drawAllowance = 1;
            player.state = player.collection.penalty === minimumPenalty
                ? Constants.PLAYER_STATE.WON : Constants.PLAYER_STATE.LOST;
            player.recordActivity();
        }
    }

    /** Applies the shared finished-match state after outcome resolution. */
    finishMatch() {
        this.resolveOutcome();
        this.pending = null;
        this.declaredSuit = null;
        this.state = Constants.ROOM_STATE.FINISHED;
    }

    /** Resets transient match state and player hands before dealing. */
    resetMatchState() {
        this.pending = null;
        this.declaredSuit = null;
        this._lastDiscardPlayerKey = null;
        this.collections.play.clear();
        this.collections.draw = CardCollection.createDeck(true);
        this.state = Constants.ROOM_STATE.WAITING;
        this.turnOrder.reset();
        for (const player of this.turnOrder.players.values()) player.recordActivity();
    }

    // ---- Transfer validation ----

    /** Enforces card-transfer lifecycle and pending-decision rules. */
    #assertTransferAllowed() {
        if (this.state !== Constants.ROOM_STATE.WAITING && this.state !== Constants.ROOM_STATE.ACTIVE) {
            throw new UserNotification("Items cannot move after the room has finished.");
        }
        if (this.pending !== null) throw new UserNotification("Resolve the pending command first.");
    }

    /** Atomically transfers one card, restoring it to the source on failure. */
    #moveItem(source, destination, item) {
        ValidationUtils.instanceOf(source, CardCollection, "Source collection");
        ValidationUtils.instanceOf(destination, CardCollection, "Destination collection");
        const removed = source.remove(item);
        if (removed === null) {
            throw new UserNotification("Item " + (item?.id ?? item?.key ?? item) + " does not exist in the source collection.");
        }
        try {
            return destination.add(removed);
        } catch (error) {
            source.add(removed);
            throw error;
        }
    }
}



/** Applies knockout elimination between otherwise ordinary Match matches. */
export class Knockout extends Match {

    /** Adds only the continuation state needed by a knockout. */
    constructor(turnOrder = new TurnOrder()) {
        super(turnOrder);
        this.nextMatchAvailable = false;
        this.lostBotNames = [];
    }

    /** A finished knockout without two qualifiers is complete. */
    get isKnockoutComplete() {
        return this.state === Constants.ROOM_STATE.FINISHED && !this.nextMatchAvailable;
    }

    /**
     * Excludes nonqualifiers and retains lost bot names for the final return.
     * @returns {Player[]} Removed players whose memberships may need updating.
     */
    prepareNextMatch() {
        if (!this.nextMatchAvailable) return [];
        const eliminated = [];
        for (const player of [...this.turnOrder.players.values()]) {
            if (player.state !== Constants.PLAYER_STATE.QUALIFIED) {
                player.stopIdleMonitoring();
                if (player instanceof BotPlayer) this.lostBotNames.push(player.name);
                this.turnOrder.remove(player.key);
                eliminated.push(player);
            }
        }
        this.nextMatchAvailable = false;
        return eliminated;
    }

    /** Uses elimination for three or more players and ordinary results for a duel. */
    resolveOutcome() {
        if (this.turnOrder.players.size <= 2) {
            this.nextMatchAvailable = false;
            super.resolveOutcome();
            return;
        }
        let highestPenalty = -Infinity;
        for (const player of this.turnOrder.players.values()) {
            highestPenalty = Math.max(highestPenalty, player.collection.penalty);
        }
        for (const player of this.turnOrder.players.values()) {
            player.drawAllowance = 1;
            player.state = player.collection.penalty === highestPenalty
                ? Constants.PLAYER_STATE.ELIMINATED : Constants.PLAYER_STATE.QUALIFIED;
            player.recordActivity();
        }
        this.#resolveQualifiedOutcome();
    }

    /** Rechecks whether a departure leaves another match or a sole survivor. */
    afterPlayerRemoved() {
        if (this.state === Constants.ROOM_STATE.FINISHED && this.nextMatchAvailable) {
            this.#resolveQualifiedOutcome();
        }
    }

    /** Marks the remaining player as winner of an abandoned one-on-one. */
    finishByForfeit(survivor, departed) {
        survivor.state = Constants.PLAYER_STATE.WON;
        departed.state = Constants.PLAYER_STATE.LOST;
        this.state = Constants.ROOM_STATE.FINISHED;
        this.nextMatchAvailable = false;
        this.pending = null;
        this.declaredSuit = null;
    }

    /** Resolves the surviving qualified player or marks another match available. */
    #resolveQualifiedOutcome() {
        let count = 0;
        let survivor = null;
        for (const player of this.turnOrder.players.values()) {
            if (player.state === Constants.PLAYER_STATE.QUALIFIED) {
                count += 1;
                survivor = player;
            }
        }
        this.nextMatchAvailable = count >= 2;
        if (count === 1) survivor.state = Constants.PLAYER_STATE.WON;
    }
}
