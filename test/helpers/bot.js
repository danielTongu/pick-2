import { BotPlayer } from "../../core/BotPlayer.js";

/** Runs the real bot decision without its presentation delay. */
export class ImmediateBot extends BotPlayer {
    async _waitForTurnDelay() {}
}
