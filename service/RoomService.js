"use strict";

import { Room } from "../model/Room.js";
import { Match } from "../model/Match.js";
import { Knockout } from "../model/Knockout.js";
import { Constants } from "../shared/Constants.js";
import { ValidationUtils } from "../shared/ValidationUtils.js";
import { UserNotification } from "../shared/UserNotification.js";
import { Player } from "../model/Player.js";
import { Card } from "../model/Card.js";
import { BotPlayer } from "../model/BotPlayer.js";
import { IdleMonitor } from "./IdleMonitor.js";

/** Coordinates serialized room workflows, activity monitoring, and publication. */
export class RoomService {

    /** @type {number} Default number of cards dealt to each player. */
    static INITIAL_ITEM_COUNT = 7;

    /** @type {Promise<*>} Tail of serialized room mutations. */
    #operationQueue = Promise.resolve();

    /** @type {number} Monotonic game-mutation revision for delayed-decision validation. */
    #revision = 0;

    /** @type {AbortController} Cancels delayed work from a previous match or disposed room. */
    #automation = new AbortController();

    /** @type {boolean} Whether this workflow has permanently released its resources. */
    #disposed = false;

    // ---- Construction and queries ----

    /** @type {Room} Authoritative room state; never duplicated in the service. */
    #room;

    /** @type {Function|null} Host callback after a committed room mutation. */
    onAnyChange = null;

    /** @type {Function|null} Host callback when an eligible human becomes idle. */
    onPlayerIdle = null;

    /** @type {IdleMonitor} Timers owned by this room workflow. */
    #idleMonitor = new IdleMonitor();

    /**
     * Creates one service and its exclusively owned room model.
     * @param {string} roomName - Validated display name.
     * @param {number} playerLimit - Maximum seated players.
     */
    constructor(roomName, playerLimit = Constants.ROOM_PLAYER_LIMIT) {
        this.#room = new Room(roomName, playerLimit);
    }

    /** @returns {Room} Authoritative model; the service reference cannot be replaced. */
    get room() {
        return this.#room;
    }

    /** @returns {number} Latest game-mutation revision, independent of viewer-only changes. */
    get revision() {
        return this.#revision;
    }

    /** @returns {AbortSignal} Identity and cancellation signal of the current match's automation. */
    get automationSignal() {
        return this.#automation.signal;
    }

    /** @returns {boolean} Whether the room workflow has closed permanently. */
    get isDisposed() {
        return this.#disposed;
    }

    /** Stops delayed work, monitors, and publication when the room leaves its Host. */
    dispose() {
        this.#disposed = true;
        this.#automation.abort();
        this.stopIdleMonitoring();
        this.onAnyChange = null;
        this.onPlayerIdle = null;
    }

