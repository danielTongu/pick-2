import assert from "node:assert/strict";
import test from "node:test";
import { TemplateUtils } from "../../ui/utilities/TemplateUtils.js";

for (const componentUrl of [undefined, "https://example.test/pick-2/ui/utilities/PlayerUtils.js"]) {
    test(`template loading resolves ${componentUrl ? "an explicit" : "the default"} module base`, async t => {
        const originals = new Map(["document", "fetch", "HTMLTemplateElement"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        t.after(() => {
            for (const [name, descriptor] of originals) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        });
        class FakeTemplate {}
        const template = new FakeTemplate();
        let requestedUrl;
        globalThis.HTMLTemplateElement = FakeTemplate;
        globalThis.document = { createElement() { return { content: { querySelector() { return template; } } }; } };
        globalThis.fetch = async url => {
            requestedUrl = url;
            return { ok: true, async text() { return '<template id="player-template"></template>'; } };
        };
        const loaded = await TemplateUtils.loadTemplate("player-template", componentUrl, "player.html");
        const base = componentUrl ?? new URL("../../ui/utilities/TemplateUtils.js", import.meta.url).href;
        assert.equal(requestedUrl, new URL("../templates/player.html", base).href);
        assert.equal(loaded, template);
    });
}
