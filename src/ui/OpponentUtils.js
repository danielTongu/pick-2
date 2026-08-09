
import { DomUtils } from "./DomUtils.js";
import { TemplateUtils } from "./TemplateUtils.js";
import { TurnUtils } from "../core/TurnUtils.js";

/**
 * Opponent player fragment.
 */
export class OpponentUtils extends TemplateUtils {
    /** @type {HTMLTemplateElement|null} */
    static template = null;

    /** @type {string} */
    static templateFile = "opponent.html";

    /** @type {string} */
    static templateId = "opponent-template";

    /** @type {string} */
    static componentUrl = import.meta.url;

    /** @type {string} */
    static rootClassName = "opponent";

    /**
     * Creates an opponent element using the shared circle ownership shape.
     *
     * @param {Object} player - Player payload.
     * @param {{turnOwnerKey:string|null}} circle - Player circle payload.
     * @returns {HTMLElement} Created opponent element.
     */
    static create(player, circle) {
        return super.create({
            ...player,
            turnOwnerKey: circle.turnOwnerKey
        });
    }

    /**
     * Updates an opponent player element with player model data.
     *
     * @param {HTMLElement} element - Opponent player element.
     * @param {Object} player - Player model snapshot.
     * @throws {Error}
     */
    static updateElement(element, player = {}) {
        super.updateElement(element, player);

        element.dataset.playerName = player.name;
        element.dataset.cardCount = String(player.hand.cards.length);

        DomUtils.setBooleanState(element, "isTurnOwner", TurnUtils.isTurnOwner(player.turnOwnerKey, player.key));
        DomUtils.setBooleanState(element, "isWinner", player.isWinner);
    }
}
