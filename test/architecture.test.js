import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);

function sources(directory) {
    const result = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const url = new URL(entry.name, directory);
        if (entry.isDirectory()) result.push(...sources(new URL(`${entry.name}/`, directory)));
        else if (entry.name.endsWith(".js")) result.push(url);
    }
    return result;
}

/** Returns application declarations that do not have adjacent JSDoc. */
function undocumentedDeclarations(source) {
    const lines = source.split("\n");
    const missing = [];
    let classDepth = 0;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const isClass = /^\s*(?:export\s+)?(?:default\s+)?class\s+\w+/.test(line);
        const isFunction = /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(line);
        const isMethod =
            classDepth > 0 && /^    (?:(?:static|async|get|set)\s+)*(?:#|_)?[A-Za-z]\w*\s*\([^;]*\)\s*\{/.test(line);
        const isField = classDepth > 0 && /^    (?:static\s+)?#?[A-Za-z]\w*\s*(?:=|;)/.test(line);

        if (isClass || isFunction || isMethod || isField) {
            let previous = index - 1;
            while (previous >= 0 && lines[previous].trim() === "") previous -= 1;
            if (previous < 0 || !lines[previous].trim().endsWith("*/")) {
                missing.push(`${index + 1}: ${line.trim()}`);
            }
        }

        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        if (isClass) classDepth = opens - closes;
        else if (classDepth > 0) classDepth += opens - closes;
    }

    return missing;
}

test("all application imports resolve from the Pick2 root", () => {
    const files = [
        ...sources(new URL("core/", root)),
        ...sources(new URL("host/", root)),
        ...sources(new URL("ui/", root)),
        new URL("main.js", root),
        new URL("server.js", root)
    ];
    for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/(?:from\s*|import\s*\()?["'](\.[^"']+\.js)["']/g)) {
            assert.ok(existsSync(new URL(match[1], file)), `${file.pathname}: missing ${match[1]}`);
        }
    }
    assert.equal(existsSync(new URL("cards/", root)), false);
});

test("application classes, fields, methods, and functions have adjacent JSDoc", () => {
    const files = [
        ...sources(new URL("core/", root)),
        ...sources(new URL("host/", root)),
        ...sources(new URL("ui/", root)),
        new URL("main.js", root),
        new URL("server.js", root)
    ].filter(function excludeTests(file) {
        return !file.pathname.includes("/test/");
    });

    for (const file of files) {
        const missing = undocumentedDeclarations(readFileSync(file, "utf8"));
        assert.deepEqual(missing, [], `${file.pathname}\n${missing.join("\n")}`);
    }
});

/** Reads all application source files below a directory. */
function sourceContents(directory) {
    return sources(directory).map(file => readFileSync(file, "utf8"));
}

test("browser and Node runtime import graphs stay separate", () => {
    const host = readFileSync(new URL("../host/Host.js", import.meta.url), "utf8");
    const transport = readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8");
    const view = readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8");
    const hostedServer = readFileSync(new URL("../server.js", import.meta.url), "utf8");

    assert.doesNotMatch(host, /from ["'](?:node:|express|ws)/);
    assert.doesNotMatch(host, /\b(?:document|localStorage|sessionStorage|WebSocket)\b/);
    assert.doesNotMatch(transport, /from ["'](?:node:|express|ws)/);
    assert.match(view, /from "\.\.\/host\/Host\.js"/);
    assert.match(hostedServer, /from "\.\/host\/Host\.js"/);
    assert.match(hostedServer, /from "node:/);
    assert.match(hostedServer, /from "ws"/);
    assert.doesNotMatch(hostedServer, /class HostedServer/);
    assert.match(hostedServer, /function startServer\(port\)/);
    assert.match(hostedServer, /async function stopServer\(\)/);
    assert.doesNotMatch(hostedServer, /ConnectionChannel/);
});

test("application source uses explicit, named control flow", () => {
    const source = [
        readFileSync(new URL("../ui/Session.js", import.meta.url), "utf8"),
        readFileSync(new URL("../main.js", import.meta.url), "utf8"),
        sourceContents(new URL("../core/", import.meta.url)).join("\n"),
        sourceContents(new URL("../host/", import.meta.url)).join("\n"),
        sourceContents(new URL("../ui/", import.meta.url)).join("\n")
    ].join("\n");

    assert.doesNotMatch(source, /=>/);
    assert.doesNotMatch(source, /\boptions\s*=\s*\{\}/);
});

test("page controllers depend on Session rather than runtime services", () => {
    const homeController = readFileSync(new URL("../ui/controllers/HomeController.js", import.meta.url), "utf8");
    const gameController = readFileSync(new URL("../ui/controllers/RoomController.js", import.meta.url), "utf8");

    for (const source of [homeController, gameController]) {
        assert.doesNotMatch(source, /Static|ConnectionService|LocalGameService|ServerSessionController/);
        assert.match(source, /this\.view/);
    }

    assert.match(homeController, /row\.addEventListener\("click"/);
    assert.match(homeController, /row\.addEventListener\("keydown"/);
    assert.match(homeController, /row\.tabIndex = 0/);
    assert.match(homeController, /Constants\.COMMANDS\.VIEW, \{\s*roomName\s*\}/);
    assert.doesNotMatch(homeController, /this\.#capabilities\.viewers === true/);
    assert.match(homeController, /cell\.textContent = "No rooms available\."/);
    assert.match(homeController, /for \(const input of \[this\.#directModeInput, this\.#hostedModeInput\]\)/);
    assert.match(homeController, /input\.value/);
    assert.match(homeController, /registrationMode === "join" && !isRoomListed/);
    assert.match(homeController, /Constants\.ACTION_NOTIFICATIONS\.ROOM_NOT_FOUND/);
    assert.match(gameController, /this\.room === null && !this\.#isLeaving/);
});
