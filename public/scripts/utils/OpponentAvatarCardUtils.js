// public/fragments/opponents/OpponentAvatarCardUtils.js

import { DomUtils } from "./DomUtils.js";
import { TemplateComponentUtils } from "./TemplateComponentUtils.js";

/**
 * OpponentAvatarCardUtils player fragment.
 */
export class OpponentAvatarCardUtils extends TemplateComponentUtils {
    /** @type {HTMLTemplateElement|null} */
    static template = null;

    /** @type {string} */
    static templateFile = "opponent-avatar-card.html";

    /** @type {string} */
    static templateId = "opponent-avatar-card-template";

    /** @type {string} */
    static componentUrl = import.meta.url;

    /** @type {string} */
    static rootClassName = "opponent-avatar-card";

    /**
     * Updates an opponent player element with player model data.
     *
     * @param {HTMLElement} element - OpponentAvatarCardUtils player element.
     * @param {Object} player - Player model snapshot.
     * @throws {Error}
     */
    static updateElement(element, player = {}) {
        super.updateElement(element, player);

        element.dataset.playerName = player.name;
        element.dataset.cardCount = String(player.cardCount);

        DomUtils.setBooleanState(element, "isActive", player.isActive);
        DomUtils.setBooleanState(element, "isWinner", player.isWinner);
    }
}
