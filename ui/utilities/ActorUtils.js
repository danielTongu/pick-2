import { TemplateUtils } from "./TemplateUtils.js";
import { Constants } from "../../core/Constants.js";

/** Creates the shared actor view. */
export class ActorUtils extends TemplateUtils {
    /**
     * @type {HTMLTemplateElement|null} Lazily loaded and validated component template.
     */
    static template = null;

    /**
     * @type {string} Template path resolved relative to the owning module.
     */
    static templateFile = "actor.html";

    /**
     * @type {string} Required template element identifier.
     */
    static templateId = "actor-template";

    /**
     * @type {string} Module URL used as the template-resolution base.
     */
    static componentUrl = import.meta.url;

    /**
     * Applies actor identity, state, turn ownership, and hidden item count to an actor element.
     * @param {HTMLElement} element - Actor element.
     * @param {Object} actor - Actor snapshot.
     */
    static updateElement(element, actor) {
        super.updateElement(element, actor);
        const count = Number(actor.itemCount);
        const singular = actor.pieceName;
        const plural = `${singular}s`;
        const isTurnOwner = actor.state === Constants.ACTOR_STATE.ACTIVE;
        const states = [
            isTurnOwner ? "current turn" : "",
            actor.state === Constants.ACTOR_STATE.WON ? "winner" : ""
        ].filter(Boolean);

        element.title = actor.name;
        element.dataset.actorName = actor.name;
        element.dataset.itemCount = String(count);
        element.setAttribute(
            "aria-label",
            `${actor.name}, ${count} ${count === 1 ? singular : plural}${states.length > 0 ? `, ${states.join(", ")}` : ""}`
        );
        element.dataset.actorState = actor.state;
    }
}
