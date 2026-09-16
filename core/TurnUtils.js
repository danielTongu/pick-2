"use strict";

/** Turn-ownership predicates shared by domain and browser code. */
export class TurnUtils {
    /** Returns whether a turn-owner key is assigned. */
    static hasTurnOwner(ownerKey) {
        return typeof ownerKey === "string" && ownerKey.length > 0;
    }

    /** Returns whether an actor owns the current turn. */
    static isTurnOwner(ownerKey, actorKey) {
        return TurnUtils.hasTurnOwner(ownerKey) && ownerKey === actorKey;
    }
}
