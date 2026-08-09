
"use strict";

import { Constants } from "./Constants.js";
import { Card } from "./Card.js";
import { Deck } from "./Deck.js";
import { UserNotification } from "./UserNotification.js";
import { Serializable } from "./Serializable.js";
import { AIPlayer, Player } from "./Player.js";
import { PlayerCircle } from "./PlayerCircle.js";
import { TurnUtils } from "./TurnUtils.js";

/**
 * Owns one game room and enforces game rules.
 *
 * Membership levels:
 * - Visitor: Can observe the room.
 * - Player: Participates in the game.
 */
export class Room extends Serializable {
    /** @type {Promise<*>} */
    #operationQueue = Promise.resolve();

    /**
     * Creates a room.
     *
     * @param {string} name - Room name.
     * @param {number} capacity - Room capacity.
     * @throws {Error}
     */
    constructor(name, capacity = Constants.ROOM_MAX_CAPACITY) {
        super();

        const now = Date.now();

        this.name = Room.#normalizeName(name);
        this.capacity = Room.#normalizeCapacity(capacity);
        this.status = Constants.STATUS.WAITING;

        this.createdAt = now;
        this.lastActiveAt = now;

        this.session = {
            playerName: null
        };

        this.circle = new PlayerCircle();
        this.deck = new Deck(true);
        this.discardPile = [];
        this.visitors = new Set();

        this.winners = [];
        this.scores = {};

        this.isAwaitingSuit = false;
        this.declaredSuit = null;
        this._lastDiscardPlayerKey = null;

        // Server-supplied callbacks.
        this.onAnyChange = null;
        this.onPlayerDemotionRequested = null;
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
     * Notifies the server of a room state change.
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
        this.#operationQueue = result.catch(() => {});

        return result;
    }

    /**
     * Checks whether the room has no players.
     *
     * Visitors do not keep a room open.
     *
     * @returns {boolean} True when the room has no players.
     */
    isEmpty() {
        return this.circle.players.size === 0;
    }

    /**
     * Checks whether gameplay is underway or awaiting a required game decision.
     *
     * @returns {boolean} Whether the game is active.
     */
    isGameActive() {
        return this.status === Constants.STATUS.PLAYING || this.status === Constants.STATUS.PENDING;
    }

    /**
     * Checks whether the current game state prevents membership changes.
     *
     * @returns {boolean} Whether membership is locked.
     */
    isMembershipLocked() {
        return this.isGameActive();
    }

    /**
     * Admits an outside client as a visitor.
     * Transition: Outside -> Visitor.
     *
     * @param {string} tabId - Visitor tab ID.
     * @returns {boolean} True when the visitor was admitted.
     */
    admitVisitor(tabId) {
        const normalizedTabId = Room.#normalizeOptionalText(tabId);
        let isAdmitted = false;

        if (normalizedTabId.length > 0) {
            const previousVisitorCount = this.visitors.size;

            this.visitors.add(normalizedTabId);
            isAdmitted = this.visitors.size > previousVisitorCount;

            if (isAdmitted) {
                this.#recordActivity();
                this.#notifyStateChange();
            }
        }

        return isAdmitted;
    }

    /**
     * Evicts a visitor from the room.
     * Transition: Visitor -> Outside.
     *
     * @param {string} tabId - Visitor tab ID.
     * @returns {boolean} True when the visitor was evicted.
     */
    evictVisitor(tabId) {
        const normalizedTabId = Room.#normalizeOptionalText(tabId);
        let isEvicted = false;

        if (normalizedTabId.length > 0) {
            isEvicted = this.visitors.delete(normalizedTabId);

            if (isEvicted) {
                this.#recordActivity();
                this.#notifyStateChange();
            }
        }

        return isEvicted;
    }

