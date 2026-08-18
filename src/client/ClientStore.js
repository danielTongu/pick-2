"use strict";

/**
 * Stores page-to-page play mode and session action intent for one browser tab.
 */
export class ClientStore {
    static #MODE_KEY = "pick2.mode";
    static #INTENT_KEY = "pick2.sessionIntent";
    static #NOTICE_KEY = "pick2.notice";

    /** @returns {"local"|"server"} Selected play mode. */
    static getMode() {
        const queryMode = new URLSearchParams(globalThis.location?.search ?? "").get("mode");
        const savedMode = globalThis.sessionStorage?.getItem(this.#MODE_KEY);
        return queryMode === "server" || (queryMode === null && savedMode === "server")
            ? "server"
            : "local";
    }

    /** @param {string} mode - Play mode. */
    static setMode(mode) {
        globalThis.sessionStorage?.setItem(this.#MODE_KEY, mode === "server" ? "server" : "local");
    }

    /** @param {Object} intent - Session action and payload. */
    static setIntent(intent) {
        globalThis.sessionStorage?.setItem(this.#INTENT_KEY, JSON.stringify(intent));
    }

    /** @returns {Object|null} Saved session intent. */
    static getIntent() {
        try {
            const value = JSON.parse(globalThis.sessionStorage?.getItem(this.#INTENT_KEY) ?? "null");
            return typeof value === "object" && value !== null ? value : null;
        } catch (_error) {
            return null;
        }
    }

    /** Clears the saved session intent. */
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

    /**
     * Resolves the configured Server-mode WebSocket URL.
     *
     * @returns {string} WebSocket URL.
     */
    static getServerUrl() {
        const configuredOrigin = globalThis.document
            ?.querySelector('meta[name="pick-2-server-origin"]')
            ?.getAttribute("content")
            ?.trim();
        const origin = configuredOrigin || globalThis.location?.origin || "http://localhost";
        const url = new URL(origin);

        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/";
        url.search = "";
        url.hash = "";
        return url.href;
    }
}
