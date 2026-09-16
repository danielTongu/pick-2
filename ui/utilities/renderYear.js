"use strict";

/** Updates the shared copyright date on each page. */
export function renderYear() {
    const element = document.querySelector("#copyright-year");

    if (element instanceof HTMLTimeElement) {
        const year = String(new Date().getFullYear());
        element.dateTime = year;
        element.textContent = year;
    }
}
