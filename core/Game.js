"use strict";

import { Constants } from "./Constants.js";
import { Room } from "./Room.js";
import { Card } from "./Card.js";
import { BotActor } from "./BotActor.js";
import { StateMapper } from "./StateMapper.js";
import { ValidationUtils } from "./ValidationUtils.js";

/** Defines Pick2's rules and hosting contract. */
export class Game {
    /** Creates the immutable Pick 2 hosting contract and command throttle profile. */
    constructor() {
        this.id = "pick2";
        this.constants = Constants;
        this.stateMapper = StateMapper;
        this.RoomType = Room;
        this.welcomeMessage = Constants.NOTIFICATIONS.PLAYER_WELCOME.message;
        this.commands = Object.freeze({
            draw: Object.freeze({ player: 400, room: 100 }),
            discard: Object.freeze({ player: 250, room: 100 }),
            return: Object.freeze({ player: 250, room: 100 }),
            pass: Object.freeze({ player: 250, room: 100 }),
            declare: Object.freeze({ player: 250, room: 100 })
        });
    }

    /**

     * Creates a game-specific room through the configured Room type.
     * @param {string} name - Room name.
     * @param {number} actorLimit - Maximum seated actors.
     * @returns {Room} New game Room.
     */
    createRoom(name, actorLimit) {
        return new Room(name, actorLimit);
    }

    /**

     * Dispatches one authenticated game command to Room and returns an optional draw notification.
     * @param {Room} room - Target Room.
     * @param {string} playerName - Authenticated Player name.
     * @param {string} command - Canonical game command.
     * @param {Object} data - Command payload.
     * @returns {Promise<Object|null>} Draw notification, if any.
     */
    async execute(room, playerName, command, data) {
        let drawn = [];
        let mocked = true;

        if (room.state === Constants.ROOM_STATE.FINISHED) {
            await room.resumeWaiting();
        }

        switch (command) {
            case Constants.COMMANDS.DRAW:
                drawn = await room.drawItems(playerName, data.sortKey);
                mocked = room.state === Constants.ROOM_STATE.ACTIVE && drawn.length > 1;
                break;
            case Constants.COMMANDS.DISCARD: {
                const card = Card.from(data.card);
                drawn = await room.playItem(playerName, card.value, card.suit, data.sortKey);
                break;
            }
            case Constants.COMMANDS.RETURN: {
                const card = Card.from(data.card);
                await room.returnItem(playerName, card.value, card.suit, data.sortKey);
                break;
            }
            case Constants.COMMANDS.PASS:
                drawn = await room.passTurn(playerName, data.sortKey);
                break;
            case Constants.COMMANDS.DECLARE:
                await room.declareSuit(
                    Constants.normalizeStandardSuit(ValidationUtils.requiredString(data.suit, "Suit"))
                );
                break;
        }

        if (drawn.length === 0) return null;
        const emoji = mocked ? `\n\n${Constants.EMOJIS.silly.random}` : "";
        return {
            status: Constants.STATUS.INFO,
            title: Constants.NOTIFICATIONS.CARDS_DRAWN_TITLE,
            message: `+${drawn.length} ${emoji}`
        };
    }

    /**

     * Runs the current automated owner after its configured human-like delay.
     * @param {Room} room - Room whose Bot may own the turn.
     * @returns {Promise<boolean>} Whether a Bot acted.
     */
    async runAutomatedTurn(room) {
        const turnOwner = room.turnOrder.owner;
        if (!(turnOwner instanceof BotActor) || room.state !== Constants.ROOM_STATE.ACTIVE) return false;
        if (room.pending?.command === Constants.COMMANDS.DECLARE) {
            await turnOwner.chooseSuit(room);
            return true;
        }
        await turnOwner.takeTurn(room);
        return true;
    }
}
