"use strict";

import { configuration } from "../config.js";

/** Persists transport, navigation, and notification state for one browser tab. */
export class SessionState {
    // ---- Transport mode ----

    /**
     * @returns {"direct"|"hosted"} Selected mode, otherwise Hosted when configured or Direct.
     */
    static getMode() {
        return this.getModePreference() ?? (this.getConfiguredServerOrigin() === null ? "direct" : "hosted");
    }

    /**
     * @returns {"direct"|"hosted"|null} URL-selected or stored mode, if valid.
     */
    static getModePreference() {
        const queryMode = new URLSearchParams(globalThis.location?.search ?? "").get("mode");
        const savedMode = globalThis.sessionStorage?.getItem(this.#key("mode"));
        const requestedMode = queryMode ?? savedMode;

        return requestedMode === "hosted" || requestedMode === "direct" ? requestedMode : null;
    }

    /**
     * @param {"direct"|"hosted"} mode - Transport mode to persist.
     */
    static setMode(mode) {
        globalThis.sessionStorage?.setItem(this.#key("mode"), mode === "hosted" ? "hosted" : "direct");
    }

    // ---- Room admission and navigation notices ----

    /**
     * @param {{mode:"direct"|"hosted", command:string, data:Record<string, *>}} intent - Room command and navigation data to persist.
     */
    static setIntent(intent) {
        globalThis.sessionStorage?.setItem(this.#key("gameIntent"), JSON.stringify(intent));
    }

    /**
     * @returns {{mode:"direct"|"hosted", command:string, data:Record<string, *>}|null} Parsed Room intent, or null when absent or malformed.
     */
    static getIntent() {
        try {
            const value = JSON.parse(globalThis.sessionStorage?.getItem(this.#key("gameIntent")) ?? "null");
            return typeof value === "object" && value !== null ? value : null;
        } catch (_error) {
            return null;
        }
    }

    /** Clears the saved Room intent. */
    static clearIntent() {
        globalThis.sessionStorage?.removeItem(this.#key("gameIntent"));
    }

    /**
     * @param {Record<string, *>} notice - Notification to show after navigation.
     */
    static setNotice(notice) {
        if (typeof notice === "object" && notice !== null) {
            globalThis.sessionStorage?.setItem(this.#key("notice"), JSON.stringify(notice));
        }
    }

    /**
     * @returns {Record<string, *>|null} Pending notification, removed from storage before parsing.
     */
    static takeNotice() {
        const storage = globalThis.sessionStorage;
        const serialized = storage?.getItem(this.#key("notice")) ?? "null";
        storage?.removeItem(this.#key("notice"));

        try {
            const notice = JSON.parse(serialized);
            return typeof notice === "object" && notice !== null ? notice : null;
        } catch (_error) {
            return null;
        }
    }

    // ---- Hosted address configuration ----

    /**
     * @returns {string|null} Trimmed configured server origin, when supplied.
     */
    static getConfiguredServerOrigin() {
        const origin = configuration.hostedOrigin.trim();

        return origin || null;
    }

    /**
     * Resolves a server origin as a Hosted server origin.
     *
     * @param {string|null} origin - Server origin to resolve.
     * @returns {string} HTTP origin.
     * @throws {Error} When the origin is absent or uses an unsupported protocol.
     */
    static resolveHostedUrl(origin) {
        if (origin === null) {
            throw new Error("Server origin is not configured.");
        }

        const url = new URL(origin);
        if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error(`Unsupported server protocol: ${url.protocol}`);
        }
        if (url.username || url.password) {
            throw new Error("Host addresses cannot include credentials.");
        }

        url.pathname = "/";
        url.search = "";
        url.hash = "";

        return url.href;
    }

    /**
     * @returns {string} HTTP deployment origin derived exclusively from the configured server origin.
     * @throws {Error} When no Hosted server is configured.
     */
    static getHostedUrl() {
        return this.resolveHostedUrl(this.getConfiguredServerOrigin());
    }

    /**
     * Namespaces persisted navigation fields by the current game.
     * @param {string} name - Navigation preference or intent field.
     * @returns {string} Browser-tab storage key.
     */
    static #key(name) {
        return `${globalThis.document?.body?.dataset.game ?? "game"}.${name}`;
    }
}