    /**
     * Admits an outside client directly as a player.
     * Transition: Outside -> Player.
     *
     * @param {string} name - Player name.
     * @param {boolean} isAI - Whether AI controls the player.
     * @returns {Promise<Player>} Admitted player.
     */
    async admitPlayer(name, isAI = false) {
        return this.#enqueueOperation(() => {
            this.#assertMembershipUnlocked();
            this.#assertPlayerCapacityAvailable();

            const player = this.#createPlayer(name, isAI);

            this.circle.addPlayer(player);
            this.#recordActivity();
            this.#refreshPlayerIdleMonitoring();
            this.#notifyStateChange();

            return player;
        });
    }

    /**
     * Promotes a visitor to player status.
     * Transition: Visitor -> Player.
     *
     * @param {string} tabId - Visitor tab ID.
     * @param {string} playerName - New player name.
     * @returns {Promise<Player>} Promoted player.
     * @throws {Error}
     */
    async promoteVisitor(tabId, playerName) {
        return this.#enqueueOperation(() => {
            const normalizedTabId = Room.#normalizeOptionalText(tabId);

            if (normalizedTabId.length === 0 || !this.visitors.has(normalizedTabId)) {
                throw new UserNotification("Visitor not found.");
            }

            this.#assertMembershipUnlocked();
            this.#assertPlayerCapacityAvailable();

            const player = this.#createPlayer(playerName, false);

            this.circle.addPlayer(player);
            this.visitors.delete(normalizedTabId);

            this.#recordActivity();
            this.#refreshPlayerIdleMonitoring();
            this.#notifyStateChange();

            return player;
        });
    }

    /**
     * Demotes a player to visitor status.
     * Transition: Player -> Visitor.
     *
     * @param {string} nameOrKey - Player name or normalized player key.
     * @param {string} tabId - Client tab ID that becomes the visitor ID.
     * @returns {Promise<Player|null>} Demoted player, or null when not found.
     */
    async demotePlayer(nameOrKey, tabId) {
        return this.#enqueueOperation(() => {
            const player = this.circle.getPlayer(nameOrKey);
            const normalizedTabId = Room.#normalizeOptionalText(tabId);
            let demotedPlayer = null;

            if (player !== null && normalizedTabId.length > 0) {
                this.#removePlayerAndRecycleHand(player.key);
                this.visitors.add(normalizedTabId);

                this.#refreshPlayerIdleMonitoring();
                this.#recordActivity();
                this.#notifyStateChange();

                demotedPlayer = player;
            }

            return demotedPlayer;
        });
    }

    /**
     * Evicts a player from the room.
     * Transition: Player -> Outside.
     *
     * @param {string} nameOrKey - Player name or normalized player key.
     * @returns {Promise<Player|null>} Evicted player, or null when not found.
     */
    async evictPlayer(nameOrKey) {
        return this.#enqueueOperation(() => {
            const player = this.circle.getPlayer(nameOrKey);
            let evictedPlayer = null;

            if (player !== null) {
                this.#removePlayerAndRecycleHand(player.key);

                this.#refreshPlayerIdleMonitoring();
                this.#recordActivity();
                this.#notifyStateChange();

                evictedPlayer = player;
            }

            return evictedPlayer;
        });
    }

    /**
     * Creates a human or AI player.
     *
     * @param {string} name - Player name.
     * @param {boolean} isAI - Whether AI controls the player.
     * @returns {Player} Created player.
     */
    #createPlayer(name, isAI) {
        let player;

        if (isAI) {
            player = new AIPlayer(name);
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
            throw new UserNotification("Game already in progress.");
        }
    }

    /**
     * Asserts the room has player capacity.
     */
    #assertPlayerCapacityAvailable() {
        if (this.isFull()) {
            throw new UserNotification("Room is full.");
        }
    }

    /**
     * Checks whether the room is at player capacity.
     *
     * @returns {boolean} True when full.
     */
    isFull() {
        return this.circle.players.size >= this.capacity;
    }

    /**
     * Refreshes idle watches for all human players.
     */
    #refreshPlayerIdleMonitoring() {
        const isTrackingOnlyTurnOwner = this.isGameActive() &&
            TurnUtils.hasTurnOwner(this.circle.turnOwnerKey);

        for (const player of this.circle.players.values()) {
            const isHumanPlayer = !(player instanceof AIPlayer);
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
     * Enables automatic demotion requests for an idle player.
     *
     * Room does not perform the demotion directly because the server owns the
     * player-to-tab relationship required to create the visitor membership.
     *
     * @param {Player} player - Player to watch.
     */
    #startPlayerIdleMonitoring(player) {
        player.onIdle = (idlePlayer) => {
            if (typeof this.onPlayerDemotionRequested === "function") {
                this.onPlayerDemotionRequested(this, idlePlayer.name);
            }
        };

        player.recordActivity();
    }

    /**
     * Removes a player from the active game state.
     *
     * This method does not decide whether the player is being demoted or evicted.
     * The public transition method handles the destination level.
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

        if (this.isGameActive()) {
            if (this.circle.players.size < 2) {
                this.#resetActiveGameState();
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
     * Resets game state to waiting.
     */
    #resetActiveGameState() {
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
     * Stops the current game without replacing or clearing the table.
     *
     * Players, hands, the deck, and the discard pile remain available in the
     * waiting state. Starting another game performs the normal round reset.
     *
     * @returns {Promise<boolean>} True when an active game was stopped.
     */
    async stopGame() {
        return this.#enqueueOperation(() => {
            const wasStopped = this.isGameActive();

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
        });
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
     * Starts a new game.
     *
     * @returns {Promise<boolean>} True when started.
     */
    async startGame() {
        return this.#enqueueOperation(() => {
            this.#assertGameNotStarted();
            this.#assertMinimumPlayerCount();

            this.#resetActiveGameState();
            this.deck.reset(true);
            this.#dealInitialDiscard();
            this.#dealInitialHands();
            this.#selectRandomFirstPlayer();

            this.status = Constants.STATUS.PLAYING;

            this.#recordActivity();
            this.#refreshPlayerIdleMonitoring();
            this.#notifyStateChange();

            return true;
        });
    }

    /**
     * Asserts a game is not already active.
     */
    #assertGameNotStarted() {
        if (this.isGameActive()) {
            throw new UserNotification("Game already started.");
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
        const ordinaryCard = cards.find((card) => !card.isSpecial());
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
        return this.#enqueueOperation(() => {
            let drawnCards = [];

            if (!this.#resetFinishedGame()) {
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
        });
    }

    /**
     * Resets the room if the previous game is finished.
     *
     * @returns {boolean} True when reset.
     */
    #resetFinishedGame() {
        const shouldReset = this.status === Constants.STATUS.FINISHED;

        if (shouldReset) {
            this.#resetActiveGameState();
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
        return this.#enqueueOperation(() => {
            const drawnCards = [];

            if (!this.#resetFinishedGame()) {
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
        });
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
        return this.#enqueueOperation(() => {
            const drawnCards = [];

            if (!this.#resetFinishedGame()) {
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
        });
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
     * Gets the player who most recently discarded during the active game.
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

            if (card.isGameEndingMove(player.hand.cards.length)) {
                this.#completeGame();
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
    #completeGame() {
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
        return this.#enqueueOperation(() => {
            let isCompleted = true;

            if (!this.#resetFinishedGame()) {
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
        });
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
     * Sets the session player used during serialization.
     *
     * @param {string|null} playerName - Session player name.
     */
    setSessionPlayer(playerName = null) {
        this.session.playerName = playerName;
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
    static #normalizeName(value) {
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
     * Normalizes room capacity.
     *
     * @param {*} value - Value.
     * @returns {number} Capacity.
     * @throws {Error}
     */
    static #normalizeCapacity(value) {
        const isValid = Number.isInteger(value) && value >= 2 && value <= Constants.ROOM_MAX_CAPACITY;

        if (!isValid) {
            throw new UserNotification(`Capacity must be between 2 and ${Constants.ROOM_MAX_CAPACITY}.`);
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
        return Constants.normalizeStandardSuit(Room.#normalizeName(value));
    }
}
