"use strict";

/** Rotates actor snapshots for local-first display without mutating turn order. */
export class PlayerDisplayUtils {
    /** Returns actors in circle order rotated to begin with the local actor. */
    static localFirst(actors, localActorName) {
        if (!Array.isArray(actors)) return [];

        const localIndex = actors.findIndex(function findLocal(actor) {
            return actor?.name === localActorName;
        });
        if (localIndex <= 0) return actors;

        return actors.slice(localIndex).concat(actors.slice(0, localIndex));
    }
}
