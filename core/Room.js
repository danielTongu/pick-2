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

/** Owns a Pick2 room, its membership, and all item rules. */
export class Room extends Serializable {
    /**
     * @type {Promise<*>} Tail of serialized room mutations.
     */
    #operationQueue = Promise.resolve();

    /**
     * Creates a room with a given name and actor limit.
     *
     * @param {string} roomName - Match room name.
     * @param {number} actorLimit - Maximum number of seated actors.
     * @throws {Error} When a value violates an internal room invariant.
     */
    constructor(roomName, actorLimit = Constants.ROOM_ACTOR_LIMIT) {
        super();
        this.name = ValidationUtils.namedString(roomName, "Room name", ValidationUtils.roomNameMaxLength);
        this.actorLimit = Room.#normalizeActorLimit(actorLimit);
        this.match = new Match();
        this.createdAt = Date.now();
        this.lastActiveAt = this.createdAt;
        this.viewers = new Set();
        this.onAnyChange = null;
        this.onActorIdle = null;
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

    /** Returns whether the room has no seated actors. */
    isEmpty() {
        return this.match.turnOrder.actors.size === 0;
    }

    /** Returns whether actor capacity has been reached. */
    isFull() {
        return this.match.turnOrder.actors.size >= this.actorLimit;
    }

    /**

     * Returns whether a normalized actor identity is seated.
     * @param {string} actorNameOrKey - Actor name or normalized key.
     * @returns {boolean} Whether the Actor is seated.
     */
    hasActor(actorNameOrKey) {
        try {
            return this.match.turnOrder.has(actorNameOrKey);
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

    /**
     * Updates room activity timestamp.
     *
     * @returns {number} Last active timestamp.
     */
    recordActivity() {
        this.lastActiveAt = Date.now();

        return this.lastActiveAt;
    }

    /** Records a mutation, refreshes eligible idle timers, and publishes room state. */
    #publishMutation(refreshIdle = true) {
        this.recordActivity();
        if (refreshIdle) this._refreshIdleMonitoring();
        this.notifyStateChange();
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

     * Adds a human or automated actor through the serialized operation queue.
     * @param {string} actorName - Name of the Actor to seat.
     * @param {boolean} [isAutomated] - Whether the Actor is a Bot.
     * @param {string|null} [viewerKey] - Viewer tab to promote, if any.
     * @returns {Promise<Actor>} Added Actor.
     */
    async joinActor(actorName, isAutomated = false, viewerKey = null) {
        return this._enqueue(
            /** Adds an actor as one serialized room mutation. */
            function joinOperation() {
                const normalizedViewerKey = Room.#optionalText(viewerKey);

                if (this.isMatchActive()) {
                    throw new UserNotification("Room already in progress.");
                }
                if (this.match instanceof Knockout && !this.match.isKnockoutComplete) {
                    throw new UserNotification("Actors cannot join a knockout after it starts.");
                }
                if (this.isFull()) {
                    throw new UserNotification("Room is full.");
                }
                if (normalizedViewerKey && !this.viewers.has(normalizedViewerKey)) {
                    throw new UserNotification("Viewer not found.");
                }

                const actor = isAutomated ? new BotActor(actorName) : new Actor(actorName, { drawAllowance: 1 });

                this.match.turnOrder.add(actor);
                this.viewers.delete(normalizedViewerKey);
                this.#publishMutation();
                return actor;
            }.bind(this)
        );
    }

    /**

     * Removes a seated actor and releases its items.
     * @param {string} actorNameOrKey - Actor name or normalized key.
     * @returns {Promise<Actor>} Removed Actor.
     */
    async removeActor(actorNameOrKey) {
        return this.#removeActor(actorNameOrKey, null);
    }

    /** Restores a sidelined bot instance after the knockout is complete. */
    async reseatActor(actor) {
        return this._enqueue(function reseatOperation() {
            ValidationUtils.instanceOf(actor, BotActor, "Sidelined bot");
            if (!(this.match instanceof Knockout) || !this.match.isKnockoutComplete ||
                this.isFull() || this.hasActor(actor.key)) {
                throw new UserNotification("Bot cannot return to this room yet.");
            }
            actor.reset();
            this.match.turnOrder.add(actor);
            this.#publishMutation();
            return actor;
        }.bind(this));
    }

    /**

     * Removes an actor and registers the same client as a viewer.
     * @param {string} actorNameOrKey - Actor name or normalized key.
     * @param {string} viewerKey - Viewer tab to register.
     * @returns {Promise<Actor>} Removed Actor.
     */
    async moveActorToView(actorNameOrKey, viewerKey) {
        return this.#removeActor(actorNameOrKey, viewerKey);
    }

    /**
     * Starts a match in the room.
     *
     * @param {boolean|null} knockout - Initial Knockout choice, or null to continue.
     * @returns {Promise<void>}
     */
    async startMatch(knockout = null) {
        return this._enqueue(
            /** Initializes the Pick 2 match inside the room queue. */
            function startOperation() {
                const isKnockout = this.#beforeStartMatch(knockout);
                if (this.match instanceof Knockout && this.match.nextMatchAvailable) {
                    this.match.prepareNextMatch();
                } else {
                    this.match = isKnockout ? new Knockout(this.match.turnOrder) : new Match(this.match.turnOrder);
                }

                this.match.resetMatchState();
                this.match.setCollection("draw", CardCollection.createDeck(true));
                this.#dealInitialItem();
                this.#dealInitialHands();
                this.#selectRandomFirstActor();
                this.match.state = Constants.ROOM_STATE.ACTIVE;
                this.#publishMutation();
            }.bind(this)
        );
    }

    /** Validates the selected or continuing match type inside the Room queue. */
    #beforeStartMatch(knockout) {
        this.#assertMatchNotStarted();
        this.#assertMinimumActorCount();
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
     * Resumes waiting-state transactions after completed results were visible.
     *
     * Actors, hands, the deck, and the discard pile remain unchanged.
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
     * @param {string} actorName - Acting actor's name.
     * @param {Object} data - Command payload.
     * @returns {Promise<*>} Action result.
     */
    async perform(command, actorName, data = {}) {
        switch (command) {
            case Constants.COMMANDS.DRAW:
                return this.drawItems(actorName, data.sortKey);
            case Constants.COMMANDS.PASS:
                return this.passTurn(actorName, data.sortKey);
            case Constants.COMMANDS.DISCARD: {
                const card = Card.from(data.card);
                return this.playItem(actorName, card.value, card.suit, data.sortKey);
            }
            case Constants.COMMANDS.DECLARE:
                return this.declareSuit(data.suit);
            default:
                throw new UserNotification("Unknown match command.");
        }
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

                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    const actor = this.match.turnOrder.get(actorName);

                    this.#assertCanAct(actor);
                    actor.collection.sort(sortKey);

                    const usesPlayingRules =
                        this.match.state === Constants.ROOM_STATE.ACTIVE && this.match.turnOrder.ownerKey !== null;
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

                    this.#publishMutation();
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

                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    const actor = this.match.turnOrder.get(actorName);

                    this.#assertCanAct(actor);
                    actor.collection.sort(sortKey);

                    if (this.match.state === Constants.ROOM_STATE.ACTIVE && this.match.turnOrder.ownerKey !== null) {
                        const remainingDrawAllowance = Math.max(0, actor.drawAllowance);

                        if (remainingDrawAllowance > 0) {
                            drawnItems.push(...this.#drawItemsForActor(actor, remainingDrawAllowance));
                        }

                        actor.drawAllowance = 0;
                        this.#advanceTurn(1, 1);
                    }

                    actor.recordActivity();
                    this.#publishMutation();
                }
                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Serializes a legal discard, applies card effects, and advances or finishes the match.
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

                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    const actor = this.match.turnOrder.get(actorName);
                    const item = new Card(value, suit);

                    this.#assertCanAct(actor);
                    actor.collection.sort(sortKey);
                    this.#assertActorHasItem(actor, item);
                    this.#assertItemIsPlayable(item);

                    this.#applyDiscard(actor, item);
                    actor.recordActivity();

                    this.#publishMutation();
                }

                return drawnItems;
            }.bind(this)
        );
    }

