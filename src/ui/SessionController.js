"use strict";

import { Constants } from "../core/Constants.js";
import { NormalizeUtils } from "../core/NormalizeUtils.js";
import { TurnUtils } from "../core/TurnUtils.js";
import { AlertController } from "./AlertController.js";
import { CountdownController } from "./CountdownController.js";
import { DomUtils } from "./DomUtils.js";
import { SessionEndController } from "./SessionEndController.js";
import { LocalPlayerController } from "./LocalPlayerController.js";
import { NotificationUtils } from "./NotificationUtils.js";
import { OpponentUtils } from "./OpponentUtils.js";
import { PlayingCard } from "./PlayingCard.js";
import { SessionRowUtils } from "./SessionRowUtils.js";
import { SuitSelectionController } from "./SuitSelectionController.js";
import { ViewController } from "./ViewController.js";

/** Controls the session page for both Local and Server play. */
export class SessionController extends ViewController {
    /** @type {Object|null} */
    #session = null;

    /** @type {Object} */
    #capabilities = {};

    /** @type {{action:string,payload:Object}|null} */
    #intent = null;

    /** @type {Function|null} */
    #gameHandler = null;

    /** @type {Function|null} */
    #readyHandler = null;

    /** @type {string} */
    #previousStatus = "";

    /** @type {boolean} */
    #hasOpened = false;

    /** @type {boolean} */
    #isLeaving = false;

    /** @type {AlertController} */
    #alertController = new AlertController("#alert-dialog");

    /** @type {LocalPlayerController} */
    #playerController = new LocalPlayerController("#local-player-region");

    /** @type {SuitSelectionController} */
    #suitController = new SuitSelectionController("#suit-selection-dialog");

    /** @type {CountdownController} */
    #countdownController = new CountdownController("#countdown-dialog");

    /** @type {SessionEndController} */
    #sessionEndController = new SessionEndController("#session-end-dialog");

    /** Creates the shared session controller. */
    constructor() {
        super("#session-view");
    }

    /** @param {Object} client - Active game client. */
    setClient(client) {
        this.client = client;
    }

    /** @param {{action:string,payload:Object}} intent - Initial session action. */
    setIntent(intent) {
        this.#intent = intent;
    }

    /** @param {Function} handler - Game-navigation callback. */
    setGameHandler(handler) {
        this.#gameHandler = handler;
    }

    /** @param {Function} handler - Successful session-open callback. */
    setReadyHandler(handler) {
        this.#readyHandler = handler;
    }

