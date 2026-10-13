"use strict";

import { Constants } from "../../core/Constants.js";
import { DomUtils } from "../utilities/DomUtils.js";
import { ViewController } from "./ViewController.js";

/** Owns the Connection page form, status, and probe diagnostics. */
export class ConnectionController extends ViewController {
    /** @type {HTMLElement} Shared header connection status. */
    #connectionStatus;

    /** @type {HTMLElement} Visible header connection status label. */
    #statusLabelOutput;

    /** @type {HTMLElement} Status message and failure detail. */
    #messageOutput;

    /** @type {HTMLElement} Configured Live server label. */
    #originOutput;

    /** @type {HTMLButtonElement} Host probe command. */
    #connectButton;

    /** @type {HTMLFormElement} Host address form. */
    #form;

    /** @type {HTMLElement} Endpoint diagnostic value. */
    #endpointOutput;

    /** @type {HTMLElement} Probe attempt diagnostic value. */
    #attemptOutput;

    /** @type {HTMLElement} Duration diagnostic value. */
    #durationOutput;

    /** @type {HTMLElement} Timeout diagnostic value. */
    #timeoutOutput;
    /** @type {HTMLElement} Failure diagnostic value. */
    #failureOutput;

    /** @type {(function(): void)|null} Retry command handler. */
    #onSubmit = null;

    /** Resolves the Connection page controls and diagnostic outputs. */
    constructor() {
        super("#connection-view");
        this.#connectionStatus = DomUtils.require("#app-header > aside", HTMLElement);
        this.#statusLabelOutput = DomUtils.require("#connection-status-label", HTMLElement);
        this.#messageOutput = DomUtils.require("#connection-message", HTMLElement);
        this.#originOutput = DomUtils.require("#connection-origin", HTMLElement);
        this.#connectButton = DomUtils.require("#connection-connect-button", HTMLButtonElement);
        this.#form = DomUtils.require("#connection-form", HTMLFormElement);
        this.#endpointOutput = DomUtils.require("#connection-endpoint", HTMLElement);
        this.#attemptOutput = DomUtils.require("#connection-attempt", HTMLElement);
        this.#durationOutput = DomUtils.require("#connection-duration", HTMLElement);
        this.#timeoutOutput = DomUtils.require("#connection-timeout", HTMLElement);
        this.#failureOutput = DomUtils.require("#connection-failure", HTMLElement);
    }

    /**
     * Binds retry and mode selection.
     * @param {function(): void} onSubmit - Retries the configured server.
     * @param {function(string): void} onMode - Receives the selected mode.
     */
    initialize(onSubmit, onMode) {
        this.#onSubmit = onSubmit;
        this.#form.addEventListener("submit", this.#handleSubmit.bind(this));
        DomUtils.require("#direct-mode-input", HTMLInputElement).addEventListener("change", function selectLocal() { onMode("direct"); });
        DomUtils.require("#hosted-mode-input", HTMLInputElement).addEventListener("change", function selectLive() { onMode("hosted"); });
    }

    /** @param {SubmitEvent} event - Retry form submission. */
    #handleSubmit(event) {
        event.preventDefault();
        this.#onSubmit();
    }

    /**
     * Renders one probe status and the diagnostics actually available in the browser.
     * @param {string} status - Connection status from Constants.CONNECTION_STATUS.
     * @param {{endpoint?:string, attempt?:number, candidate?:number, candidateCount?:number, elapsedMs?:number|null, failure?:string}} [metrics={}] - Probe diagnostics.
     */
    render(status, metrics = {}) {
        const statusLabel = {
            [Constants.CONNECTION_STATUS.CONNECTING]: "Connecting…",
            [Constants.CONNECTION_STATUS.CONNECTED]: "Connected",
            [Constants.CONNECTION_STATUS.ERROR]: "Unavailable",
            [Constants.CONNECTION_STATUS.UNCONFIGURED]: "Not configured"
        }[status] ?? status;
        const endpoint = metrics.endpoint ?? "";
        const failure = metrics.failure ?? "";
        const elapsedMs = metrics.elapsedMs ?? null;
        const attempt = metrics.attempt ?? 0;
        const candidate = metrics.candidate ?? 0;
        const candidateCount = metrics.candidateCount ?? 0;

        this.root.dataset.endpoint = endpoint;
        this.root.dataset.attempt = String(attempt);
        this.root.dataset.candidate = String(candidate);
        this.root.dataset.candidateCount = String(candidateCount);
        this.root.dataset.elapsedMs = elapsedMs === null ? "" : String(elapsedMs);
        this.root.dataset.timeoutMs = String(Constants.CONNECTION_PROBE_TIMEOUT_MS);
        this.root.dataset.failure = failure ? "true" : "false";
        DomUtils.require("body", HTMLElement).dataset.connectionStatus = status;
        this.#connectionStatus.setAttribute("aria-label", `Connection mode. Live ${statusLabel}.`);
        this.#statusLabelOutput.textContent = statusLabel;
        this.#messageOutput.dataset.detail = failure;
        this.#endpointOutput.textContent = endpoint || "Not configured";
        this.#attemptOutput.textContent = attempt === 0 ? "—" :
            `#${attempt}${candidateCount > 1 ? ` · candidate ${candidate} of ${candidateCount}` : ""}`;
        this.#durationOutput.textContent = elapsedMs === null ? "—" : `${elapsedMs} ms`;
        this.#timeoutOutput.textContent = `${Constants.CONNECTION_PROBE_TIMEOUT_MS} ms`;
        this.#failureOutput.textContent = failure || "None";
        this.#originOutput.textContent = endpoint || "Not configured";
        DomUtils.require("#hosted-mode-input", HTMLInputElement).checked = true;
        DomUtils.require("#direct-mode-input", HTMLInputElement).checked = false;

        const isPending = status === Constants.CONNECTION_STATUS.CONNECTING;
        this.#connectButton.disabled = isPending || status === Constants.CONNECTION_STATUS.UNCONFIGURED;
        this.#connectButton.textContent = isPending ? "Connecting…" : "Retry Live";
    }
}
