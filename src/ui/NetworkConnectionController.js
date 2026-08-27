"use strict";

import { ClientStore } from "../client/ClientStore.js";
import { Constants } from "../core/Constants.js";
import { DomUtils } from "./DomUtils.js";
import { ViewController } from "./ViewController.js";

/** Controls the embedded Network-mode connection view. */
export class NetworkConnectionController extends ViewController {
    /** @type {HTMLElement} */
    #connectionStatus;

    /** @type {HTMLOutputElement} */
    #messageOutput;

    /** @type {HTMLOutputElement} */
    #originOutput;

    /** @type {HTMLButtonElement} */
    #retryButton;

    /** @type {HTMLButtonElement} */
    #useHostButton;

    /** @type {string|null} */
    #configuredUrl = null;

    /** @type {string|null} */
    #currentHostUrl = null;

    /** @type {string} */
    #configurationError = "";

    /** @type {Function|null} */
    #connectedHandler = null;

    /** @type {number} */
    #attempt = 0;

    /** @type {string|null} */
    #retryUrl = null;

    constructor() {
        super("#network-connection-view");
        this.#connectionStatus = DomUtils.require("#connection-status", HTMLElement);
        this.#messageOutput = DomUtils.require("#network-connection-message", HTMLOutputElement);
        this.#originOutput = DomUtils.require("#network-connection-origin", HTMLOutputElement);
        this.#retryButton = DomUtils.require("#network-connection-retry-button", HTMLButtonElement);
        this.#useHostButton = DomUtils.require(
            "#network-connection-use-host-button",
            HTMLButtonElement
        );
    }

    /** Binds the connection actions. */
    initialize() {
        this.#retryButton.addEventListener("click", () => this.connect(this.#retryUrl));
        this.#useHostButton.addEventListener("click", () => this.connect(this.#currentHostUrl));
    }

    /** @param {Function} handler - Verified-host callback. */
    setConnectedHandler(handler) {
        this.#connectedHandler = handler;
    }

    /** Cancels the active connection attempt. */
    cancel() {
        this.#attempt += 1;
    }

    /** @param {string|null} [preferredUrl=null] - Optional single host to retry. */
    async connect(preferredUrl = null) {
        const attempt = ++this.#attempt;
        this.#resolveHosts();
        const candidates = preferredUrl === null
            ? [...new Set([this.#configuredUrl, this.#currentHostUrl].filter(Boolean))]
            : [preferredUrl];

        if (candidates.length === 0) {
            this.render("unconfigured");
            return;
        }

        for (const networkUrl of candidates) {
            this.render("connecting", networkUrl);
            const isAvailable = await NetworkConnectionController.#check(networkUrl);

            if (attempt !== this.#attempt) {
                return;
            }

            if (isAvailable) {
                this.render("connected", networkUrl);
                this.#connectedHandler?.(networkUrl);
                return;
            }
        }

        this.render("error", candidates.at(-1), this.#configurationError);
    }

    /** @param {string} networkUrl - WebSocket URL to check. */
    static #check(networkUrl) {
        return new Promise((resolve) => {
            let settled = false;
            let socket;

            const finish = (isAvailable) => {
                if (settled) {
                    return;
                }

                settled = true;
                globalThis.clearTimeout(timer);
                socket?.close();
                resolve(isAvailable);
            };
            const timer = globalThis.setTimeout(
                () => finish(false),
                Constants.NETWORK_CONNECTION_TIMEOUT_MS
            );

            try {
                socket = new WebSocket(networkUrl);
                socket.addEventListener("open", () => finish(true), {once: true});
                socket.addEventListener("error", () => finish(false), {once: true});
            } catch (_error) {
                finish(false);
            }
        });
    }

    /** Resolves the optional configured host and the host serving this page. */
    #resolveHosts() {
        const configuredOrigin = ClientStore.getConfiguredServerOrigin();
        this.#configuredUrl = null;
        this.#configurationError = "";

        if (configuredOrigin !== null) {
            try {
                this.#configuredUrl = ClientStore.resolveNetworkUrl(configuredOrigin);
            } catch (error) {
                this.#configurationError = error instanceof Error
                    ? error.message
                    : String(error);
            }
        }

        try {
            this.#currentHostUrl = ClientStore.getCurrentHostUrl();
        } catch (_error) {
            this.#currentHostUrl = null;
        }
    }

    /**
     * Renders one connection state.
     *
     * @param {"connecting"|"reconnecting"|"connected"|"disconnected"|"error"|"unconfigured"} status - State to render.
     * @param {string} [origin=""] - Configured server address.
     * @param {string} [detail=""] - Optional error detail.
     */
    render(status, origin = "", detail = "") {
        const content = {
            connecting: {
                title: "Reaching the table…",
                message: "Checking the configured and local Pick 2 Network hosts."
            },
            reconnecting: {
                title: "Reconnecting to the table…",
                message: "The Network connection was interrupted. Trying the host again."
            },
            connected: {
                title: "Network found",
                message: "Connection confirmed. Refreshing Network sessions."
            },
            disconnected: {
                title: "Network disconnected",
                message: "Automatic reconnection stopped. Retry this host or return to Local mode."
            },
            error: {
                title: "Could not reach a Network host",
                message: detail || "Neither the configured host nor this site answered. Check the address or try this host again."
            },
            unconfigured: {
                title: "No Network host is available",
                message: "Open Pick 2 through its local app server or add a hosted address to pick-2-server-origin."
            }
        }[status];
        const statusLabel = {
            connecting: "connecting",
            reconnecting: "reconnecting",
            connected: "connected",
            disconnected: "disconnected",
            error: "connection error",
            unconfigured: "not configured"
        }[status];

        this.root.dataset.status = status;
        this.#connectionStatus.dataset.status = status;
        this.#connectionStatus.setAttribute("aria-label", `Connection mode. Network ${statusLabel}.`);
        DomUtils.requireChild(
            this.root,
            "#network-connection-title",
            HTMLHeadingElement
        ).textContent = content.title;
        this.#messageOutput.textContent = content.message;
        this.#originOutput.textContent = origin;
        this.#originOutput.hidden = origin === "";
        this.#retryUrl = origin || this.#configuredUrl;
        const isPending = status === "connecting" || status === "reconnecting";
        const isFailure = status === "disconnected" || status === "error" || status === "unconfigured";
        this.#retryButton.hidden = !isFailure || this.#retryUrl === null;
        this.#retryButton.disabled = isPending;
        this.#useHostButton.hidden = !isFailure || this.#currentHostUrl === null;
        this.#useHostButton.disabled = isPending;
    }
}
