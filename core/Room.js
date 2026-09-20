"use strict";

import { Serializable } from "./Serializable.js";
import { Constants } from "./Constants.js";
import { ValidationUtils } from "./ValidationUtils.js";
import { UserNotification } from "./UserNotification.js";
import { Actor } from "./Actor.js";
import { TurnOrder } from "./TurnOrder.js";
import { CardCollection } from "./CardCollection.js";
import { Card } from "./Card.js";
import { BotActor } from "./BotActor.js";
import { TurnUtils } from "./TurnUtils.js";
import { CardSortUtils } from "./CardSortUtils.js";

/** Owns a Pick2 room, its membership, and all item rules. */
export class Room extends Serializable {
    /** @type {Promise<*>} Tail of serialized room mutations. */
    #operationQueue = Promise.resolve();

    /**
     * Creates a room with a given name and actor limit.
     *
     * @param {string} roomName - Match room name.
     * @param {number} actorLimit - Maximum number of seated actors.
     * @throws {Error} When a value violates an internal room invariant.
     */
    constructor(roomName, actorLimit = Constants.ROOM_PLAYER_LIMIT) {
        super();
        this.name = ValidationUtils.namedString(roomName, "Room name", ValidationUtils.roomNameMaxLength);
        this.actorLimit = Room.#normalizeActorLimit(actorLimit);
        this.state = Constants.ROOM_STATE.WAITING;
        this.pending = null;
        this.collections = {};
        this.createdAt = Date.now();
        this.lastActiveAt = this.createdAt;
        this.viewers = new Set();
        this.onAnyChange = null;
        this.onActorIdle = null;
        this.turnOrder = new TurnOrder();

        this.setCollection("draw", CardCollection.createDeck(true));
        this.setCollection("play", new CardCollection());

        this.winners = [];
        this.declaredSuit = null;
        this._lastDiscardActorKey = null;
    }

    /** @returns {Map<string, Actor>} Actors keyed by normalized identity. */
    get actors() {
        return this.turnOrder.actors;
    }

    /** Returns whether the room has no seated actors. */
    isEmpty() {
        return this.turnOrder.isEmpty();
    }

    /** Returns whether actor capacity has been reached. */
    isFull() {
        return this.turnOrder.size >= this.actorLimit;
    }

    /** Returns whether a normalized actor identity is seated. */
    hasActor(actorNameOrKey) {
        try {
            return this.turnOrder.has(actorNameOrKey);
        } catch (_error) {
            return false;
        }
    }

    /**
     * Returns whether turn-based play rules are currently active.
     *
     * @returns {boolean} Whether the round is active.
     */
    isRoundActive() {
        return this.state === Constants.ROOM_STATE.ACTIVE;
    }

