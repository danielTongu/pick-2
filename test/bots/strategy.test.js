"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { Player } from "../../model/Player.js";
import { BotStrategy } from "../../service/BotStrategy.js";
import { immediateBots } from "../helpers/bot.js";
import { BotPlayer } from "../../model/BotPlayer.js";
import { Card } from "../../model/Card.js";
import { CardCollection } from "../../model/CardCollection.js";
import { Constants } from "../../shared/Constants.js";
import { RoomService } from "../../service/RoomService.js";

/** Creates deterministic hands, turn neighbors, and match collections. */
function scenario(t, { hand, play = ["5-hearts"], previous = ["3-clubs", "4-clubs", "6-clubs", "9-clubs"],
    next = ["3-diamonds"], direction = 1, allowance = 1, declaredSuit = null, draw = ["10-spades"] }) {
    const card = id => {
        const [value, suit] = id.split("-");
        return new Card(value, suit, 0);
    };
    const service = new RoomService("Bot Scenario", 3);
    const bot = new BotPlayer("Bot");
    const before = new Player("Previous", { drawAllowance: 1 });
    const after = new Player("Next", { drawAllowance: 1 });
    before.collection.addMany(previous.map(card));
    bot.collection.addMany(hand.map(card));
    after.collection.addMany(next.map(card));
    for (const player of [before, bot, after]) service.room.match.turnOrder.add(player);
    service.room.match.turnOrder.direction = direction;
    service.room.match.turnOrder.setOwner(bot.key);
    service.room.match.state = Constants.ROOM_STATE.ACTIVE;
    service.room.match.declaredSuit = declaredSuit;
    service.room.match.collections.play = new CardCollection(play.map(card));
    service.room.match.collections.draw = new CardCollection(draw.map(card));
    bot.drawAllowance = allowance;
    t.after(() => {
        service.stopIdleMonitoring();
    });
    return { service, bot, before, after };
}

for (const example of [
    { name: "skip bypasses the next one-card opponent", hand: ["8-hearts", "q-hearts", "6-spades"],
        selected: "8-hearts", owner: "previous", directionAfter: 1 },
    { name: "skip avoids sending play to a previous one-card opponent", hand: ["8-hearts", "q-hearts", "6-spades"],
        previous: ["3-clubs"], next: ["3-diamonds", "4-diamonds", "6-diamonds", "9-diamonds"],
        selected: "q-hearts", owner: "next", directionAfter: 1 },
    { name: "reverse sends play away from the next one-card opponent", hand: ["j-hearts", "q-hearts", "6-spades"],
        selected: "j-hearts", owner: "previous", directionAfter: -1 },
    { name: "reverse avoids the previous one-card opponent", hand: ["j-hearts", "q-hearts", "6-spades"],
        previous: ["3-clubs"], next: ["3-diamonds", "4-diamonds", "6-diamonds", "9-diamonds"],
        selected: "q-hearts", owner: "next", directionAfter: 1 },
    { name: "reverse respects an already reversed turn order", hand: ["j-hearts", "q-hearts", "6-spades"],
        previous: ["3-clubs"], next: ["3-diamonds", "4-diamonds", "6-diamonds", "9-diamonds"], direction: -1,
        selected: "j-hearts", owner: "next", directionAfter: 1 },
    { name: "skip respects an already reversed turn order", hand: ["8-hearts", "q-hearts", "6-spades"],
        previous: ["3-clubs"], next: ["3-diamonds", "4-diamonds", "6-diamonds", "9-diamonds"], direction: -1,
        selected: "8-hearts", owner: "next", directionAfter: -1 }
]) {
    test(`bot against both neighboring hands: ${example.name}`, async t => {
        const { service, bot, before, after } = scenario(t, example);
        const previousHand = before.collection.items.map(String);
        const nextHand = after.collection.items.map(String);
        await immediateBots.takeTurn(bot, service);
        assert.deepEqual(service.room.match.collections.play.items.map(String), ["5-hearts", example.selected]);
        assert.equal(service.room.match.turnOrder.ownerKey, example.owner);
        assert.equal(service.room.match.turnOrder.direction, example.directionAfter);
        assert.equal(bot.collection.items.length, example.hand.length - 1);
        assert.equal(bot.collection.items.some(card => card.id === example.selected), false);
        assert.deepEqual(before.collection.items.map(String), previousHand);
        assert.deepEqual(after.collection.items.map(String), nextHand);
    });
}

