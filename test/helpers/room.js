import { Room } from "../../core/Room.js";
import { Card } from "../../core/Card.js";
import { Constants } from "../../core/Constants.js";

export function stopIdleMonitoring(room) {
    for (const player of room.match.turnOrder.players.values()) {
        player.stopIdleMonitoring();
    }
}

export async function createPlayingRoom(t, playerNames = ["Alice", "Bob", "Casey"]) {
    const room = new Room("Rules Room", playerNames.length);
    t.after(() => stopIdleMonitoring(room));

    for (const name of playerNames) {
        await room.joinPlayer(name);
    }

    room.match.state = Constants.ROOM_STATE.ACTIVE;
    room.match.turnOrder.setOwner(playerNames[0]);
    room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)];

    for (const player of room.match.turnOrder.players.values()) {
        player.collection.clear();
        player.drawAllowance = 1;
    }

    return room;
}