    /**
     * Resolves the pending wild-card decision and advances to the next actor.
     *
     * @param {string} suit - Declared suit.
     * @returns {Promise<void>}
     */
    async declareSuit(suit) {
        return this._enqueue(
            /** Declares the pending suit inside the room queue. */
            function declareSuitOperation() {
                if (this.match.state !== Constants.ROOM_STATE.FINISHED) {
                    if (this.match.pending?.command !== Constants.COMMANDS.DECLARE) {
                        throw new UserNotification("No suit pending declaration.");
                    }

                    const actor = this.match.turnOrder.requireOwner();
                    this.match.declaredSuit = Room.normalizeSuit(suit);
                    this.match.pending = null;
                    this.match.state = Constants.ROOM_STATE.ACTIVE;

                    this.#advanceTurn(1, 1);
                    actor.recordActivity();
                    this.#publishMutation();
                }

            }.bind(this)
        );
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

    /**

     * Returns a departing actor’s cards to the draw collection and reshuffles it.
     * @param {Card[]} items - Released cards.
     */
    _storeReleasedItems(items) {
        this.match.collections.draw.addMany(items);
        this.match.collections.draw.shuffle();
    }

    /**

     * Restores a valid match or turn state after an actor leaves.
     * @param {Actor} actor - Departing Actor.
     * @param {string|null} viewerKey - Viewer tab to register, if any.
     * @param {boolean} wasKnockoutDuel - Whether a departure ended an active one-on-one.
     */
    #afterActorRemoved(actor, viewerKey, wasKnockoutDuel) {
        if (this.isMatchActive()) {
            if (this.match.turnOrder.actors.size < 2) {
                if (wasKnockoutDuel) {
                    const survivor = this.match.turnOrder.actors.values().next().value;
                    this.match.finishByForfeit(survivor, actor);
                } else {
                    this.match.resetMatchState();
                }
            } else {
                const isTurnOwnerRemoved =
                    this.match.turnOrder.ownerKey === null || this.match.turnOrder.ownerKey === actor.key;

                if (isTurnOwnerRemoved) {
                    this.#advanceTurn(1, 1);
                }
            }
        }

        if (this.match instanceof Knockout) this.match.afterActorRemoved();

        const normalizedViewerKey = Room.#optionalText(viewerKey);
        if (normalizedViewerKey) this.viewers.add(normalizedViewerKey);
        this.#publishMutation();
    }