for (const example of [
    { name: "uses the top of the play collection rather than an older matching discard",
        hand: ["q-clubs", "9-hearts"], play: ["5-clubs", "5-hearts"], selected: "9-hearts" },
    { name: "uses a declared suit after an ace",
        hand: ["q-hearts", "9-clubs"], play: ["5-hearts", "a-diamonds"], declaredSuit: "clubs", selected: "9-clubs" },
    { name: "answers a draw-two attack instead of playing an ordinary suit match",
        hand: ["2-clubs", "q-hearts"], play: ["2-hearts"], allowance: 2, selected: "2-clubs", nextAllowance: 2 },
    { name: "uses the ace of spades to block an attack",
        hand: ["a-spades", "q-clubs"], play: ["2-hearts"], allowance: 2, selected: "a-spades", nextAllowance: 1 }
]) {
    test(`bot hand against Match play collection: ${example.name}`, async t => {
        const { service, bot, after } = scenario(t, example);
        await immediateBots.takeTurn(bot, service);
        assert.deepEqual(service.room.match.collections.play.items.map(String), [...example.play, example.selected]);
        assert.equal(service.room.match.turnOrder.ownerKey, after.key);
        assert.equal(bot.collection.items.length, example.hand.length - 1);
        if (example.nextAllowance !== undefined) assert.equal(after.drawAllowance, example.nextAllowance);
    });
}

test("bot draws when its entire hand is illegal against the top discard", async t => {
    const { service, bot } = scenario(t, { hand: ["q-clubs", "9-diamonds"] });
    await immediateBots.takeTurn(bot, service);
    assert.deepEqual(service.room.match.collections.play.items.map(String), ["5-hearts"]);
    assert.deepEqual(bot.collection.items.map(String), ["q-clubs", "9-diamonds", "10-spades"]);
    assert.equal(bot.drawAllowance, 0);
    assert.equal(service.room.match.turnOrder.ownerKey, bot.key);
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.turnOrder.ownerKey, "next");
});

test("bot's final legal card finishes the match and records the opponents' results", async t => {
    const { service, bot, before, after } = scenario(t, { hand: ["9-hearts"] });
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.getTopItem().id, "9-hearts");
    assert.equal(bot.collection.items.length, 0);
    assert.equal(service.room.match.state, Constants.ROOM_STATE.FINISHED);
    assert.equal(bot.state, Constants.PLAYER_STATE.WON);
    assert.equal(before.state, Constants.PLAYER_STATE.LOST);
    assert.equal(after.state, Constants.PLAYER_STATE.LOST);
});

test("bot leaves its hand and play collection untouched after losing turn ownership", async t => {
    const { service, bot, after } = scenario(t, { hand: ["q-hearts", "6-spades"] });
    service.room.match.turnOrder.setOwner(after.key);
    await immediateBots.takeTurn(bot, service);
    assert.deepEqual(bot.collection.items.map(String), ["q-hearts", "6-spades"]);
    assert.deepEqual(service.room.match.collections.play.items.map(String), ["5-hearts"]);
    assert.equal(service.room.match.turnOrder.ownerKey, after.key);
});

