
"use strict";

import { Constants } from "./Constants.js";
import { Card } from "./Card.js";
import { Deck } from "./Deck.js";
import { UserNotification } from "./UserNotification.js";
import { Serializable } from "./Serializable.js";
import { BotPlayer, Player } from "./Player.js";
import { PlayerCircle } from "./PlayerCircle.js";
import { TurnUtils } from "./TurnUtils.js";

/**
 * Owns one room and enforces the card-game rules within it.
 *
 * A room owns players and the active round. Viewers may observe without joining.
 */
export class Room extends Serializable {
    /** @type {Promise<*>} */
    #operationQueue = Promise.resolve();

    /**
     * Creates a room with a given name and player limit.
     *
     * @param {string} roomName - Match room name.
     * @param {number} playerLimit - Maximum number of players.
     * @throws {Error}
     */
    constructor(roomName, playerLimit = Constants.ROOM_PLAYER_LIMIT) {
        super();

        const now = Date.now();

        this.name = Room.#normalizeRoomName(roomName);
        this.playerLimit = Room.#normalizePlayerLimit(playerLimit);
        this.status = Constants.STATUS.WAITING;

        this.createdAt = now;
        this.lastActiveAt = now;

        this.circle = new PlayerCircle();
        this.deck = new Deck(true);
        this.discardPile = [];
        this.viewers = new Set();

        this.winners = [];
        this.scores = {};

        this.isAwaitingSuit = false;
        this.declaredSuit = null;
        this._lastDiscardPlayerKey = null;

        // Server-supplied callbacks.
        this.onAnyChange = null;
        this.onPlayerIdle = null;
    }

    /**
     * Updates room activity timestamp.
     *
     * @returns {number} Last active timestamp.
     */
    #recordActivity() {
        this.lastActiveAt = Date.now();

