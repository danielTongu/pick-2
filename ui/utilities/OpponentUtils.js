import { DomUtils } from "./DomUtils.js";
import { TemplateUtils } from "./TemplateUtils.js";
import { Constants } from "../../core/Constants.js";

/** Creates the shared opponent actor view. */
export class OpponentUtils extends TemplateUtils {
    /**
     * @type {HTMLTemplateElement|null} Lazily loaded and validated component template.
     */
    static template = null;

    /**
     * @type {string} Template path resolved relative to the owning module.
     */
    static templateFile = "opponent.html";

    /**
     * @type {string} Required template element identifier.
     */
    static templateId = "opponent-template";

    /**
     * @type {string} Module URL used as the template-resolution base.
     */
    static componentUrl = import.meta.url;

    /**
     * Creates and initializes an opponent element.
     * @param {Object} actor - Opponent actor snapshot.
     * @param {string|null} turnOwnerKey - Current turn owner key.
     * @param {string} pieceName - Name for the actor's items.
     * @returns {HTMLElement} Opponent element.
     */
    static create(actor, turnOwnerKey, pieceName) {
        return super.create({ ...actor, turnOwnerKey, pieceName });
    }

    /**
     * Applies actor identity, state, turn ownership, and hidden item count to an opponent element.
     * @param {HTMLElement} element - Opponent element.
     * @param {Object} actor - Opponent actor snapshot.
     */
    static updateElement(element, actor) {
        super.updateElement(element, actor);
        const count = Number(actor.itemCount);
        const singular = actor.pieceName;
        const plural = `${singular}s`;
        const isTurnOwner = actor.turnOwnerKey === actor.key;
        const states = [
            isTurnOwner ? "current turn" : "",
            actor.state === Constants.ACTOR_STATE.WON ? "winner" : ""
        ].filter(Boolean);

        element.dataset.actorName = actor.name;
        element.dataset.itemCount = String(count);
        element.setAttribute(
            "aria-label",
            `${actor.name}, ${count} ${count === 1 ? singular : plural}${states.length > 0 ? `, ${states.join(", ")}` : ""}`
        );
        DomUtils.setBooleanState(element, "isTurnOwner", isTurnOwner);
        DomUtils.setBooleanState(element, "isWinner", actor.state === Constants.ACTOR_STATE.WON);
    }
}