for (const example of [
    { name: "releases the ace of spades after a nonmatching draw when the next opponent has two cards",
        next: ["3-diamonds", "4-diamonds"], draw: ["10-clubs"], selected: "a-spades" },
    { name: "preserves the ace of spades after a nonmatching draw when the next opponent has one card",
        next: ["3-diamonds"], draw: ["10-clubs"], selected: null },
    { name: "plays a matching drawn card before spending the ace of spades",
        next: ["3-diamonds", "4-diamonds"], draw: ["10-spades"], selected: "10-spades" },
    { name: "plays a matching drawn card even when the next opponent has one card",
        next: ["3-diamonds"], draw: ["10-spades"], selected: "10-spades" }
]) {
    test(`bot shield after drawing: ${example.name}`, async t => {
        const { service, bot, after } = scenario(t, {
            hand: ["a-spades", "q-hearts"], play: ["5-spades"], next: example.next, draw: example.draw
        });
        await immediateBots.takeTurn(bot, service);
        assert.equal(bot.drawAllowance, 0);
        assert.deepEqual(service.room.match.collections.play.items.map(String), ["5-spades"]);
        assert.deepEqual(bot.collection.items.map(String), ["a-spades", "q-hearts", ...example.draw]);
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.turnOrder.ownerKey, after.key);
        assert.deepEqual(service.room.match.collections.play.items.map(String),
            example.selected === null ? ["5-spades"] : ["5-spades", example.selected]);
        assert.equal(bot.collection.items.some(card => card.id === "a-spades"), example.selected !== "a-spades");
    });
}

test("shield release after drawing checks the next opponent in reversed turn order", async t => {
    const { service, bot, before } = scenario(t, {
        hand: ["a-spades", "q-hearts"], play: ["5-spades"], direction: -1,
        previous: ["3-clubs"], next: ["3-diamonds", "4-diamonds"], draw: ["10-clubs"]
    });
    await immediateBots.takeTurn(bot, service);
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.turnOrder.ownerKey, before.key);
    assert.deepEqual(service.room.match.collections.play.items.map(String), ["5-spades"]);
    assert.equal(bot.collection.items.some(card => card.id === "a-spades"), true);
});

test("hard-mode strategy inspects reachable opponent hands and never the draw collection", t => {
    const { service, bot } = scenario(t, { hand: ["j-hearts", "q-hearts", "6-spades"] });
    const distant = new Player("Distant", { drawAllowance: 1 });
    distant.collection.addMany([new Card("9", "clubs", 0)]);
    const skipped = new Player("Skipped", { drawAllowance: 1 });
    skipped.collection.add(new Card("6", "diamonds", 0));
    service.room.match.turnOrder.add(skipped);
    service.room.match.turnOrder.add(distant);
    const reverseFollowing = new Player("Reverse Following", { drawAllowance: 1 });
    reverseFollowing.collection.add(new Card("6", "diamonds", 0));
    service.room.match.turnOrder.add(reverseFollowing);
    distant.collection.items = new Proxy(distant.collection.items, {
        get(target, property) {
            assert.equal(property, "length", "distant cards must stay unknown");
            return target.length;
        }
    });
    Object.defineProperty(service.room.match.collections, "draw", {
        get() { throw new Error("draw collection must stay private"); }
    });
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "j-hearts");
});

/** Makes the inferred unseen pool deterministic using only public discards. */
function exposeOtherCards(service, bot, unseenIds) {
    const hidden = new Set([...unseenIds, ...bot.collection.items.map(card => card.id), "5-hearts"]);
    const seen = CardCollection.createDeck(false).items.filter(card => !hidden.has(card.id));
    service.room.match.collections.play = new CardCollection([...seen, new Card("5", "hearts", 0)]);
}

for (const example of [
    { name: "attacks when the next hand has no defense", next: ["3-diamonds", "4-diamonds"], unseen: ["3-clubs", "4-clubs", "6-clubs"], selected: "2-hearts" },
    { name: "keeps an attack when the next hand has a defense", next: ["2-clubs", "4-diamonds"], unseen: ["2-clubs", "2-diamonds", "a-spades"], selected: "q-hearts" }
]) {
    test(`bot attack opportunity: ${example.name}`, t => {
        const { service, bot } = scenario(t, { hand: ["2-hearts", "q-hearts", "6-spades"], next: example.next });
        exposeOtherCards(service, bot, example.unseen);
        assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, example.selected);
    });
}

