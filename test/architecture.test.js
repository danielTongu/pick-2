import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import test from "node:test";

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
        ...sources(new URL("runtime/", root)),
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
        ...sources(new URL("runtime/", root)),
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
