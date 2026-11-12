"use strict";

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuration } from "../config.js";

/**
 * @param {string} file - Absolute asset path.
 * @param {import("express").Request} _request - HTTP request.
 * @param {import("express").Response} response - HTTP response.
 */
function serveFile(file, _request, response) {
    response.sendFile(file);
}

/**
 * @param {import("express").Request} _request - HTTP request.
 * @param {import("express").Response} response - HTTP response.
 */
function serveHealth(_request, response) {
    response.status(200).send("OK");
}

/**
 * Serves approved browser assets and deployment health independently of process startup.
 * @param {string} hostedOrigin - Public HTTP(S) origin; empty selects Local mode.
 * @returns {import("express").Express} Configured HTTP application.
 */
export function createApplication(hostedOrigin = configuration.hostedOrigin) {
    if (hostedOrigin !== "") {
        const origin = new URL(hostedOrigin);
        if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
            origin.pathname !== "/" || origin.search || origin.hash) {
            throw new Error("Invalid GAME_SERVER_ORIGIN: expected an HTTP(S) origin or empty string.");
        }
        hostedOrigin = origin.origin;
    }

    /**
     * Publishes only the deployment's public endpoint without stale-cache reuse.
     * @param {import("express").Request} _request - HTTP request.
     * @param {import("express").Response} response - HTTP response.
     */
    function serveConfiguration(_request, response) {
        response.set("Cache-Control", "no-store").type("application/javascript")
            .send(`export const configuration = ${JSON.stringify({ hostedOrigin })};\n`);
    }

    /**
     * Allows browser entry points, Local-play modules, templates, styles, and card images.
     * @param {import("express").Request} request - HTTP request.
     * @param {import("express").Response} response - HTTP response.
     * @param {Function} next - Static asset middleware.
     */
    function inspectAsset(request, response, next) {
        const allowed = /^\/(?:index\.html|room\.html|connection\.html|main\.js|sitemap\.xml|(?:model|service|host|shared)\/[A-Za-z0-9_-]+\.js|ui\/(?:[A-Za-z0-9_-]+\.js|(?:controllers|utilities)\/[A-Za-z0-9_-]+\.js|styles\/[A-Za-z0-9_-]+\.css|templates\/[A-Za-z0-9_-]+\.html|images\/[A-Za-z0-9_-]+\.png))$/;
        if (allowed.test(request.path)) next();
        else response.sendStatus(404);
    }

    const app = express();
    const repositoryPath = fileURLToPath(new URL("../", import.meta.url));

    app.disable("x-powered-by");
    app.get("/config.js", serveConfiguration);
    app.get("/", serveFile.bind(null, path.join(repositoryPath, "index.html")));
    app.get("/health", serveHealth);
    app.use(inspectAsset, express.static(repositoryPath, { index: false, redirect: false, dotfiles: "deny" }));

    return app;
}