for (const example of [
    { name: "ends with more cards when its remaining penalty is safely lower", hand: ["7-hearts", "3-clubs", "4-clubs"],
        opponent: "9", unseen: ["q-clubs", "k-clubs", "10-clubs"], selected: "7-hearts" },
    { name: "avoids ending when opponents likely hold lower penalty", hand: ["7-hearts", "q-hearts", "3-clubs"],
        opponent: "4", unseen: ["3-diamonds", "4-diamonds", "5-diamonds"], selected: "q-hearts" }
]) {
    test(`bot penalty estimate: ${example.name}`, t => {
        const { service, bot } = scenario(t, { hand: example.hand, previous: [`${example.opponent}-clubs`], next: [`${example.opponent}-diamonds`] });
        exposeOtherCards(service, bot, example.unseen);
        assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, example.selected);
    });
}

test("bot declares a less answerable held suit against a one-card opponent", t => {
    const { service, bot } = scenario(t, { hand: ["a-diamonds", "q-hearts", "3-hearts", "9-clubs"], next: ["5-hearts"] });
    const ace = bot.collection.items[0];
    const unseen = [new Card("5", "hearts", 0), new Card("6", "hearts", 0)];
    assert.equal(new BotStrategy(bot, service.room.match).selectSuit(ace, unseen), "clubs");
});

test("bot suit selection sheds more penalty when held suit counts are tied", t => {
    const { service, bot } = scenario(t, { hand: ["a-diamonds", "3-hearts", "q-clubs"], next: ["3-diamonds", "4-diamonds", "6-diamonds"] });
    const unseen = [new Card("5", "hearts", 0), new Card("5", "clubs", 0)];
    assert.equal(new BotStrategy(bot, service.room.match).selectSuit(bot.collection.items[0], unseen), "clubs");
});

for (const example of [
    { name: "attacks the previous seat when it cannot defend", previous: ["3-clubs", "4-clubs"],
        next: ["2-clubs", "9-diamonds"], selected: "2-hearts" },
    { name: "keeps the attack when the previous seat can defend", previous: ["2-clubs", "4-clubs"],
        next: ["3-diamonds", "9-diamonds"], selected: "q-hearts" }
]) {
    test(`hard-mode reversed targeting: ${example.name}`, async t => {
        const { service, bot, before } = scenario(t, {
            hand: ["2-hearts", "q-hearts", "6-spades"], direction: -1,
            previous: example.previous, next: example.next
        });
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.getTopItem().id, example.selected);
        assert.equal(service.room.match.turnOrder.ownerKey, before.key);
        assert.equal(before.drawAllowance, example.selected === "2-hearts" ? 2 : 1);
    });
}

test("hard-mode decision copies neighboring hands rather than retaining mutable collections", t => {
    const { service, bot, after } = scenario(t, {
        hand: ["2-hearts", "q-hearts", "6-spades"], next: ["3-clubs", "4-clubs"]
    });
    const strategy = new BotStrategy(bot, service.room.match);
    after.collection.clear();
    after.collection.addMany([new Card("2", "clubs", 0), new Card("4", "clubs", 0)]);
    assert.equal(strategy.selectCard().id, "2-hearts");
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "q-hearts");
});

for (const example of [
    { name: "rejects an eight that gives its skipped-to player the finish", previous: "3-clubs", skipped: "8-clubs", selected: "j-hearts" },
    { name: "rejects a jack that gives the reversed-to player the finish", previous: "j-clubs", skipped: "3-clubs", selected: "8-hearts" },
    { name: "sheds the most penalty when every projected opponent can finish", previous: "j-clubs", skipped: "8-clubs", selected: "q-hearts" }
]) {
    test(`hard-mode projected finish: ${example.name}`, async t => {
        const { service, bot } = scenario(t, {
            hand: ["8-hearts", "j-hearts", "q-hearts", "6-spades"],
            previous: [example.previous], next: ["5-hearts"]
        });
        const skipped = new Player("Skipped", { drawAllowance: 1 });
        const [value, suit] = example.skipped.split("-");
        skipped.collection.add(new Card(value, suit, 0));
        service.room.match.turnOrder.add(skipped);
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.getTopItem().id, example.selected);
        const expectedOwner = example.selected === "8-hearts" ? skipped.key
            : example.selected === "j-hearts" ? "previous" : "next";
        assert.equal(service.room.match.turnOrder.ownerKey, expectedOwner);
    });
}