    /**
     * Revalidates a delayed bot command inside the same queue as human commands.
     * @param {Player} player - Exact seated bot object that scheduled the action.
     * @param {AbortSignal} signal - Captured match generation and cancellation signal.
     * @param {string} command - Selected legal game command.
     * @param {Object} data - Command payload.
     * @param {number} revision - Game state against which the delayed decision was scheduled.
     * @returns {Promise<void>} Completion; obsolete actions have no effect.
     */
    async performBotCommand(player, signal, command, data, revision = this.#revision) {
        await this.#enqueue(function botOperation() {
            if (signal === this.automationSignal && revision === this.#revision &&
                this.room.isMatchActive() && this.room.match.turnOrder.owner === player) {
                this.#perform(command, player.name, data);
            }
        }.bind(this), signal);
    }

    /** Cancels all player idle timers during room closure or Host shutdown. */
    stopIdleMonitoring() {
        this.#idleMonitor.clear();
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
        if (!this.#disposed && normalizedTabId.length > 0) {
            const previousViewerCount = this.room.viewers.size;

            this.room.viewers.add(normalizedTabId);
            if (this.room.viewers.size > previousViewerCount) {
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
        if (!this.#disposed && normalizedTabId.length > 0) {
            if (this.room.viewers.delete(normalizedTabId)) {
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
        return this.#enqueue(
            /** Adds a player as one serialized room mutation. */
            function joinOperation() {
                const normalizedViewerKey = RoomService.#optionalText(viewerKey);

                if (this.room.isMatchActive()) {
                    throw new UserNotification("Room already in progress.");
                }
                if (this.room.match instanceof Knockout && !this.room.match.isKnockoutComplete) {
                    throw new UserNotification("Players cannot join a knockout after it starts.");
                }
                if (this.room.isFull()) {
                    throw new UserNotification("Room is full.");
                }
                if (normalizedViewerKey && !this.room.viewers.has(normalizedViewerKey)) {
                    throw new UserNotification("Viewer not found.");
                }

                const player = isAutomated ? new BotPlayer(playerName) : new Player(playerName, { drawAllowance: 1 });

                this.room.match.turnOrder.add(player);
                this.room.viewers.delete(normalizedViewerKey);
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
        return this.#enqueue(function restoreOperation() {
            if (!(this.room.match instanceof Knockout) || !this.room.match.isKnockoutComplete) {
                return;
            }
            const names = this.room.match.lostBotNames;
            while (names.length > 0) {
                const player = new BotPlayer(names[0]);
                if (this.room.isFull() || this.room.hasPlayer(player.key)) {
                    throw new UserNotification("Bot cannot return to this room yet.");
                }
                player.state = Constants.PLAYER_STATE.LOST;
                this.room.match.turnOrder.add(player);
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
        return this.#enqueue(
            /** Initializes the Pick 2 match inside the room queue. */
            function startOperation() {
                const isKnockout = this.#beforeStartMatch(knockout);
                this.#automation.abort();
                this.#automation = new AbortController();
                let eliminated = [];
                if (this.room.match instanceof Knockout && this.room.match.nextMatchAvailable) {
                    eliminated = this.room.match.prepareNextMatch();
                } else {
                    this.room.match = isKnockout ? new Knockout(this.room.match.turnOrder) : new Match(this.room.match.turnOrder);
                }

                this.room.match.resetMatchState();
                this.#dealInitialItem();
                this.#dealInitialHands();
                this.#selectRandomFirstPlayer();
                this.room.match.state = Constants.ROOM_STATE.ACTIVE;
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
        return this.#enqueue(this.#resumeWaiting.bind(this));
    }

    /**
     * Resumes an ordinary finished match and executes its command in one queue slot.
     * @param {string} command - Canonical command.
     * @param {string} playerName - Acting player's name.
     * @param {Object} data - Command payload.
     * @returns {Promise<*>} Action result.
     */
    async perform(command, playerName, data = {}) {
        return this.#enqueue(this.#perform.bind(this, command, playerName, data));
    }

    /**
     * Serializes a legal draw, applies allowances, sorts the hand, and advances state when required.
     *
     * @param {string} playerName - Player name.
     * @param {string} sortKey - The sort key.
     * @returns {Promise<Card[]>} Drawn items.
     */
    async drawItems(playerName, sortKey = "none") {
        return this.#enqueue(this.#drawItems.bind(this, playerName, sortKey));
    }

    /**
     * Serializes a legal pass, commits hand order, and advances to the next player.
     *
     * @param {string} playerName - Player name.
     * @param {string} sortKey - Items sort order keyword
     * @returns {Promise<Card[]>} Items drawn while passing.
     */
    async passTurn(playerName, sortKey = "none") {
        return this.#enqueue(this.#passTurn.bind(this, playerName, sortKey));
    }

    /**
     * Serializes a legal discard, applies card effects, and advances or finishes the match.
     *
     * @param {string} playerName - Player name.
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {string} sortKey - Items sort order keyword
     * @returns {Promise<void>} Completion of the discard.
     */
    async playItem(playerName, value, suit, sortKey = "none") {
        return this.#enqueue(this.#playItem.bind(this, playerName, value, suit, sortKey));
    }

    /**
     * Resolves the pending wild-card decision and advances to the next player.
     *
     * @param {string} suit - Declared suit.
     * @param {string|null} playerName - Requesting player; null is reserved for trusted internal callers.
     * @returns {Promise<void>}
     */
    async declareSuit(suit, playerName = null) {
        return this.#enqueue(this.#declareSuit.bind(this, suit, playerName));
    }

    // ---- Queued command implementations ----

    /** Resolves completed-match lifecycle and the requested command as one queued operation. */
    #perform(command, playerName, data) {
        if (this.room.match.state === Constants.ROOM_STATE.FINISHED) {
            if (this.room.match instanceof Knockout) {
                throw new UserNotification(this.room.match.isKnockoutComplete
                    ? "The knockout has finished." : "Wait for the next knockout match.");
            }
            this.#resumeWaiting();
        }
        switch (command) {
            case Constants.COMMANDS.DRAW:
                return this.#drawItems(playerName, data.sortKey);
            case Constants.COMMANDS.PASS:
                return this.#passTurn(playerName, data.sortKey);
            case Constants.COMMANDS.DISCARD: {
                const card = Card.from(data.card);
                return this.#playItem(playerName, card.value, card.suit, data.sortKey);
            }
            case Constants.COMMANDS.DECLARE:
                return this.#declareSuit(data.suit, ValidationUtils.requiredString(playerName, "Player name"));
            default:
                throw new UserNotification("Unknown match command.");
        }
    }

    /** Preserves final hands while clearing ordinary completed-match control state. */
    #resumeWaiting() {
        const canResume = this.room.match.state === Constants.ROOM_STATE.FINISHED &&
            !(this.room.match instanceof Knockout);

        if (canResume) {
            this.room.match.state = Constants.ROOM_STATE.WAITING;
            this.room.match.pending = null;
            this.room.match.declaredSuit = null;
            this.room.match.turnOrder.setOwner(null);

            this.#publishMutation();
        }
    }

    /** Checks the turn and allowance before drawing and applying draw-attack progression. */
    #drawItems(playerName, sortKey = "none") {
        let drawnItems = [];

        if (this.room.match.state !== Constants.ROOM_STATE.FINISHED) {
            const player = this.#prepareCardAction(playerName, sortKey);

            const usesPlayingRules =
                this.room.match.state === Constants.ROOM_STATE.ACTIVE && this.room.match.turnOrder.ownerKey !== null;
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
    }

    /** Consumes any remaining draw allowance and hands control to the next player. */
    #passTurn(playerName, sortKey = "none") {
        const drawnItems = [];

        if (this.room.match.state !== Constants.ROOM_STATE.FINISHED) {
            const player = this.#prepareCardAction(playerName, sortKey);

            if (this.room.match.state === Constants.ROOM_STATE.ACTIVE && this.room.match.turnOrder.ownerKey !== null) {
                const remainingDrawAllowance = Math.max(0, player.drawAllowance);

                if (remainingDrawAllowance > 0) {
                    drawnItems.push(...this.#drawItemsForPlayer(player, remainingDrawAllowance));
                }

                player.drawAllowance = 0;
                this.#advanceTurn(1, 1);
            }

            this.#publishMutation();
        }
        return drawnItems;
    }

    /** Validates ownership and legality before transferring the card and applying effects. */
    #playItem(playerName, value, suit, sortKey = "none") {
        if (this.room.match.state !== Constants.ROOM_STATE.FINISHED) {
            const item = new Card(value, suit);
            const player = this.#prepareCardAction(playerName, sortKey);
            this.#assertPlayerHasItem(player, item);
            this.#assertItemIsPlayable(item);

            this.#applyDiscard(player, item);


            this.#publishMutation();
        }

    }

    /** Resolves a suit decision only for its current owner before advancing the turn. */
    #declareSuit(suit, playerName = null) {
        if (this.room.match.state !== Constants.ROOM_STATE.FINISHED) {
            if (this.room.match.pending?.command !== Constants.COMMANDS.DECLARE) {
                throw new UserNotification("No suit pending declaration.");
            }

            const player = this.room.match.turnOrder.requireOwner();
            if (playerName !== null && this.room.match.turnOrder.get(playerName)?.key !== player.key) {
                throw new UserNotification("Not your turn.");
            }
            this.room.match.declaredSuit = RoomService.normalizeSuit(suit);
            this.room.match.pending = null;
            this.room.match.state = Constants.ROOM_STATE.ACTIVE;

            this.#advanceTurn(1, 1);

            this.#publishMutation();
        }
    }

    // ---- Activity and serialized mutations ----

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
     * @param {AbortSignal|null} signal - Optional delayed-work cancellation signal.
     * @returns {Promise<*>} Operation result.
     */
    #enqueue(operation, signal = null) {
        const result = this.#operationQueue.then(function executeCurrentOperation() {
            if (!signal?.aborted) {
                if (this.#disposed) throw new UserNotification("Room is closed.");
                return operation();
            }
        }.bind(this));
        this.#operationQueue = result.catch(function ignoreFailure() {});
        return result;
    }

    /** Refreshes the eligible human timers; models never schedule callbacks. */
    #refreshIdleMonitoring() {
        const eligible = [];
        const awaitingKnockout = this.room.match.state === Constants.ROOM_STATE.FINISHED && this.room.match.nextMatchAvailable;
        for (const player of this.room.match.turnOrder.players.values()) {
            const shouldTrack = !(player instanceof BotPlayer) &&
                (!awaitingKnockout || player.state === Constants.PLAYER_STATE.QUALIFIED) &&
                (!this.room.isMatchActive() || player.key === this.room.match.turnOrder.ownerKey);
            if (shouldTrack) eligible.push(player);
        }
        this.#idleMonitor.refresh(eligible, this.onPlayerIdle);
    }

    /**
     * Returns a departing player’s cards to the draw collection and reshuffles it.
     * @param {Card[]} items - Released cards.
     */
    #storeReleasedItems(items) {
        this.room.match.collections.draw.addMany(items);
        this.room.match.collections.draw.shuffle();
    }

    /** Records a mutation, refreshes eligible idle timers, and publishes room state. */
    #publishMutation(refreshIdle = true) {
        this.room.lastActiveAt = Date.now();
        if (refreshIdle) {
            this.#revision += 1;
            this.#refreshIdleMonitoring();
        }
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
        return this.#enqueue(
            /** Removes a player as one serialized room mutation. */
            function removeOperation() {
                const player = this.room.match.turnOrder.get(playerNameOrKey);
                const wasKnockoutDuel = this.room.match instanceof Knockout && this.room.isMatchActive() &&
                    this.room.match.turnOrder.players.size === 2;
                const items = player.collection?.clear() ?? [];
                this.#idleMonitor.stop(player);
                this.room.match.turnOrder.remove(player.key);
                this.#storeReleasedItems(items);
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
        if (this.room.isMatchActive()) {
            if (this.room.match.turnOrder.players.size < 2) {
                if (wasKnockoutDuel) {
                    const survivor = this.room.match.turnOrder.players.values().next().value;
                    this.room.match.finishByForfeit(survivor, player);
                } else {
                    this.room.match.resetMatchState();
                }
            } else {
                const isTurnOwnerRemoved =
                    this.room.match.turnOrder.ownerKey === null || this.room.match.turnOrder.ownerKey === player.key;

                if (isTurnOwnerRemoved) {
                    this.#advanceTurn(1, 1);
                }
            }
        }

        if (this.room.match instanceof Knockout) this.room.match.afterPlayerRemoved();

        const normalizedViewerKey = RoomService.#optionalText(viewerKey);
        if (normalizedViewerKey) this.room.viewers.add(normalizedViewerKey);
        this.#publishMutation();
    }

    // ---- Match preparation and turn control ----

    /** Validates the selected or continuing match type inside the Room queue. */
    #beforeStartMatch(knockout) {
        if (this.room.isMatchActive()) {
            throw new UserNotification("Match already active.");
        }
        if (this.room.match.turnOrder.players.size < 2) {
            throw new UserNotification("Need at least two players.");
        }
        if (knockout !== null && typeof knockout !== "boolean") {
            throw new UserNotification("Choose whether to start a knockout.");
        }
        if (this.room.match instanceof Knockout && this.room.match.nextMatchAvailable && knockout === false) {
            throw new UserNotification("Finish the current knockout first.");
        }
        if (this.room.match instanceof Knockout && this.room.match.isKnockoutComplete && knockout === null) {
            throw new UserNotification("Choose a new game to play.");
        }
        return knockout ?? (this.room.match instanceof Knockout);
    }

    /**
     * Deals initial hands to all players.
     */
    #dealInitialHands() {
        const totalNeeded = this.room.match.turnOrder.players.size * RoomService.INITIAL_ITEM_COUNT;

        this.#ensureDeckCapacity(totalNeeded);
        this.room.match.disperseItems("draw", RoomService.INITIAL_ITEM_COUNT);
    }

    /**
     * Pushes the initial discard item.
     */
    #dealInitialItem() {
        this.#ensureDeckCapacity(1);

        const items = [...this.room.match.collections.draw];
        let ordinaryItem = null;

        for (const item of items) {
            if (!item.isSpecial()) {
                ordinaryItem = item;
                break;
            }
        }
        const selectedItem = ordinaryItem ?? items[items.length - 1];
        this.room.match.moveItem("draw", "play", selectedItem);
    }

    /**
     * Picks a random first player.
     */
    #selectRandomFirstPlayer() {
        const playerKeys = Array.from(this.room.match.turnOrder.players.keys());
        const randomIndex = Math.floor(Math.random() * playerKeys.length);

        this.room.match.turnOrder.setOwner(playerKeys[randomIndex]);
    }

    /**
     * Advances the turn to the next player.
     *
     * @param {number} drawAllowance - Draw allowance for the next player.
     * @param {number} steps - Number of players to advance.
     */
    #advanceTurn(drawAllowance = 1, steps = 1) {
        const moved = this.room.match.turnOrder.move(steps);

        if (moved) {
            const player = this.room.match.turnOrder.requireOwner();

            player.drawAllowance = drawAllowance;

        }
    }

    // ---- Card rules and draw collection ----

    /**
     * Resolves and validates the acting player before committing the requested hand order.
     * @param {string} playerName - Seated player identity.
     * @param {string} sortKey - Requested hand order.
     * @returns {Player} Validated player for draw, pass, or discard.
     */
    #prepareCardAction(playerName, sortKey) {
        const player = this.room.match.turnOrder.get(playerName);
        this.#assertCanAct(player);
        player.collection.sort(sortKey);
        return player;
    }

    /**
     * Asserts a player can perform the requested command.
     *
     * @param {Player|null} player - Acting player.
     */
    #assertCanAct(player) {
        if (player === null || player === undefined) {
            throw new UserNotification(`Player not found.`);
        }

        if (this.room.match.pending !== null) {
            throw new UserNotification("Room is waiting for suit declaration.");
        }

        const isAnotherPlayersTurn =
            this.room.match.state === Constants.ROOM_STATE.ACTIVE &&
            this.room.match.turnOrder.ownerKey !== null && this.room.match.turnOrder.ownerKey !== player.key;

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
        const ownsItem = player.collection.items.some(function sameCard(playerItem) {
            return playerItem.value === item.value && playerItem.suit === item.suit;
        });
        if (!ownsItem) {
            throw new UserNotification("Item " + item.id + " is no longer in your collection.");
        }
    }

    /**
     * Asserts a item can legally be played.
     *
     * @param {Card} item - Card to check.
     */
    #assertItemIsPlayable(item) {
        const usesPlayingRules =
            this.room.match.state === Constants.ROOM_STATE.ACTIVE && this.room.match.turnOrder.ownerKey !== null;

        if (usesPlayingRules) {
            const turnOwner = this.room.match.turnOrder.requireOwner();
            const drawAllowance = turnOwner.drawAllowance;
            const isLegal = item.isLegalOn(this.room.match.getTopItem(), this.room.match.declaredSuit, drawAllowance);

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
        this.room.match.putItem(player.key, "play", item);

        if (this.room.match.state === Constants.ROOM_STATE.ACTIVE) {
            this.room.match._lastDiscardPlayerKey = player.key;
            player.drawAllowance = 0;
            this.room.match.declaredSuit = null;

            if (item.isMatchEndingMove(player.collection.items.length)) {
                this.room.match.finishMatch();
            } else if (item.isSuitChange()) {
                this.room.match.pending = { command: Constants.COMMANDS.DECLARE, playerKey: player.key };
            } else {
                const playerCount = this.room.match.turnOrder.players.size;

                if (item.isSkip(playerCount)) {
                    this.#advanceTurn(1, 2);
                } else if (item.isReverse(playerCount)) {
                    this.room.match.turnOrder.reverse();
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
        return this.room.match.takeItems(player.key, "draw", count);
    }

    /**
     * Ensures the deck has enough items.
     *
     * @param {number} needed - Number of items needed.
     */
    #ensureDeckCapacity(needed) {
        if (this.room.match.collections.draw.items.length < needed) {
            this.#refillDrawCollection();
        }

        if (this.room.match.collections.draw.items.length < needed) {
            throw new Error("Not enough items in deck.");
        }
    }

    /**
     * Refills the deck from the discard pile.
     */
    #refillDrawCollection() {
        if (this.room.match.collections.play.items.length > 1) {
            const topItem = this.room.match.collections.play.take();
            const refillItems = this.room.match.collections.play.clear();

            this.room.match.collections.draw.addMany(refillItems);
            this.room.match.collections.draw.shuffle();
            this.room.match.collections.play.add(topItem);
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

}
