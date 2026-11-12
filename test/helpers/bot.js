import { BotService } from "../../service/BotService.js";

/** Runs real decisions without the presentation delay. */
class ImmediateBotService extends BotService {
    /** Removes only the test service's action delay. */
    async _waitForTurnDelay() {}
}

export const immediateBots = new ImmediateBotService();

/** Adapts a controlled match and its command spies to the room-service contract. */
export function botRoomService(match) {
    return {
        room: { match }, revision: 0, automationSignal: new AbortController().signal,
        /** Routes executor unit-test decisions to command spies without changing strategy behavior. */
        async performBotCommand(player, _signal, command, data) {
            if (command === "discard") await match.playItem(player.name, data.card.value, data.card.suit);
            else if (command === "declare") await match.declareSuit(data.suit, player.name);
            else if (command === "pass") await match.passTurn(player.name);
            else await match.drawItems(player.name);
        }
    };
}