test("unavoidable opponent finishes override attack conservation to shed penalty", t => {
    const { service, bot } = scenario(t, {
        hand: ["2-hearts", "j-hearts", "6-spades"], previous: ["j-clubs"], next: ["a-spades"]
    });
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "2-hearts");
});

test("projected finish avoidance follows an already reversed four-player order", async t => {
    const { service, bot, after } = scenario(t, {
        hand: ["8-hearts", "j-hearts", "q-hearts", "6-spades"],
        previous: ["5-hearts"], next: ["3-clubs"], direction: -1
    });
    const skipped = new Player("Skipped", { drawAllowance: 1 });
    skipped.collection.add(new Card("8", "clubs", 0));
    service.room.match.turnOrder.add(skipped);
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.getTopItem().id, "j-hearts");
    assert.equal(service.room.match.turnOrder.ownerKey, after.key);
    assert.equal(service.room.match.turnOrder.direction, 1);
});

for (const example of [
    { name: "keeps a joker when attacking removes the next player's blocking play", hand: ["joker-red", "5-clubs", "6-spades"],
        next: ["5-diamonds", "9-clubs"], following: "3-hearts", selected: "5-clubs", allowance: 1 },
    { name: "sheds the joker when the next player cannot prevent the following finish", hand: ["joker-red", "5-hearts", "6-spades"],
        next: ["9-hearts", "10-hearts"], following: "3-hearts", selected: "joker-red", allowance: 1 },
    { name: "counterattacks despite the following finish when defending a draw penalty", hand: ["joker-red", "6-spades"],
        next: ["5-diamonds", "9-clubs"], following: "3-hearts", selected: "joker-red", allowance: 2 },
    { name: "attacks when the next player can pass the penalty onward", hand: ["2-hearts", "5-hearts", "6-spades"],
        next: ["2-clubs", "9-hearts"], following: "3-hearts", selected: "2-hearts", allowance: 1 },
    { name: "avoids an attack when the next player's shield lets the following player finish", hand: ["2-hearts", "5-clubs", "6-spades"],
        next: ["a-spades", "9-clubs"], following: "3-hearts", selected: "5-clubs", allowance: 1 }
]) {
    test(`bot attack and defense strategy: ${example.name}`, async t => {
        const { service, bot } = scenario(t, {
            hand: example.hand, next: example.next, previous: [example.following], allowance: example.allowance,
            play: example.allowance > 1 ? ["2-hearts"] : ["5-hearts"]
        });
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.getTopItem().id, example.selected);
    });
}

test("two-player attack collection returns to the bot instead of inventing another opponent", t => {
    const { service, bot, before } = scenario(t, {
        hand: ["joker-red", "q-hearts", "6-spades"], next: ["3-clubs", "4-clubs"]
    });
    service.room.match.turnOrder.remove(before.key);
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "joker-red");
});

test("two-turn attack analysis follows reversed order", t => {
    const { service, bot } = scenario(t, {
        hand: ["joker-red", "5-clubs", "6-spades"], direction: -1,
        previous: ["5-diamonds", "9-clubs"], next: ["3-hearts"]
    });
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "5-clubs");
});

for (const example of [
    { name: "prefers the most common safe suit even when another suit holds more penalty",
        next: ["9-clubs", "10-clubs"], following: "5-spades", selected: "hearts" },
    { name: "avoids its most common suit when the next player can finish",
        next: ["5-hearts"], following: "5-spades", selected: "clubs" },
    { name: "avoids its most common suit when a forced draw exposes the following finish",
        next: ["9-clubs", "10-clubs"], following: "5-hearts", selected: "clubs" },
    { name: "keeps its most common suit when the intermediate player can block the following finish",
        next: ["9-hearts", "10-hearts"], following: "5-clubs", selected: "hearts" }
]) {
    test(`bot mapped declaration: ${example.name}`, async t => {
        const { service, bot } = scenario(t, {
            hand: ["a-diamonds", "3-hearts", "4-hearts", "q-clubs"], play: ["5-diamonds"],
            next: example.next, previous: [example.following]
        });
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.getTopItem().id, "a-diamonds");
        assert.equal(service.room.match.turnOrder.ownerKey, bot.key);
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.declaredSuit, example.selected);
        assert.equal(service.room.match.turnOrder.ownerKey, "next");
    });
}

