"use strict";

import { HomeView, RoomView } from "./ui/View.js";
import { Constants } from "./core/Constants.js";


/**
 * Reports an application-level failure without replacing user-facing notifications.
 * @param {*} error - Application failure.
 */
function reportError(error) {
    console.error("Application error:", error);
}

/**
 * Reports uncaught browser errors through the shared application logger.
 * @param {ErrorEvent} event - Browser error event.
 */
function handleWindowError(event) {
    reportError(event.error ?? event.message);
}

/**
 * Reports unhandled promise rejections through the shared application logger.
 * @param {PromiseRejectionEvent} event - Rejection event.
 */
function handleUnhandledRejection(event) {
    reportError(event.reason);
}



window.addEventListener("error", handleWindowError);
window.addEventListener("unhandledrejection", handleUnhandledRejection);



try {
    const page = document.body.dataset.page;

    if (page === Constants.VIEWS.HOME) {
        const roomUrl = new URL("./room.html", document.baseURI);
        await new HomeView(roomUrl).start();
    } else if (page === Constants.VIEWS.ROOM) {
        const homeUrl = new URL("./index.html", location.href);
        await new RoomView(homeUrl).start();
    } else throw new Error(`Unknown page: ${page}`);
} catch (error) {
    reportError(error);
}