    /** Applies the hosted idle policy to the currently eligible human actors. */
    _refreshIdleMonitoring() {
        for (const actor of this.match.turnOrder.actors.values()) {
            const isBot = actor instanceof BotActor;
            const awaitingKnockout = this.match.state === Constants.ROOM_STATE.FINISHED && this.match.nextMatchAvailable;
            const shouldTrack = !isBot && (!awaitingKnockout || actor.state === Constants.ACTOR_STATE.QUALIFIED) &&
                (!this.isMatchActive() || actor.key === this.match.turnOrder.ownerKey);

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

    /**

     * Serializes actor removal, item recovery, viewer conversion, activity, and publication.
     * @param {string} actorNameOrKey - Actor name or normalized key.
     * @param {string|null} viewerKey - Viewer tab to register, if any.
     * @returns {Promise<Actor>} Removed Actor.
     */
    async #removeActor(actorNameOrKey, viewerKey) {
        return this._enqueue(
            /** Removes an actor as one serialized room mutation. */
            function removeOperation() {
                const actor = this.match.turnOrder.get(actorNameOrKey);
                const wasKnockoutDuel = this.match instanceof Knockout && this.isMatchActive() &&
                    this.match.turnOrder.actors.size === 2;
                const items = actor.collection?.clear() ?? [];
                actor.stopIdleMonitoring();
                this.match.turnOrder.remove(actor.key);
                this._storeReleasedItems(items);
                this.#afterActorRemoved(actor, viewerKey, wasKnockoutDuel);
                return actor;
            }.bind(this)
        );
    }

    /**
     * Advances the turn to the next actor.
     *
     * @param {number} drawAllowance - Draw allowance for the next actor.
     * @param {number} steps - Number of actors to advance.
     */
    #advanceTurn(drawAllowance = 1, steps = 1) {
        const moved = this.match.turnOrder.move(steps);

        if (moved) {
            const actor = this.match.turnOrder.requireOwner();

            actor.drawAllowance = drawAllowance;
            actor.recordActivity();
        }
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
     * Asserts the room has enough actors to start a match.
     */
    #assertMinimumActorCount() {
        if (this.match.turnOrder.actors.size < 2) {
            throw new UserNotification("Need at least two actors.");
        }
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

    /**
     * Deals initial hands to all actors.
     */
    #dealInitialHands() {
        const totalNeeded = this.match.turnOrder.actors.size * Constants.INITIAL_ITEM_COUNT;

        this.#ensureDeckCapacity(totalNeeded);
        this.match.disperseItems("draw", Constants.INITIAL_ITEM_COUNT);
    }

