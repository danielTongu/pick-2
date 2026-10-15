import { TemplateUtils } from "./TemplateUtils.js";
import { Constants } from "../../core/Constants.js";

/** Creates the shared player view. */
export class PlayerUtils extends TemplateUtils {
    /**
     * @type {HTMLTemplateElement|null} Lazily loaded and validated component template.
     */
    static template = null;

    /**
     * @type {string} Template path resolved relative to the owning module.
     */
    static templateFile = "player.html";

    /**
     * @type {string} Required template element identifier.
     */
    static templateId = "player-template";

    /**
     * @type {string} Module URL used as the template-resolution base.
     */
    static componentUrl = import.meta.url;

    /**
     * Rotates player snapshots to begin with the local player without mutating turn order.
     *
     * @param {Object[]|null} players - Players in authoritative turn order.
     * @param {string|null} localPlayerName - Local player name, when present.
     * @returns {Object[]} Players in local-first display order.
     */
    static localFirst(players, localPlayerName) {
        if (!Array.isArray(players)) return [];

        const localIndex = players.findIndex(function findLocal(player) {
            return player?.name === localPlayerName;
        });
        if (localIndex <= 0) return players;

        return players.slice(localIndex).concat(players.slice(0, localIndex));
    }

    /**
     * Applies player identity, state, turn ownership, and hidden item count to a player element.
     * @param {HTMLElement} element - Player element.
     * @param {Object} player - Player snapshot.
     */
    static updateElement(element, player) {
        super.updateElement(element, player);
        const count = Number(player.itemCount);
        const singular = player.pieceName;
        const plural = `${singular}s`;
        const isTurnOwner = player.state === Constants.PLAYER_STATE.ACTIVE;
        const states = [
            isTurnOwner ? "current turn" : "",
            player.state === Constants.PLAYER_STATE.WON ? "winner" : ""
        ].filter(Boolean);

        element.title = player.name;
        element.dataset.playerName = player.name;
        element.dataset.itemCount = String(count);
        element.setAttribute(
            "aria-label",
            `${player.name}, ${count} ${count === 1 ? singular : plural}${states.length > 0 ? `, ${states.join(", ")}` : ""}`
        );
        element.dataset.playerState = player.state;
    }
}