test("bot considers a safe declaration before conserving an ace against a following finish", async t => {
    const { service, bot } = scenario(t, {
        hand: ["a-diamonds", "5-clubs", "6-hearts", "q-hearts"], play: ["5-diamonds"],
        next: ["3-clubs", "4-clubs", "6-clubs", "9-clubs"], previous: ["k-clubs"]
    });
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.getTopItem().id, "a-diamonds");
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.declaredSuit, "hearts");
});

for (const value of ["8", "j"]) {
    test(`one-opponent ${value} returns to the bot without mapping a self opponent`, async t => {
        const { service, bot, before } = scenario(t, {
            hand: [`${value}-hearts`, "q-hearts"], next: ["5-hearts"]
        });
        service.room.match.turnOrder.remove(before.key);
        const relative = service.room.match.turnOrder.relative.bind(service.room.match.turnOrder);
        service.room.match.turnOrder.relative = steps => {
            assert.ok(steps === 0 || steps === 1, "one-opponent predictions need only bot and opponent positions");
            return relative(steps);
        };
        const selected = new BotStrategy(bot, service.room.match).selectCard();
        assert.equal(selected.id, `${value}-hearts`);
        service.room.match.turnOrder.relative = relative;
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.turnOrder.ownerKey, bot.key);
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.state, Constants.ROOM_STATE.FINISHED);
        assert.equal(bot.state, Constants.PLAYER_STATE.WON);
    });
}

test("single-player prediction never treats the bot as an opponent", t => {
    const { service, bot, before, after } = scenario(t, { hand: ["9-hearts", "6-clubs"] });
    service.room.match.turnOrder.remove(before.key);
    service.room.match.turnOrder.remove(after.key);
    const relative = service.room.match.turnOrder.relative.bind(service.room.match.turnOrder);
    service.room.match.turnOrder.relative = steps => {
        assert.equal(steps, 0);
        return relative(steps);
    };
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "9-hearts");
});

for (const example of [
    { name: "blocks a next player's seven-of-hearts finish with multiple cards", next: ["7-hearts", "3-diamonds"],
        previous: ["3-clubs", "4-clubs", "9-clubs"], hand: ["q-hearts", "5-clubs", "6-spades"], selected: "5-clubs" },
    { name: "blocks a following player's seven-of-hearts finish after a forced draw", next: ["9-clubs", "10-clubs"],
        previous: ["7-hearts", "3-diamonds"], hand: ["q-hearts", "5-clubs", "6-spades"], selected: "5-clubs" },
    { name: "allows a seven-of-hearts response when the bot retains lower penalty", next: ["7-hearts", "9-diamonds"],
        previous: ["3-clubs", "4-clubs", "9-clubs"], hand: ["q-hearts", "3-clubs"], selected: "q-hearts" }
]) {
    test(`bot seven-of-hearts threat: ${example.name}`, async t => {
        const { service, bot } = scenario(t, example);
        await immediateBots.takeTurn(bot, service);
        assert.equal(service.room.match.getTopItem().id, example.selected);
    });
}

test("bot hand setup connects higher penalty when legal choices have equal discard penalty", async t => {
    const { service, bot } = scenario(t, {
        hand: ["5-spades", "5-hearts", "q-hearts", "3-spades"], play: ["5-clubs"],
        next: ["9-diamonds", "10-diamonds"]
    });
    await immediateBots.takeTurn(bot, service);
    assert.equal(service.room.match.getTopItem().id, "5-hearts");
});

