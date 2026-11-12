import { RoomService } from "../../service/RoomService.js";
import { Card } from "../../model/Card.js";
import { Constants } from "../../shared/Constants.js";

/** Releases all idle resources owned by a test room service. */
export function stopIdleMonitoring(service) {
    service.stopIdleMonitoring();
}

/** Creates a controlled active match with cleanup attached to the test lifetime. */
export async function createPlayingRoomService(t, playerNames = ["Alice", "Bob", "Casey"]) {
    const service = new RoomService("Rules Room", playerNames.length);
    t.after(() => stopIdleMonitoring(service));

    for (const name of playerNames) {
        await service.joinPlayer(name);
    }

    service.room.match.state = Constants.ROOM_STATE.ACTIVE;
    service.room.match.turnOrder.setOwner(playerNames[0]);
    service.room.match.collections.play.items = [new Card(Constants.CARD.VALUE.FIVE.id, Constants.CARD.SUIT.HEARTS)];

    for (const player of service.room.match.turnOrder.players.values()) {
        player.collection.clear();
        player.drawAllowance = 1;
    }

    return service;
}
