"use strict";

import { Serializable } from "./Serializable.js";
import { Constants } from "../shared/Constants.js";
import { ValidationUtils } from "../shared/ValidationUtils.js";
import { UserNotification } from "../shared/UserNotification.js";
import { TurnOrder } from "./TurnOrder.js";
import { CardCollection } from "./CardCollection.js";

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
