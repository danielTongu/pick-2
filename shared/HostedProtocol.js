"use strict";

import { Constants } from "./Constants.js";

/** Shared WebSocket endpoint, handshake version, and canonical Hosted commands. */
export class HostedProtocol {
    /** @type {string} Exact upgrade path; credentials never belong in this URL. */
    static PATH = "/live";

    /** @type {number} Deadline for opening and authenticating one connection attempt. */
    static CONNECTION_TIMEOUT_MS = 5000;

    /** @type {number} Ready-frame protocol version. */
    static VERSION = 2;

    /** @type {readonly string[]} All room and gameplay commands use the same channel. */
    static COMMANDS = Object.freeze(Object.values(Constants.COMMANDS));
}
