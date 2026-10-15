/** Reads static opening-tag attributes without depending on their order or whitespace. */
export function elements(html, tag) {
    const result = [];
    const pattern = new RegExp(`<${tag}\\b([^<>]*)>`, "gi");
    for (const match of html.matchAll(pattern)) {
        const attributes = {};
        for (const attribute of match[1].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
            attributes[attribute[1]] = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
        }
        result.push(attributes);
    }
    return result;
}

/** Finds an element by its stable ID in static page markup. */
export function elementById(html, id) {
    const tags = [...new Set([...html.matchAll(/<([a-z][\w-]*)\b/gi)].map(match => match[1]))];
    for (const tag of tags) {
        const element = elements(html, tag).find(attributes => attributes.id === id);
        if (element) return element;
    }
    return null;
}