        return this.lastActiveAt;
    }

    /**
     * Notifies the host of a room state change.
     */
    #notifyStateChange() {
        if (typeof this.onAnyChange === "function") {
            this.onAnyChange(this);
        }
    }

    /**
     * Queues a mutation operation.
     *
     * @param {Function} operation - Operation to queue.
     * @returns {Promise<*>} Operation result.
     */
    #enqueueOperation(operation) {
        const result = this.#operationQueue.then(operation);
        this.#operationQueue = result.catch(function ignoreFailure() {});

        return result;
    }

    /**
     * Checks whether the room has no players.
     *
     * Viewers do not keep a room open.
     *
     * @returns {boolean} True when the room has no players.
     */
    isEmpty() {
        return this.circle.players.size === 0;
    }

    /**
     * Checks whether the room is playing or awaiting a required decision.
     *
     * @returns {boolean} Whether the room is active.
     */
    isActive() {
        return this.status === Constants.STATUS.PLAYING || this.status === Constants.STATUS.PENDING;
    }

    /**
     * Checks whether the current room state prevents Player changes.
     *
     * @returns {boolean} Whether membership is locked.
     */
    isMembershipLocked() {
        return this.isActive();
    }

    /**
     * Adds a viewer.
     *
     * @param {string} tabId - Viewer tab ID.
     * @returns {boolean} True when the viewer was added.
     */
    view(tabId) {
        const normalizedTabId = Room.#normalizeOptionalText(tabId);
        let wasAdded = false;

        if (normalizedTabId.length > 0) {
            const previousViewerCount = this.viewers.size;

            this.viewers.add(normalizedTabId);
            wasAdded = this.viewers.size > previousViewerCount;

            if (wasAdded) {
                this.#recordActivity();
                this.#notifyStateChange();
            }
        }

        return wasAdded;
    }

    /**
     * Removes a viewer.
     *
     * @param {string} tabId - Viewer tab ID.
     * @returns {boolean} True when the viewer was removed.
     */
    leaveViewer(tabId) {
        const normalizedTabId = Room.#normalizeOptionalText(tabId);
        let wasRemoved = false;

        if (normalizedTabId.length > 0) {
            wasRemoved = this.viewers.delete(normalizedTabId);

            if (wasRemoved) {
                this.#recordActivity();
                this.#notifyStateChange();
            }
        }

        return wasRemoved;
    }

    /**
     * Joins a human or bot player, optionally replacing an existing viewer.
     *
     * @param {string} name - Player name.
     * @param {boolean} isBot - Whether a bot controls the player.
     * @param {string|null} viewerId - Viewer to replace with the player.
     * @returns {Promise<Player>} Joined player.
     */
    async join(name, isBot = false, viewerId = null) {
        return this.#enqueueOperation(function joinOperation() {
            const normalizedViewerId = Room.#normalizeOptionalText(viewerId);

            if (normalizedViewerId.length > 0 && !this.viewers.has(normalizedViewerId)) {
                throw new UserNotification("Viewer not found.");
            }

            this.#assertMembershipUnlocked();
            this.#assertPlayerCapacityAvailable();

            const player = this.#createPlayer(name, isBot);

            this.circle.addPlayer(player);
            this.viewers.delete(normalizedViewerId);
            this.#recordActivity();
            this.#refreshPlayerIdleMonitoring();
            this.#notifyStateChange();

            return player;
        }.bind(this));
    }

    /**
     * Moves an idle player back to viewing state.
     *
     * @param {string} nameOrKey - Player name or normalized player key.
     * @param {string} tabId - Client tab ID that becomes the viewer ID.
     * @returns {Promise<Player|null>} Removed player, or null when not found.
     */
    async movePlayerToView(nameOrKey, tabId) {
        return this.#enqueueOperation(function movePlayerToViewOperation() {
            const player = this.circle.getPlayer(nameOrKey);
            const normalizedTabId = Room.#normalizeOptionalText(tabId);
            let removedPlayer = null;

            if (player !== null && normalizedTabId.length > 0) {
                this.#removePlayerAndRecycleHand(player.key);
                this.viewers.add(normalizedTabId);

                this.#refreshPlayerIdleMonitoring();
                this.#recordActivity();
                this.#notifyStateChange();

                removedPlayer = player;
            }

            return removedPlayer;
        }.bind(this));
    }

    /**
     * Removes a player from the room.
     *
     * @param {string} nameOrKey - Player name or normalized player key.
     * @returns {Promise<Player|null>} Removed player, or null when not found.
     */
    async leavePlayer(nameOrKey) {
        return this.#enqueueOperation(function leavePlayerOperation() {
            const player = this.circle.getPlayer(nameOrKey);
            let removedPlayer = null;

            if (player !== null) {
                this.#removePlayerAndRecycleHand(player.key);

                this.#refreshPlayerIdleMonitoring();
                this.#recordActivity();
                this.#notifyStateChange();

                removedPlayer = player;
            }

            return removedPlayer;
        }.bind(this));
    }

    /**
     * Creates a human or bot player.
     *
     * @param {string} name - Player name.
     * @param {boolean} isBot - Whether a bot controls the player.
     * @returns {Player} Created player.
     */
    #createPlayer(name, isBot) {
        let player;

        if (isBot) {
            player = new BotPlayer(name);
        } else {
            player = new Player(name);
        }

        return player;
    }

    /**
     * Asserts the room accepts membership-level changes.
     */
    #assertMembershipUnlocked() {
        if (this.isMembershipLocked()) {
            throw new UserNotification("Room already in progress.");
        }
    }

    /**
     * Asserts the game has players.
     */
    #assertPlayerCapacityAvailable() {
        if (this.isFull()) {
            throw new UserNotification("Room is full.");
        }
    }

    /**
     * Checks whether the game reached its player limit.
     *
     * @returns {boolean} True when full.
     */
    isFull() {
        return this.circle.players.size >= this.playerLimit;
    }

    /**
     * Refreshes idle watches for all human players.
     */
    #refreshPlayerIdleMonitoring() {
        const isTrackingOnlyTurnOwner = this.isActive() &&
            TurnUtils.hasTurnOwner(this.circle.turnOwnerKey);

        for (const player of this.circle.players.values()) {
            const isHumanPlayer = !(player instanceof BotPlayer);
            const isTrackedTurn = !isTrackingOnlyTurnOwner ||
                TurnUtils.isTurnOwner(this.circle.turnOwnerKey, player.key);
            const shouldTrack = isHumanPlayer && isTrackedTurn;

            if (shouldTrack) {
                this.#startPlayerIdleMonitoring(player);
            } else {
                player.stopIdleMonitoring();
            }
        }
    }

    /**
     * Enables automatic idle handling for a player.
     *
     * The server owns the player-to-tab relationship used for viewing state.
     *
     * @param {Player} player - Player to watch.
     */
    #startPlayerIdleMonitoring(player) {
        player.onIdle = function handleIdle(idlePlayer) {
            if (typeof this.onPlayerIdle === "function") {
                this.onPlayerIdle(this, idlePlayer.name);
            }
        }.bind(this);

        player.recordActivity();
    }

    /**
     * Removes a Player from the active room state.
     *
     * The public operation decides whether the client keeps viewing afterward.
     *
     * @param {string} nameOrKey - Player name or normalized player key.
     */
    #removePlayerAndRecycleHand(nameOrKey) {
        const player = this.circle.removePlayer(nameOrKey);
        const cards = [...player.hand];

        player.stopIdleMonitoring();
        player.hand.clear();

        this.deck.putManyTop(cards);
        this.deck.shuffle();

        if (this.isActive()) {
            if (this.circle.players.size < 2) {
                this.#resetActiveState();
            } else {
                const isTurnOwnerRemoved = !TurnUtils.hasTurnOwner(this.circle.turnOwnerKey) ||
                    TurnUtils.isTurnOwner(this.circle.turnOwnerKey, player.key);

                if (isTurnOwnerRemoved) {
                    this.#advanceTurn(1, 1);
                }
            }
        }
    }

    /**
     * Resets room state to waiting.
     */
    #resetActiveState() {
        this.winners = [];
        this.scores = {};
        this.isAwaitingSuit = false;
        this.declaredSuit = null;
        this._lastDiscardPlayerKey = null;
        this.discardPile = [];

        this.deck.reset(true);
        this.status = Constants.STATUS.WAITING;

        this.circle.reset();

        for (const player of this.circle.players.values()) {
            player.recordActivity();
        }
    }

    /**
     * Returns the active or completed room to waiting without clearing it.
     *
     * Players, hands, the deck, and the discard pile remain available in the
     * waiting state. Starting again performs the normal reset.
     *
     * @returns {Promise<boolean>} True when the room returned to waiting.
     */
    async stop() {
        return this.#enqueueOperation(function stopOperation() {
            const wasStopped = this.status !== Constants.STATUS.WAITING;

            if (wasStopped) {
                this.status = Constants.STATUS.WAITING;
                this.isAwaitingSuit = false;
                this.declaredSuit = null;
                this.circle.setTurnOwner(null);

                this.#recordActivity();
                this.#refreshPlayerIdleMonitoring();
                this.#notifyStateChange();
            }

            return wasStopped;
        }.bind(this));
    }

    /**
     * Advances the turn to the next player.
     *
     * @param {number} drawAllowance - Draw allowance for the next player.
     * @param {number} steps - Number of players to advance.
     */
    #advanceTurn(drawAllowance = 1, steps = 1) {
        const moved = this.circle.moveTurnOwner(steps);

        if (moved) {
            const player = this.circle.requireTurnOwner();

            player.drawAllowance = drawAllowance;
            player.recordActivity();
        }
    }

    /**
     * Starts a round in the room.
     *
     * @returns {Promise<boolean>} True when started.
     */
    async start() {
        return this.#enqueueOperation(function startOperation() {
            this.#assertNotStarted();
            this.#assertMinimumPlayerCount();

            this.#resetActiveState();
            this.deck.reset(true);
            this.#dealInitialDiscard();
            this.#dealInitialHands();
            this.#selectRandomFirstPlayer();

            this.status = Constants.STATUS.PLAYING;

            this.#recordActivity();
            this.#refreshPlayerIdleMonitoring();
            this.#notifyStateChange();

            return true;
        }.bind(this));
    }

    /**
     * Asserts the room is not already active.
     */
    #assertNotStarted() {
        if (this.isActive()) {
            throw new UserNotification("Room already started.");
        }
    }

    /**
     * Asserts the room has enough players to start.
     */
    #assertMinimumPlayerCount() {
        if (this.circle.players.size < 2) {
            throw new UserNotification("Need at least two players.");
        }
    }

    /**
     * Pushes the initial discard card.
     */
    #dealInitialDiscard() {
        this.#ensureDeckCapacity(1);

        const cards = [...this.deck];
        let ordinaryCard = null;

        for (const card of cards) {
            if (!card.isSpecial()) {
                ordinaryCard = card;
                break;
            }
        }
        const selectedCard = ordinaryCard ?? cards[cards.length - 1];

        this.deck.clear();

        for (const card of cards) {
            if (card !== selectedCard) {
                this.deck.putTop(card);
            }
        }

        this.discardPile.push(selectedCard);
    }

    /**
     * Ensures the deck has enough cards.
     *
     * @param {number} needed - Number of cards needed.
     */
    #ensureDeckCapacity(needed) {
        if (this.deck.cards.length < needed) {
            this.#refillDeckFromDiscardPile();
        }

        if (this.deck.cards.length < needed) {
            throw new Error("Not enough cards in deck.");
        }
    }

    /**
     * Refills the deck from the discard pile.
     */
    #refillDeckFromDiscardPile() {
        if (this.discardPile.length > 1) {
            const topCard = this.discardPile.pop();
            const refillCards = this.discardPile;

            if (topCard === undefined) {
                this.discardPile = [];
            } else {
                this.discardPile = [topCard];
            }

            this.deck.putManyTop(refillCards);
            this.deck.shuffle();
        }
    }

    /**
     * Deals initial hands to all players.
     */
    #dealInitialHands() {
        const totalNeeded = this.circle.players.size * Constants.PLAYER_INITIAL_CARD_COUNT;

        this.#ensureDeckCapacity(totalNeeded);

        for (let cardIndex = 0; cardIndex < Constants.PLAYER_INITIAL_CARD_COUNT; cardIndex += 1) {
            for (const player of this.circle.players.values()) {
                const card = this.deck.draw();

                if (card !== null && card !== undefined) {
                    player.hand.draw(card);
                }
            }
        }
    }

    /**
     * Picks a random first player.
     */
    #selectRandomFirstPlayer() {
        const playerKeys = Array.from(this.circle.players.keys());
        const randomIndex = Math.floor(Math.random() * playerKeys.length);

        this.circle.setTurnOwner(playerKeys[randomIndex]);
    }

    /**
     * Handles drawing cards.
     *
     * @param {string} playerName - Player name.
     * @param {string} sortKey - The sort key.
     * @returns {Promise<Card[]>} Drawn cards.
     */
    async drawCards(playerName, sortKey = "none") {
        return this.#enqueueOperation(function drawCardsOperation() {
            let drawnCards = [];

            if (!this.#resetFinishedRound()) {
                const player = this.circle.getPlayer(playerName);

                this.#assertCanAct(player);
                player.hand.sortBy(sortKey);

                const usesPlayingRules = this.status === Constants.STATUS.PLAYING &&
                    TurnUtils.hasTurnOwner(this.circle.turnOwnerKey);
                const drawCount = usesPlayingRules ? player.drawAllowance : 1;

                if (drawCount <= 0) {
                    throw new UserNotification("No draw allowance remaining.");
                }

                drawnCards = this.#drawCardsForPlayer(player, drawCount);

                if (usesPlayingRules) {
                    player.drawAllowance = 0;

                    if (drawCount > 1) {
                        this.#advanceTurn(1, 1);
                    }
                }

                this.#recordActivity();
                this.#refreshPlayerIdleMonitoring();
                this.#notifyStateChange();
            }

            return drawnCards;
        }.bind(this));
    }

    /**
     * Resets the room if the previous round is finished.
     *
     * @returns {boolean} True when reset.
     */
    #resetFinishedRound() {
        const shouldReset = this.status === Constants.STATUS.FINISHED;

        if (shouldReset) {
            this.#resetActiveState();
            this.#recordActivity();
            this.#notifyStateChange();
        }

        return shouldReset;
    }

    /**
     * Asserts a player can perform the requested action.
     *
     * @param {Player|null} player - Acting player.
     */
    #assertCanAct(player) {
        if (player === null || player === undefined) {
            throw new UserNotification("Player not found.");
        }

        if (this.status === Constants.STATUS.PENDING) {
            throw new UserNotification("Room is waiting for suit declaration.");
        }

        const isAnotherPlayersTurn = this.status === Constants.STATUS.PLAYING &&
            TurnUtils.hasTurnOwner(this.circle.turnOwnerKey) &&
            !TurnUtils.isTurnOwner(this.circle.turnOwnerKey, player.key);

        if (isAnotherPlayersTurn) {
            throw new UserNotification("Not your turn.");
        }
    }

    /**
     * Draws cards for a player.
     *
     * @param {Player} player - Target player.
     * @param {number} count - Number of cards.
     * @returns {Card[]} Drawn cards.
     */
    #drawCardsForPlayer(player, count) {
        this.#ensureDeckCapacity(count);

        const cards = this.deck.drawMany(count);

        player.hand.drawMany(cards);
        player.recordActivity();

        return cards;
    }

    /**
     * Handles passing the turn.
     *
     * @param {string} playerName - Player name.
     * @param {string} sortKey - Cards sort order keyword
     * @returns {Promise<Card[]>} Cards drawn while passing.
     */
    async passTurn(playerName, sortKey = "none") {
        return this.#enqueueOperation(function passTurnOperation() {
            const drawnCards = [];

            if (!this.#resetFinishedRound()) {
                const player = this.circle.getPlayer(playerName);

                this.#assertCanAct(player);
                player.hand.sortBy(sortKey);

                if (
                    this.status === Constants.STATUS.PLAYING &&
                    TurnUtils.hasTurnOwner(this.circle.turnOwnerKey)
                ) {
                    const remainingDrawAllowance = Math.max(0, player.drawAllowance);

                    if (remainingDrawAllowance > 0) {
                        drawnCards.push(...this.#drawCardsForPlayer(
                            player, remainingDrawAllowance
                        ));
                    }

                    player.drawAllowance = 0;
                    this.#advanceTurn(1, 1);
                }

                this.#recordActivity();
                this.#refreshPlayerIdleMonitoring();
                this.#notifyStateChange();
            }

            return drawnCards;
        }.bind(this));
    }

    /**
     * Handles a card discard.
     *
     * @param {string} playerName - Player name.
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {string} sortKey - Cards sort order keyword
     * @returns {Promise<Card[]>} Cards drawn as a result.
     */
    async discardCard(playerName, value, suit, sortKey = "none") {
        return this.#enqueueOperation(function discardCardOperation() {
            const drawnCards = [];

            if (!this.#resetFinishedRound()) {
                const player = this.circle.getPlayer(playerName);
                const card = new Card(value, suit);

                this.#assertCanAct(player);
                player.hand.sortBy(sortKey);
                this.#assertPlayerHasCard(player, card);
                this.#assertCardIsPlayable(card);

                this.#applyDiscard(player, card);

                this.#recordActivity();
                this.#refreshPlayerIdleMonitoring();
                this.#notifyStateChange();
            }

            return drawnCards;
        }.bind(this));
    }

    /**
     * Asserts a player has a card.
     *
     * @param {Player} player - Player.
     * @param {Card} card - Card to check.
     */
    #assertPlayerHasCard(player, card) {
        let isFound = false;

        for (const playerCard of player.hand) {
            const isValueMatch = playerCard.value === card.value;
            const isSuitMatch = playerCard.suit === card.suit;

            if (isValueMatch && isSuitMatch) {
                isFound = true;
                break;
            }
        }

        if (!isFound) {
            throw new UserNotification("That card is no longer in your hand.");
        }
    }

    /**
     * Asserts a card can legally be played.
     *
     * @param {Card} card - Card to check.
     */
    #assertCardIsPlayable(card) {
        const usesPlayingRules = this.status === Constants.STATUS.PLAYING &&
            TurnUtils.hasTurnOwner(this.circle.turnOwnerKey);

        if (usesPlayingRules) {
            const turnOwner = this.circle.requireTurnOwner();
            const drawAllowance = turnOwner.drawAllowance;
            const isLegal = card.isLegalOn(this.getTopDiscard(), this.declaredSuit, drawAllowance);

            if (!isLegal) {
                throw new UserNotification("Card cannot be played.");
            }
        }
    }

    /**
     * Gets a discard card relative to the top.
     *
     * @param {number} offset - Offset from the top.
     * @returns {Card|null} Discard card.
     */
    getTopDiscard(offset = 0) {
        let card = null;

        if (this.discardPile.length > 0) {
            const normalizedOffset = Math.abs(offset) % this.discardPile.length;
            const index = this.discardPile.length - 1 - normalizedOffset;

            card = this.discardPile[index] ?? null;
        }

        return card;
    }

    /**
     * Gets the Player who most recently discarded during the active round.
     *
     * @returns {Player|null} Last discarding player.
     */
    getLastDiscardPlayer() {
        let player = null;

        if (this._lastDiscardPlayerKey !== null) {
            player = this.circle.players.get(this._lastDiscardPlayerKey) ?? null;
        }

        return player;
    }

    /**
     * Plays a card and applies its effects.
     *
     * @param {Player} player - Acting player.
     * @param {Card} card - Card to play.
     */
    #applyDiscard(player, card) {
        this.discardPile.push(player.hand.discard(card));

        if (this.status === Constants.STATUS.PLAYING) {
            this._lastDiscardPlayerKey = player.key;
            player.drawAllowance = 0;
            this.declaredSuit = null;

            if (card.isRoundEndingMove(player.hand.cards.length)) {
                this.#finishRound();
            } else if (card.isSuitChange()) {
                this.status = Constants.STATUS.PENDING;
                this.isAwaitingSuit = true;
            } else {
                const playerCount = this.circle.players.size;

                if (card.isSkip(playerCount)) {
                    this.#advanceTurn(1, 2);
                } else if (card.isReverse(playerCount)) {
                    this.circle.reverseTurnDirection();
                    this.#advanceTurn(1, 1);
                } else if (card.isDrawFour()) {
                    this.#advanceTurn(4, 1);
                } else if (card.isDrawTwo()) {
                    this.#advanceTurn(2, 1);
                } else {
                    this.#advanceTurn(1, 1);
                }
            }
        }
    }

    /**
     * Finishes the game and determines winners.
     */
    #finishRound() {
        let minimumScore = Infinity;

        this.winners = [];
        this.scores = {};

        for (const player of this.circle.players.values()) {
            player.drawAllowance = 1;
            player.isWinner = false;

            this.scores[player.name] = player.hand.score;
            minimumScore = Math.min(minimumScore, player.hand.score);
        }

        for (const player of this.circle.players.values()) {
            if (player.hand.score === minimumScore) {
                player.isWinner = true;
                this.winners.push(player.name);
            }

            player.recordActivity();
        }

        this.isAwaitingSuit = false;
        this.declaredSuit = null;
        this.status = Constants.STATUS.FINISHED;
    }

    /**
     * Handles suit declaration for a wild card.
     *
     * @param {string} suit - Declared suit.
     * @returns {Promise<boolean>} True when completed.
     */
    async declareSuit(suit) {
        return this.#enqueueOperation(function declareSuitOperation() {
            let isCompleted = true;

            if (!this.#resetFinishedRound()) {
                if (!this.isAwaitingSuit) {
                    throw new UserNotification("No suit pending declaration.");
                }

                this.declaredSuit = Room.normalizeSuit(suit);
                this.isAwaitingSuit = false;
                this.status = Constants.STATUS.PLAYING;

                this.#advanceTurn(1, 1);
                this.#recordActivity();
                this.#refreshPlayerIdleMonitoring();
                this.#notifyStateChange();
            }

            return isCompleted;
        }.bind(this));
    }

    /**
     * Checks whether a player exists.
     *
     * @param {string} nameOrKey - Player name or key.
     * @returns {boolean} True when the player exists.
     */
    isPlayerPresent(nameOrKey) {
        return this.circle.players.has(
            Player.normalizeKey(nameOrKey)
        );
    }

    /**
     * Normalizes optional text.
     *
     * @param {*} value - Value.
     * @returns {string} Normalized text.
     */
    static #normalizeOptionalText(value) {
        let text = "";

        if (typeof value === "string") {
            text = value.trim();
        }

        return text;
    }

    /**
     * Normalizes a room or player-facing name.
     *
     * @param {*} value - Value.
     * @returns {string} Normalized name.
     * @throws {Error}
     */
    static #normalizeRoomName(value) {
        if (typeof value !== "string") {
            throw new Error("Room name must be a string.");
        }

        const name = value.trim();

        if (name.length === 0) {
            throw new UserNotification("Room name cannot be empty.");
        }

        return name;
    }

    /**
     * Normalizes the game player limit.
     *
     * @param {*} value - Value.
     * @returns {number} Player limit.
     * @throws {Error}
     */
    static #normalizePlayerLimit(value) {
        const isValid = Number.isInteger(value) && value >= 2 && value <= Constants.ROOM_PLAYER_LIMIT;

        if (!isValid) {
            throw new UserNotification(`Player limit must be between 2 and ${Constants.ROOM_PLAYER_LIMIT}.`);
        }

        return value;
    }

    /**
     * Normalizes a declared suit.
     *
     * @param {*} value - Suit.
     * @returns {string} Normalized suit.
     * @throws {Error}
     */
    static normalizeSuit(value) {
        return Constants.normalizeStandardSuit(Room.#normalizeRoomName(value));
    }
}
