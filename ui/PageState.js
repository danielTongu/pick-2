"use strict";

/**
 * Stores page-to-page play mode and Room command intent for one browser tab.
 */
export class PageState {
    /** Returns the storage-key namespace shared by both pages. */
    static #namespace() {
        return globalThis.document?.body?.dataset.game ?? "game";
    }
    /** Returns the session key for the selected connection mode. */
    static get #MODE_KEY() {
        return `${this.#namespace()}.mode`;
    }
    /** Returns the session key for pending room navigation intent. */
    static get #INTENT_KEY() {
        return `${this.#namespace()}.gameIntent`;
    }
    /** Returns the session key for a notification carried across navigation. */
    static get #NOTICE_KEY() {
        return `${this.#namespace()}.notice`;
    }
    /** Returns the session key for the verified hosted WebSocket URL. */
    static get #HOSTED_URL_KEY() {
        return `${this.#namespace()}.hostedUrl`;
    }

    /** @returns {"direct"|"hosted"} Selected play mode. */
    static getMode() {
        return this.getModePreference() ?? "direct";
    }

    /** @returns {"direct"|"hosted"|null} Explicitly selected mode, if any. */
    static getModePreference() {
        const queryMode = new URLSearchParams(globalThis.location?.search ?? "").get("mode");
        const savedMode = globalThis.sessionStorage?.getItem(this.#MODE_KEY);
        const requestedMode = queryMode ?? savedMode;

        return requestedMode === "hosted" || requestedMode === "direct" ? requestedMode : null;
    }

    /** @param {string} mode - Play mode. */
    static setMode(mode) {
        globalThis.sessionStorage?.setItem(this.#MODE_KEY, mode === "hosted" ? "hosted" : "direct");
    }

    /** @param {Object} intent - Room command and data envelope. */
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

    /** @param {string} url - Verified Hosted-mode WebSocket URL. */
    static setHostedUrl(url) {
        globalThis.sessionStorage?.setItem(this.#HOSTED_URL_KEY, url);
    }

    /** Clears the last verified Hosted-mode URL. */
    static clearHostedUrl() {
        globalThis.sessionStorage?.removeItem(this.#HOSTED_URL_KEY);
    }

    /** @returns {string|null} Configured server origin, when supplied. */
    static getConfiguredServerOrigin() {
        const origin = globalThis.document
            ?.querySelector('meta[name="game-server-origin"]')
            ?.getAttribute("content")
            ?.trim();

        return origin || null;
    }

    /**
     * Resolves a server origin as a Hosted-mode WebSocket URL.
     *
     * @param {string|null} origin - Server origin to resolve.
     * @returns {string} WebSocket URL.
     */
    static resolveHostedUrl(origin) {
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

        return this.resolveHostedUrl(origin);
    }

    /** @returns {string} Last verified or configured Hosted-mode WebSocket URL. */
    static getHostedUrl() {
        const savedUrl = globalThis.sessionStorage?.getItem(this.#HOSTED_URL_KEY)?.trim();

        if (savedUrl) {
            return savedUrl;
        }

        const configuredOrigin = this.getConfiguredServerOrigin();

        if (configuredOrigin !== null) {
            return this.resolveHostedUrl(configuredOrigin);
        }

        const currentHostUrl = this.getCurrentHostUrl();

        if (currentHostUrl === null) {
            throw new Error("Network host is not available.");
        }

        return currentHostUrl;
    }
}