    /** Loads session dependencies and binds controls. */
    async initialize() {
        await Promise.all([SessionRowUtils.load(), OpponentUtils.load()]);
        PlayingCard.setDiscardTarget("#discard-pile");
        this.#playerController.initialize();
        this.#playerController.setActionHandler((action) => {
            if (SessionController.#isCardMove(action)) {
                this.#sendCardMove(action);
            } else {
                this.client?.send(action);
            }
        });
        this.#playerController.setSortHandler((sortKey) => {
            this.client.sortKey = NormalizeUtils.requiredString(sortKey, "Sort key");
            this.render(this.#session);
        });
        this.#suitController.setSubmitHandler((suit) => {
            this.client?.send(Constants.ACTIONS.DECLARE, {suit});
        });
        DomUtils.require("#discard-pile", HTMLElement).addEventListener("card_drop", (event) => {
            if (event instanceof CustomEvent && event.detail?.card) {
                this.#sendCardMove(Constants.ACTIONS.DISCARD, {card: event.detail.card});
            }
        });
        DomUtils.require("#leave-session-button", HTMLButtonElement).addEventListener("click", () => {
            this.#isLeaving = true;
            this.client?.send(Constants.ACTIONS.LEAVE);
        });
        DomUtils.require("#join-session-button", HTMLButtonElement).addEventListener("click", () => {
            this.#join();
        });
        DomUtils.require("#copy-invite-button", HTMLButtonElement).addEventListener("click", () => {
            void this.#copyInvite();
        });
    }

    /** Sends the initial session action after connection. */
    handleClientOpen() {
        if (this.#intent === null) {
            this.#gameHandler?.();
            return;
        }

        let action = this.#intent.action;

        if (this.#hasOpened && action === Constants.ACTIONS.CREATE) {
            action = Constants.ACTIONS.JOIN;
        }

        this.#hasOpened = true;
        this.client?.send(action, this.#intent.payload);
    }

    /** Routes shared game and session synchronization responses. */
    handleSync(view, sync) {
        if (view === Constants.VIEWS.SESSION) {
            this.#capabilities = NormalizeUtils.object(sync.capabilities ?? {}, "Capabilities");
            this.#readyHandler?.(sync);
            this.render(sync);
        } else if (view === Constants.VIEWS.GAME && this.#isLeaving) {
            this.#gameHandler?.();
        }
    }

    /** Shows a canonical notification. */
    handleNotification(message) {
        if (this.#session === null && !this.#isLeaving) {
            this.#gameHandler?.(message);
            return;
        }

        this.#alertController.show(NotificationUtils.normalize(message));
    }

    /** Updates the connection badge. */
    handleConnectionStatus(status, label) {
        const root = DomUtils.require("#connection-status", HTMLElement);
        root.dataset.status = status;
        DomUtils.require("#connection-status-label", HTMLElement).textContent = label;
    }

    /** Stores and renders one session state. */
    render(session) {
        if (session === null) {
            return;
        }

        const previousStatus = this.#previousStatus;
        const nextStatus = NormalizeUtils.optionalString(session.status, "");
        const localPlayer = SessionController.#getLocalPlayer(session);

        this.#session = session;
        this.#previousStatus = nextStatus;
        this.#suitController.hide();
        this.#renderSessionInformation(session);
        this.#renderPlayers(session);
        this.#renderDiscardPile(session.discardPile);
        this.#renderLocalPlayer(localPlayer, session);
        this.#renderSessionActions(localPlayer);

        if (
            localPlayer !== null &&
            previousStatus === Constants.STATUS.WAITING &&
            nextStatus === Constants.STATUS.PLAYING
        ) {
            this.#countdownController.show(5);
        }

        if (
            session.status === Constants.STATUS.PENDING &&
            localPlayer !== null &&
            TurnUtils.isTurnOwner(session.circle?.turnOwnerKey, localPlayer.key)
        ) {
            this.#suitController.show();
        }

        if (localPlayer !== null && session.status === Constants.STATUS.FINISHED) {
            this.#sessionEndController.show(session);
        }
    }

    /** Sends a card move and resets local sorting after acceptance. */
    #sendCardMove(action, payload = {}) {
        if (this.client?.send(action, payload)) {
            this.client.sortKey = Constants.CARD.SORT_OPTIONS[0];
            this.render(this.#session);
        }
    }

    /** @returns {boolean} Whether an action commits card order. */
    static #isCardMove(action) {
        return action === Constants.ACTIONS.DRAW ||
            action === Constants.ACTIONS.DISCARD ||
            action === Constants.ACTIONS.PASS;
    }

    /** Renders session metadata. */
    #renderSessionInformation(session) {
        DomUtils.require("#session-play-area", HTMLElement).dataset.sessionStatus = session.status;
        DomUtils.require("#session-info-table-body", HTMLTableSectionElement)
            .replaceChildren(SessionRowUtils.create(session));
    }

    /** Renders all non-local players. */
    #renderPlayers(session) {
        const container = DomUtils.require("#opponent-player-list", HTMLElement);
        const localName = session.localPlayerName ?? null;
        container.replaceChildren();

        for (const player of SessionController.#getPlayers(session)) {
            if (player.name !== localName) {
                container.appendChild(OpponentUtils.create(player, session.circle));
            }
        }
    }

    /** Renders discard cards. */
    #renderDiscardPile(discardPile) {
        const cards = Array.isArray(discardPile) ? discardPile : [];
        DomUtils.require("#discard-pile", HTMLElement)
            .replaceChildren(...cards.map((card) => PlayingCard.create(card)));
    }

    /** Renders the local player's hand and controls. */
    #renderLocalPlayer(player, session) {
        if (player === null) {
            this.#playerController.hide();
            return;
        }

        this.#playerController.setCanRestartFinishedSession(this.#capabilities.restart === true);
        this.#playerController.show(player, session, this.client.sortKey);
        const idleWarning = document.querySelector("#local-player-idle-warning");

        if (idleWarning instanceof HTMLElement) {
            idleWarning.hidden = session.mode === "local";
        }
    }

    /** Shows actions supported by the current server. */
    #renderSessionActions(localPlayer) {
        DomUtils.require("#leave-session-button", HTMLButtonElement).hidden = false;
        DomUtils.require("#join-session-button", HTMLButtonElement).hidden =
            localPlayer !== null || this.#capabilities.join !== true;
        DomUtils.require("#copy-invite-button", HTMLButtonElement).hidden =
            this.#capabilities.invite !== true;
    }

    /** Joins the viewed session as a player. */
    #join() {
        const playerName = window.prompt("Enter your name:");

        if (playerName?.trim() && this.#session?.name) {
            this.client?.send(Constants.ACTIONS.JOIN, {
                sessionName: this.#session.name,
                playerName
            });
        }
    }

    /** Copies a Server session link. */
    async #copyInvite() {
        if (!this.#session?.name) {
            return;
        }

        const base = new URL("../", location.href);
        const url = new URL("session/", base);
        url.searchParams.set("mode", "server");
        url.searchParams.set("session", this.#session.name);

        try {
            await navigator.clipboard.writeText(url.href);
            this.handleNotification({status: Constants.STATUS.INFO, title: "Invite copied", message: "The session link is ready to share."});
        } catch (_error) {
            this.handleNotification({status: Constants.STATUS.ERROR, title: "Copy failed", message: "Copy the address from your browser instead."});
        }
    }

    /** @returns {Object[]} Session players. */
    static #getPlayers(session) {
        return Array.isArray(session?.circle?.players) ? session.circle.players : [];
    }

    /** @returns {Object|null} Local player. */
    static #getLocalPlayer(session) {
        const playerName = session?.localPlayerName ?? null;
        return SessionController.#getPlayers(session).find((player) => player.name === playerName) ?? null;
    }
}