    /**
     * Returns whether the current lifecycle state locks actor membership.
     *
     * @returns {boolean} Whether membership is locked.
     */
    isMembershipLocked() {
        return this.isRoundActive();
    }

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
     * Adds a viewer.
     *
     * @param {string} tabId - Viewer tab ID.
     * @returns {boolean} True when the viewer was added.
     */
    view(tabId) {
        const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
        let wasAdded = false;

        if (normalizedTabId.length > 0) {
            const previousViewerCount = this.viewers.size;

            this.viewers.add(normalizedTabId);
            wasAdded = this.viewers.size > previousViewerCount;

            if (wasAdded) {
                this.recordActivity();
                this.notifyStateChange();
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
        const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
        let wasRemoved = false;

        if (normalizedTabId.length > 0) {
            wasRemoved = this.viewers.delete(normalizedTabId);

            if (wasRemoved) {
                this.recordActivity();
                this.notifyStateChange();
            }
        }

        return wasRemoved;
    }

    /** Adds a human or automated actor through the serialized operation queue. */
    async joinActor(actorName, isAutomated = false, viewerKey = null) {
        return this._enqueue(
            /** Adds an actor as one serialized room mutation. */
            function joinOperation() {
                const normalizedViewerKey = Room.#optionalText(viewerKey);

                if (this.isMembershipLocked()) {
                    throw new UserNotification("Room already in progress.");
                }
                if (this.isFull()) {
                    throw new UserNotification("Room is full.");
                }
                if (normalizedViewerKey && !this.viewers.has(normalizedViewerKey)) {
                    throw new UserNotification("Viewer not found.");
                }

                const actor = isAutomated ? new BotActor(actorName) : new Actor(actorName, { drawAllowance: 1 });

                this.turnOrder.add(actor);
                this.viewers.delete(normalizedViewerKey);
                this.recordActivity();
                this._refreshIdleMonitoring();
                this.notifyStateChange();
                return actor;
            }.bind(this)
        );
    }

    /** Removes a seated actor and releases its items. */
    async removeActor(actorNameOrKey) {
        return this.#removeActor(actorNameOrKey, null);
    }

    /** Removes an actor and registers the same client as a viewer. */
    async moveActorToView(actorNameOrKey, viewerKey) {
        return this.#removeActor(actorNameOrKey, viewerKey);
    }

    /** Registers a named room-owned collection. */
    setCollection(name, collection) {
        const key = ValidationUtils.requiredString(name, "Collection name");
        ValidationUtils.instanceOf(collection, CardCollection, "Room collection");
        this.collections[key] = collection;
        return collection;
    }

    /** Returns a named room-owned collection. */
    getCollection(name) {
        const key = ValidationUtils.requiredString(name, "Collection name");
        const collection = this.collections[key];

        if (!(collection instanceof CardCollection)) {
            throw new Error(`Room collection does not exist: ${key}`);
        }

        return collection;
    }

    /** Transfers an item from an actor collection into a room collection. */
    putItem(actorNameOrKey, destinationName, item) {
        const actor = this.turnOrder.get(actorNameOrKey);
        const destination = this.getCollection(destinationName);
        this.#assertTransferAllowed();
        return this.#moveItem(actor.collection, destination, item);
    }

    /** Transfers a requested or top item from a room collection to an actor. */
    takeItem(actorNameOrKey, sourceName, requestedItem = null) {
        const actor = this.turnOrder.get(actorNameOrKey);
        const source = this.getCollection(sourceName);
        const item = requestedItem === null ? source.peek() : requestedItem;

        if (item === null) {
            return null;
        }

        this.#assertTransferAllowed();
        return this.#moveItem(source, actor.collection, item);
    }

    /** Transfers up to a requested item count from a room collection to an actor. */
    takeItems(actorNameOrKey, sourceName, count) {
        ValidationUtils.nonNegativeInteger(count, "Item count");
        const items = [];

        for (let index = 0; index < count; index += 1) {
            const item = this.takeItem(actorNameOrKey, sourceName);
            if (item === null) {
                break;
            }
            items.push(item);
        }

        return items;
    }

    /** Transfers one item between room-owned collections. */
    moveItem(sourceName, destinationName, item) {
        const source = this.getCollection(sourceName);
        const destination = this.getCollection(destinationName);
        this.#assertTransferAllowed();
        return this.#moveItem(source, destination, item);
    }

    /** Deals a fixed count from a room collection to every actor in circle order. */
    disperseItems(sourceName, count) {
        ValidationUtils.nonNegativeInteger(count, "Item count");
        const dispersed = [];

        for (let round = 0; round < count; round += 1) {
            for (const actor of this.turnOrder) {
                const item = this.takeItem(actor.key, sourceName);
                if (item === null) {
                    return dispersed;
                }
                dispersed.push(item);
            }
        }

        return dispersed;
    }

    /**
     * Starts a round in the room.
     *
     * @returns {Promise<boolean>} True when started.
     */
    async startRound() {
        return this._enqueue(
            /** Initializes the Pick 2 round inside the room queue. */
            function startOperation() {
                this.#assertRoundNotStarted();
                this.#assertMinimumActorCount();

                this.#resetRoundState();
                this.setCollection("draw", CardCollection.createDeck(true));
                this.#dealInitialItem();
                this.#dealInitialHands();
                this.#selectRandomFirstActor();

                this.state = Constants.ROOM_STATE.ACTIVE;

                this.recordActivity();
                this._refreshIdleMonitoring();
                this.notifyStateChange();

                return true;
            }.bind(this)
        );
    }

    /**
     * Returns the active or completed room to waiting without clearing it.
     *
     * Actors, hands, the deck, and the discard pile remain available in the
     * waiting state. Starting another round performs the normal reset.
     *
     * @returns {Promise<boolean>} True when the room returned to waiting.
     */
    async stopRound() {
        return this._enqueue(
            /** Stops the current round inside the room queue. */
            function stopOperation() {
                const wasStopped = this.state !== Constants.ROOM_STATE.WAITING;

                if (wasStopped) {
                    this.state = Constants.ROOM_STATE.WAITING;
                    this.pending = null;
                    this.declaredSuit = null;
                    this.turnOrder.setOwner(null);

                    this.recordActivity();
                    this._refreshIdleMonitoring();
                    this.notifyStateChange();
                }

                return wasStopped;
            }.bind(this)
        );
    }

    /**
     * Serializes a legal draw, applies allowances, sorts the hand, and advances state when required.
     *
     * @param {string} actorName - Actor name.
     * @param {string} sortKey - The sort key.
     * @returns {Promise<Card[]>} Drawn items.
     */
    async drawItems(actorName, sortKey = "none") {
        return this._enqueue(
            /** Draws items inside the room queue. */
            function drawItemsOperation() {
                let drawnItems = [];

                if (!this.#isFinishedRound()) {
                    const actor = this.turnOrder.get(actorName);

                    this.#assertCanAct(actor);
                    this.#sortActorItems(actor, sortKey);

                    const usesPlayingRules =
                        this.state === Constants.ROOM_STATE.ACTIVE && TurnUtils.hasTurnOwner(this.turnOrder.ownerKey);
                    const drawCount = usesPlayingRules ? actor.drawAllowance : 1;

                    if (drawCount <= 0) {
                        throw new UserNotification("No draw allowance remaining.");
                    }

                    drawnItems = this.#drawItemsForActor(actor, drawCount);

                    if (usesPlayingRules) {
                        actor.drawAllowance = 0;

                        if (drawCount > 1) {
                            this.#advanceTurn(1, 1);
                        }
                    }

                    this.recordActivity();
                    this._refreshIdleMonitoring();
                    this.notifyStateChange();
                }

                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Serializes a legal pass, commits hand order, and advances to the next actor.
     *
     * @param {string} actorName - Actor name.
     * @param {string} sortKey - Items sort order keyword
     * @returns {Promise<Card[]>} Items drawn while passing.
     */
    async passTurn(actorName, sortKey = "none") {
        return this._enqueue(
            /** Passes the active turn inside the room queue. */
            function passTurnOperation() {
                const drawnItems = [];

                if (!this.#isFinishedRound()) {
                    const actor = this.turnOrder.get(actorName);

                    this.#assertCanAct(actor);
                    this.#sortActorItems(actor, sortKey);

                    if (this.state === Constants.ROOM_STATE.ACTIVE && TurnUtils.hasTurnOwner(this.turnOrder.ownerKey)) {
                        const remainingDrawAllowance = Math.max(0, actor.drawAllowance);

                        if (remainingDrawAllowance > 0) {
                            drawnItems.push(...this.#drawItemsForActor(actor, remainingDrawAllowance));
                        }

                        actor.drawAllowance = 0;
                        this.#advanceTurn(1, 1);
                    }

                    actor.recordActivity();
                    this.recordActivity();
                    this._refreshIdleMonitoring();
                    this.notifyStateChange();
                }

                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Serializes a legal discard, applies card effects, and advances or finishes the round.
     *
     * @param {string} actorName - Actor name.
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {string} sortKey - Items sort order keyword
     * @returns {Promise<Card[]>} Items drawn as a result.
     */
    async playItem(actorName, value, suit, sortKey = "none") {
        return this._enqueue(
            /** Discards an item inside the room queue. */
            function playItemOperation() {
                const drawnItems = [];

                if (!this.#isFinishedRound()) {
                    const actor = this.turnOrder.get(actorName);
                    const item = new Card(value, suit);

                    this.#assertCanAct(actor);
                    this.#sortActorItems(actor, sortKey);
                    this.#assertActorHasItem(actor, item);
                    this.#assertItemIsPlayable(item);

                    this.#applyDiscard(actor, item);
                    actor.recordActivity();

                    this.recordActivity();
                    this._refreshIdleMonitoring();
                    this.notifyStateChange();
                }

                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Returns a discard to the acting actor's hand while waiting.
     * Validation and transfer share the room's operation queue so concurrent
     * claims and a round starting cannot duplicate or move a stale item.
     * @param {string} actorName - Acting actor.
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @param {string} sortKey - Current hand ordering.
     * @returns {Promise<Card>} Returned item.
     */
    async returnItem(actorName, value, suit, sortKey = "none") {
        return this._enqueue(
            /** Returns a discard inside the room queue. */
            function returnItemOperation() {
                if (this.state !== Constants.ROOM_STATE.WAITING) {
                    throw new UserNotification("Items can only be returned while the room is waiting.");
                }

                const actor = this.turnOrder.get(actorName);
                this.#assertCanAct(actor);
                const identity = new Card(value, suit, 0);
                const index = this.collections.play.items.findIndex(function matchesItem(item) {
                    return item.value === identity.value && item.suit === identity.suit;
                });

                if (index === -1) {
                    throw new UserNotification("Item " + identity.key + " is no longer in the play collection.");
                }

                this.#sortActorItems(actor, sortKey);
                const returned = this.takeItem(actor.key, "play", this.collections.play.items[index]);
                actor.recordActivity();
                this.recordActivity();
                this._refreshIdleMonitoring();
                this.notifyStateChange();
                return returned;
            }.bind(this)
        );
    }

    /**
     * Resolves the pending wild-card decision and advances to the next actor.
     *
     * @param {string} suit - Declared suit.
     * @returns {Promise<boolean>} True when completed.
     */
    async declareSuit(suit) {
        return this._enqueue(
            /** Declares the pending suit inside the room queue. */
            function declareSuitOperation() {
                let isCompleted = true;

                if (!this.#isFinishedRound()) {
                    if (this.pending?.command !== Constants.COMMANDS.DECLARE) {
                        throw new UserNotification("No suit pending declaration.");
                    }

                    const actor = this.turnOrder.requireOwner();
                    this.declaredSuit = Room.normalizeSuit(suit);
                    this.pending = null;
                    this.state = Constants.ROOM_STATE.ACTIVE;

                    this.#advanceTurn(1, 1);
                    actor.recordActivity();
                    this.recordActivity();
                    this._refreshIdleMonitoring();
                    this.notifyStateChange();
                }

                return isCompleted;
            }.bind(this)
        );
    }

    /**
     * Returns a play-pile item by zero-based offset from the top without removing it.
     *
     * @param {number} offset - Offset from the top.
     * @returns {Card|null} Discard item.
     */
    getTopItem(offset = 0) {
        let item = null;

        if (this.collections.play.items.length > 0) {
            const normalizedOffset = Math.abs(offset) % this.collections.play.items.length;
            const index = this.collections.play.items.length - 1 - normalizedOffset;

            item = this.collections.play.items[index] ?? null;
        }

        return item;
    }

    /**
     * Resolves the actor recorded as the most recent active-round discarder.
     *
     * @returns {Actor|null} Last discarding actor.
     */
    getLastDiscardActor() {
        let actor = null;

        if (this._lastDiscardActorKey !== null) {
            actor = this.turnOrder.actors.get(this._lastDiscardActorKey) ?? null;
        }

        return actor;
    }

    /** Serializes a room mutation behind all previously requested mutations. */
    _enqueue(operation) {
        const result = this.#operationQueue.then(operation);
        this.#operationQueue = result.catch(function ignoreFailure() {});
        return result;
    }

    /** Returns a departing actor’s cards to the draw collection and reshuffles it. */
    _storeReleasedItems(items) {
        this.collections.draw.addMany(items);
        this.collections.draw.shuffle();
    }

    /** Restores a valid round or turn state after an actor leaves. */
    _afterActorRemoved(actor) {
        if (this.isRoundActive()) {
            if (this.turnOrder.actors.size < 2) {
                this.#resetRoundState();
            } else {
                const isTurnOwnerRemoved =
                    !TurnUtils.hasTurnOwner(this.turnOrder.ownerKey) ||
                    TurnUtils.isTurnOwner(this.turnOrder.ownerKey, actor.key);

                if (isTurnOwnerRemoved) {
                    this.#advanceTurn(1, 1);
                }
            }
        }
    }

    /** Applies the hosted idle policy to the currently eligible human actors. */
    _refreshIdleMonitoring() {
        for (const actor of this.turnOrder.actors.values()) {
            const isBot = actor instanceof BotActor;
            const shouldTrack = !isBot && (!this.isRoundActive() || actor.key === this.turnOrder.ownerKey);

            if (shouldTrack) {
                actor.onIdle = function handleIdle(idleActor) {
                    if (typeof this.onActorIdle === "function") this.onActorIdle(idleActor.name);
                }.bind(this);
                actor.recordActivity();
            } else {
                actor.stopIdleMonitoring();
            }
        }
    }

    /** Serializes actor removal, item recovery, viewer conversion, activity, and publication. */
    async #removeActor(actorNameOrKey, viewerKey) {
        return this._enqueue(
            /** Removes an actor as one serialized room mutation. */
            function removeOperation() {
                const actor = this.turnOrder.get(actorNameOrKey);
                const items = actor.collection?.clear() ?? [];
                actor.stopIdleMonitoring();
                this.turnOrder.remove(actor.key);
                this._storeReleasedItems(items);
                this._afterActorRemoved(actor);

                const normalizedViewerKey = Room.#optionalText(viewerKey);
                if (normalizedViewerKey) {
                    this.viewers.add(normalizedViewerKey);
                }

                this.recordActivity();
                this._refreshIdleMonitoring();
                this.notifyStateChange();
                return actor;
            }.bind(this)
        );
    }

    /**
     * Resets room state to waiting.
     */
    #resetRoundState() {
        this.winners = [];
        this.pending = null;
        this.declaredSuit = null;
        this._lastDiscardActorKey = null;
        this.collections.play.clear();
        this.setCollection("draw", CardCollection.createDeck(true));
        this.state = Constants.ROOM_STATE.WAITING;

        this.turnOrder.reset();

        for (const actor of this.turnOrder.actors.values()) {
            actor.recordActivity();
        }
    }

    /**
     * Returns whether the completed round must remain unchanged until a new round starts.
     *
     * @returns {boolean} True when the current round is finished.
     */
    #isFinishedRound() {
        return this.state === Constants.ROOM_STATE.FINISHED;
    }

    /**
     * Advances the turn to the next actor.
     *
     * @param {number} drawAllowance - Draw allowance for the next actor.
     * @param {number} steps - Number of actors to advance.
     */
    #advanceTurn(drawAllowance = 1, steps = 1) {
        const moved = this.turnOrder.move(steps);

        if (moved) {
            const actor = this.turnOrder.requireOwner();

            actor.drawAllowance = drawAllowance;
            actor.recordActivity();
        }
    }

    /**
     * Asserts the room is not already active.
     */
    #assertRoundNotStarted() {
        if (this.isRoundActive()) {
            throw new UserNotification("Round already active.");
        }
    }

    /**
     * Asserts the room has enough actors to start a round.
     */
    #assertMinimumActorCount() {
        if (this.turnOrder.actors.size < 2) {
            throw new UserNotification("Need at least two actors.");
        }
    }

    /** Validates the shared and game-specific transfer policies. */
    #assertTransferAllowed() {
        if (this.state !== Constants.ROOM_STATE.WAITING && this.state !== Constants.ROOM_STATE.ACTIVE) {
            throw new UserNotification("Items cannot move after the room has finished.");
        }
        if (this.pending !== null) {
            throw new UserNotification("Resolve the pending command first.");
        }
    }

    /** Atomically removes an item from one collection and inserts it in another. */
    #moveItem(source, destination, item) {
        ValidationUtils.instanceOf(source, CardCollection, "Source collection");
        ValidationUtils.instanceOf(destination, CardCollection, "Destination collection");
        const removed = source.remove(item);
        if (removed === null) {
            throw new UserNotification("Item " + (item?.key ?? item) + " does not exist in the source collection.");
        }

        try {
            return destination.add(removed);
        } catch (error) {
            source.add(removed);
            throw error;
        }
    }

    /**
     * Pushes the initial discard item.
     */
    #dealInitialItem() {
        this.#ensureDeckCapacity(1);

        const items = [...this.collections.draw];
        let ordinaryItem = null;

        for (const item of items) {
            if (!item.isSpecial()) {
                ordinaryItem = item;
                break;
            }
        }
        const selectedItem = ordinaryItem ?? items[items.length - 1];
        this.moveItem("draw", "play", selectedItem);
    }

    /**
     * Ensures the deck has enough items.
     *
     * @param {number} needed - Number of items needed.
     */
    #ensureDeckCapacity(needed) {
        if (this.collections.draw.items.length < needed) {
            this.#refillDrawCollection();
        }

        if (this.collections.draw.items.length < needed) {
            throw new Error("Not enough items in deck.");
        }
    }

    /**
     * Refills the deck from the discard pile.
     */
    #refillDrawCollection() {
        if (this.collections.play.items.length > 1) {
            const topItem = this.collections.play.take();
            const refillItems = this.collections.play.clear();

            this.collections.draw.addMany(refillItems);
            this.collections.draw.shuffle();
            this.collections.play.add(topItem);
        }
    }

    /**
     * Deals initial hands to all actors.
     */
    #dealInitialHands() {
        const totalNeeded = this.turnOrder.actors.size * Constants.INITIAL_ITEM_COUNT;

        this.#ensureDeckCapacity(totalNeeded);
        this.disperseItems("draw", Constants.INITIAL_ITEM_COUNT);
    }

