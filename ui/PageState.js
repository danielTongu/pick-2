"use strict";

/**
 * Stores page-to-page play mode and Room action intent for one browser tab.
 */
export class PageState {
    static #MODE_KEY = "pick2.mode";
    static #INTENT_KEY = "pick2.gameIntent";
    static #NOTICE_KEY = "pick2.notice";
    static #NETWORK_URL_KEY = "pick2.networkUrl";

    /** @returns {"local"|"network"} Selected play mode. */
    static getMode() {
        const queryMode = new URLSearchParams(globalThis.location?.search ?? "").get("mode");
        const savedMode = globalThis.sessionStorage?.getItem(this.#MODE_KEY);
        const requestedMode = queryMode ?? savedMode;
        return requestedMode === "network"
            ? "network"
            : "local";
    }

    /** @param {string} mode - Play mode. */
    static setMode(mode) {
        globalThis.sessionStorage?.setItem(this.#MODE_KEY, mode === "network" ? "network" : "local");
    }

    /** @param {Object} intent - Room action and data envelope. */
    static setIntent(intent) {
        globalThis.sessionStorage?.setItem(this.#INTENT_KEY, JSON.stringify(intent));
    }

    /** @returns {Object|null} Saved Room intent. */
    static getIntent() {
        try {
            const value = JSON.parse(globalThis.sessionStorage?.getItem(this.#INTENT_KEY) ?? "null");
            return typeof value === "object" && value !== null ? value : null;
        } catch (_error) {
            return null;
        }
    }

    /** Clears the saved Room intent. */
    static clearIntent() {
        globalThis.sessionStorage?.removeItem(this.#INTENT_KEY);
    }

    /** @param {Object} notice - Notification to show after page navigation. */
    static setNotice(notice) {
        if (typeof notice === "object" && notice !== null) {
            globalThis.sessionStorage?.setItem(this.#NOTICE_KEY, JSON.stringify(notice));
        }
    }

    /** @returns {Object|null} One pending notification, removed after reading. */
    static takeNotice() {
        const storage = globalThis.sessionStorage;
        const serialized = storage?.getItem(this.#NOTICE_KEY) ?? "null";
        storage?.removeItem(this.#NOTICE_KEY);

        try {
            const notice = JSON.parse(serialized);
            return typeof notice === "object" && notice !== null ? notice : null;
        } catch (_error) {
            return null;
        }
    }

    /** @param {string} url - Verified Network-mode WebSocket URL. */
    static setNetworkUrl(url) {
        globalThis.sessionStorage?.setItem(this.#NETWORK_URL_KEY, url);
    }

    /** Clears the last verified Network-mode URL. */
    static clearNetworkUrl() {
        globalThis.sessionStorage?.removeItem(this.#NETWORK_URL_KEY);
    }

    /** @returns {string|null} Configured server origin, when supplied. */
    static getConfiguredServerOrigin() {
        const origin = globalThis.document
            ?.querySelector('meta[name="pick-2-server-origin"]')
            ?.getAttribute("content")
            ?.trim();

        return origin || null;
    }

    /**
     * Resolves a server origin as a Network-mode WebSocket URL.
     *
     * @param {string|null} origin - Server origin to resolve.
     * @returns {string} WebSocket URL.
     */
    static resolveNetworkUrl(origin) {

        if (origin === null) {
            throw new Error("Server origin is not configured.");
        }

        const url = new URL(origin, globalThis.location?.href);
        const protocols = {
            "http:": "ws:",
            "https:": "wss:",
            "ws:": "ws:",
            "wss:": "wss:"
        };
        const protocol = protocols[url.protocol];

        if (protocol === undefined) {
            throw new Error(`Unsupported server protocol: ${url.protocol}`);
        }

        url.protocol = protocol;
        url.pathname = "/";
        url.search = "";
        url.hash = "";

        return url.href;
    }

    /** @returns {string|null} WebSocket URL for the host serving this page. */
    static getCurrentHostUrl() {
        const origin = globalThis.location?.origin;

        if (!origin || origin === "null") {
            return null;
        }

        return this.resolveNetworkUrl(origin);
    }

    /** @returns {string} Last verified or configured Network-mode WebSocket URL. */
    static getNetworkUrl() {
        const savedUrl = globalThis.sessionStorage?.getItem(this.#NETWORK_URL_KEY)?.trim();

        if (savedUrl) {
            return savedUrl;
        }

        const configuredOrigin = this.getConfiguredServerOrigin();

        if (configuredOrigin !== null) {
            return this.resolveNetworkUrl(configuredOrigin);
        }

        const currentHostUrl = this.getCurrentHostUrl();

        if (currentHostUrl === null) {
            throw new Error("Network host is not available.");
        }

        return currentHostUrl;
    }
}
