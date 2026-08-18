"use strict";

import { ClientStore } from "./ClientStore.js";

/** Checks whether the configured server accepts WebSocket connections. */
export class ServerStatus {
    /**
     * @param {number} [timeoutMs=1200] - Probe timeout.
     * @returns {Promise<boolean>} Whether the server is available.
     */
    static check(timeoutMs = 1200) {
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
            const timer = globalThis.setTimeout(() => finish(false), timeoutMs);

            try {
                socket = new WebSocket(ClientStore.getServerUrl());
                socket.addEventListener("open", () => finish(true), {once: true});
                socket.addEventListener("error", () => finish(false), {once: true});
            } catch (_error) {
                finish(false);
            }
        });
    }
}