    /**
     * Picks a random first actor.
     */
    #selectRandomFirstActor() {
        const actorKeys = Array.from(this.match.turnOrder.actors.keys());
        const randomIndex = Math.floor(Math.random() * actorKeys.length);

        this.match.turnOrder.setOwner(actorKeys[randomIndex]);
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

        if (this.match.pending !== null) {
            throw new UserNotification("Room is waiting for suit declaration.");
        }

        const isAnotherActorsTurn =
            this.match.state === Constants.ROOM_STATE.ACTIVE &&
            this.match.turnOrder.ownerKey !== null && this.match.turnOrder.ownerKey !== actor.key;

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
        const items = this.match.takeItems(actor.key, "draw", count);
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
        for (const actorItem of actor.collection) {
            if (actorItem.value === item.value && actorItem.suit === item.suit) {
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
     * @param {Actor} actor - Acting actor.
     * @param {Card} item - Card to play.
     */
    #applyDiscard(actor, item) {
        this.match.putItem(actor.key, "play", item);

        if (this.match.state === Constants.ROOM_STATE.ACTIVE) {
            this.match._lastDiscardActorKey = actor.key;
            actor.drawAllowance = 0;
            this.match.declaredSuit = null;

            if (item.isMatchEndingMove(actor.collection.items.length)) {
                this.match.finishMatch();
            } else if (item.isSuitChange()) {
                this.match.pending = { command: Constants.COMMANDS.DECLARE, actorKey: actor.key };
            } else {
                const actorCount = this.match.turnOrder.actors.size;

                if (item.isSkip(actorCount)) {
                    this.#advanceTurn(1, 2);
                } else if (item.isReverse(actorCount)) {
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

     * Normalizes optional external text without throwing.
     * @param {*} value - Optional input.
     * @returns {string} Trimmed text or empty text.
     */
    static #optionalText(value) {
        return typeof value === "string" ? value.trim() : "";
    }

    /**
     * Normalizes the Room actor limit.
     *
     * @param {*} value - Value.
     * @returns {number} Actor limit.
     * @throws {Error} When a value violates an internal room invariant.
     */
    static #normalizeActorLimit(value) {
        const isValid = Number.isInteger(value) && value >= 2 && value <= Constants.ROOM_ACTOR_LIMIT;

        if (!isValid) {
            throw new UserNotification(`Limit must be between 2 and ${Constants.ROOM_ACTOR_LIMIT}.`);
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
        return Constants.normalizeStandardSuit(
            ValidationUtils.namedString(value, "Room name", ValidationUtils.roomNameMaxLength)
        );
    }
}



/** Owns one ordinary match's cards, turn order, lifecycle, and outcome. */
export class Match extends Serializable {
    /** Creates a waiting match using the room's existing seated actors. */
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
        this._lastDiscardActorKey = null;
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

    /** Transfers a card from an actor into a match collection. */
    putItem(actorNameOrKey, destinationName, item) {
        const actor = this.turnOrder.get(actorNameOrKey);
        const destination = this.getCollection(destinationName);
        this.#assertTransferAllowed();
        return this.#moveItem(actor.collection, destination, item);
    }

    /** Transfers the top card from a match collection to an actor. */
    takeItem(actorNameOrKey, sourceName) {
        const actor = this.turnOrder.get(actorNameOrKey);
        const source = this.getCollection(sourceName);
        const item = source.peek();
        if (item === null) return null;
        this.#assertTransferAllowed();
        return this.#moveItem(source, actor.collection, item);
    }

    /** Transfers up to a requested number of cards to an actor. */
    takeItems(actorNameOrKey, sourceName, count) {
        ValidationUtils.nonNegativeInteger(count, "Item count");
        const items = [];
        for (let index = 0; index < count; index += 1) {
            const item = this.takeItem(actorNameOrKey, sourceName);
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

    /** Deals a fixed number of cards to every actor in turn order. */
    disperseItems(sourceName, count) {
        ValidationUtils.nonNegativeInteger(count, "Item count");
        const dispersed = [];
        for (let pass = 0; pass < count; pass += 1) {
            for (const actor of this.turnOrder) {
                const item = this.takeItem(actor.key, sourceName);
                if (item === null) return dispersed;
                dispersed.push(item);
            }
        }
        return dispersed;
    }

    /** Returns a discard by offset from the top. */
    getTopItem(offset = 0) {
        if (this.collections.play.items.length === 0) return null;
        const normalizedOffset = Math.abs(offset) % this.collections.play.items.length;
        const index = this.collections.play.items.length - 1 - normalizedOffset;
        return this.collections.play.items[index] ?? null;
    }

    /** Resolves the actor who made the latest active-match discard. */
    getLastDiscardActor() {
        return this._lastDiscardActorKey === null
            ? null : (this.turnOrder.actors.get(this._lastDiscardActorKey) ?? null);
    }

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

    /** Records ordinary lowest-penalty winners. */
    resolveOutcome() {
        let minimumPenalty = Infinity;
        for (const actor of this.turnOrder.actors.values()) {
            minimumPenalty = Math.min(minimumPenalty, actor.collection.penalty);
        }
        for (const actor of this.turnOrder.actors.values()) {
            actor.drawAllowance = 1;
            actor.state = actor.collection.penalty === minimumPenalty
                ? Constants.ACTOR_STATE.WON : Constants.ACTOR_STATE.LOST;
            actor.recordActivity();
        }
    }

    /** Applies the shared finished-match state after outcome resolution. */
    finishMatch() {
        this.resolveOutcome();
        this.pending = null;
        this.declaredSuit = null;
        this.state = Constants.ROOM_STATE.FINISHED;
    }

    /** Resets transient match state and actor hands before dealing. */
    resetMatchState() {
        this.pending = null;
        this.declaredSuit = null;
        this._lastDiscardActorKey = null;
        this.collections.play.clear();
        this.collections.draw = CardCollection.createDeck(true);
        this.state = Constants.ROOM_STATE.WAITING;
        this.turnOrder.reset();
        for (const actor of this.turnOrder.actors.values()) actor.recordActivity();
    }
}



/** Applies knockout elimination between otherwise ordinary Match matches. */
export class Knockout extends Match {
    /** Adds only the continuation state needed by a knockout. */
    constructor(turnOrder = new TurnOrder()) {
        super(turnOrder);
        this.nextMatchAvailable = false;
    }

    /** A finished knockout without two qualifiers is complete. */
    get isKnockoutComplete() {
        return this.state === Constants.ROOM_STATE.FINISHED && !this.nextMatchAvailable;
    }

    /** Excludes nonqualifiers at the next start, after results have remained visible. */
    prepareNextMatch() {
        if (!this.nextMatchAvailable) return;
        for (const actor of [...this.turnOrder.actors.values()]) {
            if (actor.state !== Constants.ACTOR_STATE.QUALIFIED) {
                actor.stopIdleMonitoring();
                this.turnOrder.remove(actor.key);
            }
        }
        this.nextMatchAvailable = false;
    }

    /** Uses elimination for three or more actors and ordinary results for a duel. */
    resolveOutcome() {
        if (this.turnOrder.actors.size <= 2) {
            this.nextMatchAvailable = false;
            super.resolveOutcome();
            return;
        }
        let highestPenalty = -Infinity;
        for (const actor of this.turnOrder.actors.values()) {
            highestPenalty = Math.max(highestPenalty, actor.collection.penalty);
        }
        for (const actor of this.turnOrder.actors.values()) {
            actor.drawAllowance = 1;
            actor.state = actor.collection.penalty === highestPenalty
                ? Constants.ACTOR_STATE.ELIMINATED : Constants.ACTOR_STATE.QUALIFIED;
            actor.recordActivity();
        }
        this.#resolveQualifiedOutcome();
    }

    /** Rechecks whether a departure leaves another match or a sole survivor. */
    afterActorRemoved() {
        if (this.state === Constants.ROOM_STATE.FINISHED && this.nextMatchAvailable) {
            this.#resolveQualifiedOutcome();
        }
    }

    /** Marks the remaining actor as winner of an abandoned one-on-one. */
    finishByForfeit(survivor, departed) {
        survivor.state = Constants.ACTOR_STATE.WON;
        departed.state = Constants.ACTOR_STATE.LOST;
        this.state = Constants.ROOM_STATE.FINISHED;
        this.nextMatchAvailable = false;
        this.pending = null;
        this.declaredSuit = null;
    }

    /** Resolves the surviving qualified actor or marks another match available. */
    #resolveQualifiedOutcome() {
        let count = 0;
        let survivor = null;
        for (const actor of this.turnOrder.actors.values()) {
            if (actor.state === Constants.ACTOR_STATE.QUALIFIED) {
                count += 1;
                survivor = actor;
            }
        }
        this.nextMatchAvailable = count >= 2;
        if (count === 1) survivor.state = Constants.ACTOR_STATE.WON;
    }
}
