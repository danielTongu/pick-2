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
    /** @type {HTMLInputElement} Editable host address. */
    #originInput;
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
    /** @type {(function(string): void)|null} Host address submit handler. */
    #onSubmit = null;

    /** Resolves the Connection page controls and diagnostic outputs. */
    constructor() {
        super("#connection-view");
        this.#connectionStatus = DomUtils.require("#app-header > aside[data-status]", HTMLElement);
        this.#statusLabelOutput = DomUtils.require("#connection-status-label", HTMLElement);
        this.#messageOutput = DomUtils.require("#connection-message", HTMLElement);
        this.#originInput = DomUtils.require("#connection-origin", HTMLInputElement);
        this.#connectButton = DomUtils.require("#connection-connect-button", HTMLButtonElement);
        this.#form = DomUtils.require("#connection-form", HTMLFormElement);
        this.#endpointOutput = DomUtils.require("#connection-endpoint", HTMLElement);
        this.#attemptOutput = DomUtils.require("#connection-attempt", HTMLElement);
        this.#durationOutput = DomUtils.require("#connection-duration", HTMLElement);
        this.#timeoutOutput = DomUtils.require("#connection-timeout", HTMLElement);
        this.#failureOutput = DomUtils.require("#connection-failure", HTMLElement);
    }

    /**
     * Binds host address submission.
     * @param {function(string): void} onSubmit - Receives the entered address.
     */
    initialize(onSubmit) {
        this.#onSubmit = onSubmit;
        this.#form.addEventListener("submit", this.#handleSubmit.bind(this));
    }

    /** @param {SubmitEvent} event - Host address form submission. */
    #handleSubmit(event) {
        event.preventDefault();
        this.#onSubmit(this.#originInput.value.trim());
    }

    /**
     * Renders one probe status and the diagnostics actually available in the browser.
     * @param {string} status - Connection status from Constants.CONNECTION_STATUS.
     * @param {{endpoint?:string, attempt?:number, candidate?:number, candidateCount?:number, elapsedMs?:number|null, failure?:string}} [metrics={}] - Probe diagnostics.
     */
    render(status, metrics = {}) {
        const statusLabel = {
            [Constants.CONNECTION_STATUS.CONNECTING]: "Checking host…",
            [Constants.CONNECTION_STATUS.CONNECTED]: "Host available",
            [Constants.CONNECTION_STATUS.ERROR]: "Connection error",
            [Constants.CONNECTION_STATUS.UNCONFIGURED]: "Not configured"
        }[status] ?? status;
        const endpoint = metrics.endpoint ?? "";
        const failure = metrics.failure ?? "";
        const elapsedMs = metrics.elapsedMs ?? null;
        const attempt = metrics.attempt ?? 0;
        const candidate = metrics.candidate ?? 0;
        const candidateCount = metrics.candidateCount ?? 0;

        this.root.dataset.status = status;
        this.root.dataset.endpoint = endpoint;
        this.root.dataset.attempt = String(attempt);
        this.root.dataset.candidate = String(candidate);
        this.root.dataset.candidateCount = String(candidateCount);
        this.root.dataset.elapsedMs = elapsedMs === null ? "" : String(elapsedMs);
        this.root.dataset.timeoutMs = String(Constants.CONNECTION_PROBE_TIMEOUT_MS);
        this.root.dataset.failure = failure ? "true" : "false";
        this.#connectionStatus.dataset.status = status;
        this.#connectionStatus.setAttribute("aria-label", `Hosted connection: ${statusLabel}`);
        this.#statusLabelOutput.textContent = statusLabel;
        this.#messageOutput.dataset.detail = failure;
        this.#endpointOutput.textContent = endpoint || "Not selected";
        this.#attemptOutput.textContent = attempt === 0 ? "—" :
            `#${attempt}${candidateCount > 1 ? ` · candidate ${candidate} of ${candidateCount}` : ""}`;
        this.#durationOutput.textContent = elapsedMs === null ? "—" : `${elapsedMs} ms`;
        this.#timeoutOutput.textContent = `${Constants.CONNECTION_PROBE_TIMEOUT_MS} ms`;
        this.#failureOutput.textContent = failure || "None";
        if (endpoint && status === Constants.CONNECTION_STATUS.CONNECTING) this.#originInput.value = endpoint;

        const isPending = status === Constants.CONNECTION_STATUS.CONNECTING;
        this.#connectButton.disabled = isPending;
        this.#connectButton.textContent = isPending ? "Connecting…" : "Connect to host";
    }
}