    /**
     * Picks a random first actor.
     */
    #selectRandomFirstActor() {
        const actorKeys = Array.from(this.turnOrder.actors.keys());
        const randomIndex = Math.floor(Math.random() * actorKeys.length);

        this.turnOrder.setOwner(actorKeys[randomIndex]);
    }

    /** Sorts a hand when a concrete ordering is requested. */
    #sortActorItems(actor, sortKey) {
        if (sortKey !== "none") {
            actor.collection.sort(CardSortUtils.comparator(sortKey));
        }
    }

    /**
     * Asserts an actor can perform the requested command.
     *
     * @param {Actor|null} actor - Acting actor.
     */
    #assertCanAct(actor) {
        if (actor === null || actor === undefined) {
            throw new UserNotification(`Actor not found.`);
        }

        if (this.pending !== null) {
            throw new UserNotification("Room is waiting for suit declaration.");
        }

        const isAnotherActorsTurn =
            this.state === Constants.ROOM_STATE.ACTIVE &&
            TurnUtils.hasTurnOwner(this.turnOrder.ownerKey) &&
            !TurnUtils.isTurnOwner(this.turnOrder.ownerKey, actor.key);

        if (isAnotherActorsTurn) {
            throw new UserNotification("Not your turn.");
        }
    }

    /**
     * Draws items for an actor.
     *
     * @param {Actor} actor - Target actor.
     * @param {number} count - Number of items.
     * @returns {Card[]} Drawn items.
     */
    #drawItemsForActor(actor, count) {
        this.#ensureDeckCapacity(count);
        const items = this.takeItems(actor.key, "draw", count);
        actor.recordActivity();

        return items;
    }

    /**
     * Asserts an actor has an item.
     *
     * @param {Actor} actor - Actor.
     * @param {Card} item - Card to check.
     */
    #assertActorHasItem(actor, item) {
        let isFound = false;

        for (const actorItem of actor.collection) {
            const isValueMatch = actorItem.value === item.value;
            const isSuitMatch = actorItem.suit === item.suit;

            if (isValueMatch && isSuitMatch) {
                isFound = true;
                break;
            }
        }

        if (!isFound) {
            throw new UserNotification("Item " + item.key + " is no longer in your collection.");
        }
    }

    /**
     * Asserts a item can legally be played.
     *
     * @param {Card} item - Card to check.
     */
    #assertItemIsPlayable(item) {
        const usesPlayingRules =
            this.state === Constants.ROOM_STATE.ACTIVE && TurnUtils.hasTurnOwner(this.turnOrder.ownerKey);

        if (usesPlayingRules) {
            const turnOwner = this.turnOrder.requireOwner();
            const drawAllowance = turnOwner.drawAllowance;
            const isLegal = item.isLegalOn(this.getTopItem(), this.declaredSuit, drawAllowance);

            if (!isLegal) {
                throw new UserNotification("Item " + item.key + " cannot be played.");
            }
        }
    }

    /**
     * Plays a item and applies its effects.
     *
     * @param {Actor} actor - Acting actor.
     * @param {Card} item - Card to play.
     */
    #applyDiscard(actor, item) {
        this.putItem(actor.key, "play", item);

        if (this.state === Constants.ROOM_STATE.ACTIVE) {
            this._lastDiscardActorKey = actor.key;
            actor.drawAllowance = 0;
            this.declaredSuit = null;

            if (item.isRoundEndingMove(actor.collection.items.length)) {
                this.#finishRound();
            } else if (item.isSuitChange()) {
                this.pending = { command: Constants.COMMANDS.DECLARE, actorKey: actor.key };
            } else {
                const actorCount = this.turnOrder.actors.size;

                if (item.isSkip(actorCount)) {
                    this.#advanceTurn(1, 2);
                } else if (item.isReverse(actorCount)) {
                    this.turnOrder.reverse();
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
     * Finishes the game and determines winners.
     */
    #finishRound() {
        let minimumScore = Infinity;

        this.winners = [];

        for (const actor of this.turnOrder.actors.values()) {
            actor.drawAllowance = 1;
            minimumScore = Math.min(minimumScore, actor.collection.score);
        }

        for (const actor of this.turnOrder.actors.values()) {
            if (actor.collection.score === minimumScore) {
                actor.state = Constants.ACTOR_STATE.WON;
                this.winners.push(actor.name);
            } else {
                actor.state = Constants.ACTOR_STATE.LOST;
            }

            actor.recordActivity();
        }

        this.pending = null;
        this.declaredSuit = null;
        this.state = Constants.ROOM_STATE.FINISHED;
    }

    /** Normalizes optional external text without throwing. */
    static #optionalText(value) {
        return typeof value === "string" ? value.trim() : "";
    }

    /**
     * Normalizes a room or actor-facing name.
     *
     * @param {*} value - Value.
     * @returns {string} Normalized name.
     * @throws {Error} When a value violates an internal room invariant.
     */
    static #normalizeRoomName(value) {
        return ValidationUtils.namedString(value, "Room name", ValidationUtils.roomNameMaxLength);
    }

    /**
     * Normalizes the game actor limit.
     *
     * @param {*} value - Value.
     * @returns {number} Actor limit.
     * @throws {Error} When a value violates an internal room invariant.
     */
    static #normalizeActorLimit(value) {
        const isValid = Number.isInteger(value) && value >= 2 && value <= Constants.ROOM_PLAYER_LIMIT;

        if (!isValid) {
            throw new UserNotification(`Limit must be between 2 and ${Constants.ROOM_PLAYER_LIMIT}.`);
        }

        return value;
    }

    /**
     * Normalizes a declared suit.
     *
     * @param {*} value - Suit.
     * @returns {string} Normalized suit.
     * @throws {Error} When a value violates an internal room invariant.
     */
    static normalizeSuit(value) {
        return Constants.normalizeStandardSuit(Room.#normalizeRoomName(value));
    }
}