for (const suit of Constants.CARD.STANDARD_SUITS) {
    const ace = `a-${suit}`;
    const otherSuit = suit === "hearts" ? "diamonds" : "hearts";
    for (const example of [
        { name: "keeps an ace when an ordinary card is equally safe", hand: [ace, `3-${suit}`, `4-${suit}`, `6-${suit}`], selected: `6-${suit}` },
        { name: "plays its ace when no ordinary card is legal", hand: [ace, `3-${otherSuit}`, `4-${otherSuit}`], selected: ace },
        { name: "keeps an ace when following a declared suit", hand: [ace, `3-${suit}`, `4-${suit}`, `6-${suit}`], play: [`a-${otherSuit}`], declaredSuit: suit, selected: `6-${suit}` }
    ]) {
        test(`bot ace conservation (${suit}): ${example.name}`, t => {
            const { service, bot } = scenario(t, {
                play: [`5-${suit}`], allowance: suit === "spades" ? 0 : 1,
                previous: ["9-diamonds", "10-diamonds"], next: ["9-spades", "10-spades"], ...example
            });
            const selected = new BotStrategy(bot, service.room.match).selectCard();
            if (example.selected === ace) assert.equal(selected.id, ace);
            else {
                assert.notEqual(selected.id, ace);
                assert.equal(selected.suit, suit);
            }
        });
    }
}

for (const direction of [1, -1]) {
    test(`bot completes a winning skip chain in direction ${direction}`, async t => {
        const { service, bot, before } = scenario(t, {
            hand: ["8-hearts", "j-hearts", "j-clubs", "6-clubs"],
            next: ["3-diamonds", "4-diamonds"], direction
        });
        service.room.match.turnOrder.remove(before.key);
        assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "8-hearts");
        for (const id of ["8-hearts", "j-hearts", "j-clubs", "6-clubs"]) {
            await immediateBots.takeTurn(bot, service);
            assert.equal(service.room.match.getTopItem().id, id);
        }
        assert.equal(service.room.match.state, Constants.ROOM_STATE.FINISHED);
        assert.equal(bot.state, Constants.PLAYER_STATE.WON);
    });
}

test("bot blocks an opponent's multi-skip finish instead of shedding the higher card", t => {
    const { service, bot, before } = scenario(t, {
        hand: ["q-clubs", "5-hearts", "6-spades"], play: ["5-clubs"],
        next: ["8-clubs", "8-hearts", "q-hearts"]
    });
    service.room.match.turnOrder.remove(before.key);
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "5-hearts");
});

test("bot does not assume a skip chain is uninterrupted with three players", t => {
    const { service, bot } = scenario(t, {
        hand: ["8-hearts", "j-hearts", "j-clubs", "6-clubs"],
        previous: ["8-clubs"], next: ["3-diamonds", "4-diamonds"]
    });
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "j-hearts");
});

test("unavoidable finishes prioritize shedding penalty over a same-suit ace", t => {
    const { service, bot } = scenario(t, {
        hand: ["a-clubs", "3-clubs", "4-clubs"], play: ["5-clubs"],
        next: ["a-spades"], previous: ["9-diamonds", "10-diamonds"]
    });
    assert.equal(new BotStrategy(bot, service.room.match).selectCard().id, "a-clubs");
});

test("strategy fields retain a decision snapshot when the live bot and match change", t => {
    const { service, bot, after } = scenario(t, { hand: ["q-hearts", "9-clubs"] });
    const strategy = new BotStrategy(bot, service.room.match);
    const penalty = strategy.penalty;
    bot.collection.clear();
    bot.drawAllowance = 4;
    service.room.match.collections.play.clear();
    service.room.match.declaredSuit = "spades";
    service.room.match.turnOrder.remove(after.key);

    assert.equal(strategy.key, bot.key);
    assert.equal(strategy.penalty, penalty);
    assert.equal(strategy.drawAllowance, 1);
    assert.equal(strategy.playerCount, 3);
    assert.equal(strategy.top.id, "5-hearts");
    assert.deepEqual(strategy.play.map(card => card.id), ["5-hearts"]);
    assert.equal(strategy.declaredSuit, null);
    assert.equal(strategy.nextPlayer.key, after.key);
    assert.equal(strategy.selectCard().id, "q-hearts");
});
