# Pick 2 Software Documentation

## 1. Purpose and scope

Pick 2 is a browser card game with Local and Network play modes. Both modes use the same pages, UI controllers, `Client` API, `Host`, action vocabulary, response envelopes, and unchanged `core/` rules. Only their runtime boundaries differ.

User-facing rules are summarized in the project README and in the guide embedded in `room.html`.

The public page and protocol vocabulary is **Home** for the room directory and
creation view, and **Room** for active play or viewing. `Room` is the core
domain model that owns one match's membership and Pick 2 rules.

## 2. System architecture

The project is organized into focused top-level roots:

```text
index.html          Shared Home page and room directory
room.html           Shared active Room and guide
core/               Rules, models, `Room`, bot behavior, and DTO mapping
runtime/            Client, Host, browser endpoints, Node network boundary
ui/                 Shared controllers, page state, elements, styles, and utilities
server.js           Node Network entry point
```

The Node server and static hosts serve the same two HTML files and assets. Play
mode is selected by choosing an endpoint, not by loading an edition-specific UI.

```text
UI controllers → Client → Browser → Host → core       (Local)
UI controllers → Client → NetworkClient ⇄ Network → Host → core  (Network)
```

`Host.js` is transport-neutral and imports only core code plus its rate limiter. `Browser.js` and `NetworkClient.js` are browser-only leaves. `Network.js` is a Node-only leaf for Express, HTTP, operating-system access, and WebSockets. Browser and Node dependencies therefore never share an import graph.

### 2.1 Browser responsibilities

- `main.js` starts either `HomeController` or `RoomController` from `body[data-page]`.
- `Client` owns response parsing, the per-tab identifier, and the temporary hand sort key.
- Every endpoint implements `open(callbacks)` and returns `request(request)` plus `close()`.
- `Browser` connects directly to `Host` with structured objects; `NetworkClient` owns browser WebSocket reconnection and serialization.
- View controllers render snapshots and translate user interactions into named actions without knowing which transport is active.
- Template utilities create reusable room rows and opponent panels.
- The `PlayingCard` custom element owns card rendering, face state, accessibility, and drag interaction through explicit method APIs.
- `DomUtils`, `ValidationUtils`, and `NotificationUtils` provide common contracts rather than repeating validation, normalization, or DOM-state logic.

The client does not normalize different player variants. Every player has one DTO shape, and `localPlayerName` identifies the local player in a Room data object.

### 2.2 Host and runtime responsibilities

- `Host` registers core `Room` instances and peers, routes actions, throttles requests, sends notifications, runs bot turns, and closes abandoned rooms.
- Host profiles describe Local or Network capabilities without duplicating orchestration.
- Host storage has only `load`, `save`, and `remove`, and persists serializable custom-room definitions rather than live core objects.
- `Browser` supplies localStorage and fills custom Local rooms immediately; configured default rooms keep only their configured bot players.
- `Network` supplies HTTP/WebSocket transport, heartbeat maintenance, and an injectable storage adapter. Network custom rooms do not auto-fill with bots.
- `Room` serializes state-changing operations, enforces membership and Pick 2 rules, advances turns, manages idle players, and completes rounds.
- `Player` contains player state; `BotPlayer` contains automated-player card selection.
- `PlayerCircle` maintains circular turn links, direction, and the nullable turn-owner cursor.
- `Card`, `Deck`, and `Hand` implement the card domain and collection behavior.
- `StateMapper` is the boundary between serialized domain state and stable client-facing DTOs.
- `Serializable` converts domain models and nested collections into plain transport-safe values.

## 3. Shared sources of truth

`core/Constants.js` is deliberately shared by both modes and the Host. It owns:

- action names;
- room-lifecycle, connection, and notification statuses;
- initial hand size, room player limit, default `Room` definitions, local bot names, and idle duration;
- standard values, standard suits, joker suits, rank/value/suit/score sort options, and score overrides;
- card score calculation;
- reusable emoji groups and random emoji selection.

Card scoring must always use `Constants.getCardScore(value, suit)`. New action or status strings must be added to `Constants` before they are used elsewhere.

Generic development validation belongs in the shared assertion and normalization utilities. A domain class should retain local validation only when it applies domain policy or translates invalid user input into a user-facing notification.

## 4. Runtime lifecycle

### 4.1 Startup

1. The browser loads `main.js` from either the Home page or the Room page.
2. Local mode constructs `Client → Browser → Host`, seeds the Rooms defined by `Constants.DEFAULT_ROOMS`, and works on any static host.
3. When Network mode is selected, Home shows the connection view while it probes the configured WebSocket host.
4. Network mode constructs `Client → NetworkClient`; Node adapts the socket to the same `Host.open` API.
5. When Node is running, `server.js` starts `Network`, registers `/health`, serves the shared Home and Room pages and assets, creates default rooms, and starts heartbeat maintenance.

### 4.2 Room membership

The public Home and Room vocabulary is consistent across constants, routing,
and controller operations. Each room is backed by a core `Room`:

- **list** returns Home's `rooms` directory;
- **create** creates a Room and joins its first Player;
- **view** opens an existing Room without joining as a Player;
- **join** adds the client as a Player, including after `view`;
- **leave** removes the client from the Room and returns it to Home.

Joining is locked while the underlying `Room` is playing or awaiting a suit declaration. Viewers and Players may leave at any time. Player names are unique within a Room, and playerLimit applies only to Player seats.

### 4.3 Room flow

1. Starting requires at least two players.
2. The `Room` creates and shuffles the deck, deals seven cards per player, chooses a valid initial discard, and selects the first player.
3. The turn owner may draw, discard, or pass subject to `Room` rules.
4. Draw and pass actions permanently commit the player's selected hand sort. A discard commits the order while removing the selected card.
5. A newly drawn card resets the client's temporary sort to `none`, so it is visibly new until the player sorts again.
6. Suit-changing aces move the `Room` to `pending` until the turn owner declares a standard suit.

While a `Room` is `waiting`, `circle.turnOwnerKey` is `null`. With no turn owner, any seated player may draw one card or discard a card without turn-order or discard-legality checks. Starting the `Room` assigns a random turn owner; resetting to `waiting` clears the cursor again.
7. Emptying a hand or playing the seven of hearts finishes the playing round.
8. Remaining hand scores determine the winner or tied winners.

Card rules and round-finish rules are enforced only while the `Room` is actively playing. Outside play, any card may be placed on any other card.

In Local mode, leaving an owned custom Room ends its browser-local `Room` and
returns to Home. User-created room entries are removed when their player leaves,
while rooms backed by the shared `Constants.DEFAULT_ROOMS` configuration
remain available. A seated Local player can select `Play` from either `waiting`
or `finished`, so completed rounds restart without creating a new Room.

### 4.4 Idle and empty-room cleanup

In Network mode, when a Player exceeds `Constants.MAX_IDLE_MS`, the Host removes that Player while leaving the client in viewing state, then sends a notification. If no Players remain, the Host schedules an empty-room check for another `MAX_IDLE_MS`. Local mode disables idle monitoring because its lifecycle is owned by the browser page.

## 5. Room protocol

### 5.1 Client request

Local and Network requests contain an `action` from `Constants.ACTIONS` and a `data` object. `Client` adds the browser-tab identity and current hand sort key before delegating to either endpoint.

Requests that identify a Room use `data.roomName`. The browser route uses the
matching `room` query key: `room.html?mode=<local-or-network>&room=<room-name>`.

Supported action families are:

| Area | Actions |
| --- | --- |
| Home and Room membership | `list`, `create`, `view`, `join`, `leave` |
| Play | `start`, `draw`, `discard`, `pass`, `declare` |

Action handlers validate Room ownership in the Host. A client-provided name never grants control of another player's Room.

### 5.2 Response

Both modes use the envelope produced by `StateMapper.toResponse`:

```js
{
    view: "home" | "room" | null,
    message: { status, title, message } | null,
    data: Object | null
}
```

The first meaningful statement is placed in `title`; the body contains only the remaining message so notifications do not repeat their opening text.

### 5.3 Home and Room data

The Home data exposes its directory through one stable list key:

```js
{
    rooms: [
        {roomName, status, playerCount, playerLimit, viewerCount, lastActiveAt, createdAt}
    ]
}
```

The Room data contains Room metadata, `localPlayerName`, a browser-safe `circle`,
discard pile, deck count, winners, scores, and suit-selection state. The circle
preserves the core `Room` ownership field names and nesting:

```js
{
    players,
    playerLimit,
    turnOwnerKey,
    direction
}
```

Both Host and browser code use the shared `TurnUtils.hasTurnOwner(turnOwnerKey)` and `TurnUtils.isTurnOwner(turnOwnerKey, playerKey)` predicates. No derived ownership aliases are added to the wire data. Each browser-safe player consistently has:

```js
{
    key,
    name,
    hand: {
        cards,
        score,
        sortKey
    },
    drawAllowance,
    isWinner
}
```

The browser finds the local Player by comparing `localPlayerName` with `player.name`. Viewers have no local Player match. Card count remains derived from `player.hand.cards.length` on both sides.

Boolean fields and boolean DOM dataset states use `is` names, such as `isWinner`, `data-is-turn-owner`, `data-is-selected`, and `data-is-face-down`.

## 6. Card and hand model

A card DTO contains `value`, `suit`, `score`, and `rotation`. Standard cards use a standard suit; jokers use red or black joker suits.

`Hand` owns `cards`, `score`, and the persisted `sortKey`. Its score updates whenever cards are added or removed. Card count is derived from `cards.length` rather than stored as duplicate domain state.

Temporary browser sorting uses `CardSortUtils` and does not mutate the server for each selection. The sort key is sent with the player's next draw, discard, or pass, at which point the `Room` commits the order and resets the temporary selection.

## 7. Automated-player policy

The BotPlayer evaluates its own legal cards using only public room information: turn order, visible hand counts, card effects, and discard history. It never reads an opponent's card identities or hand score. For each candidate play, it subtracts its own cards and the current discard pile from the complete deck, then estimates the chance that the projected next player has a legal response. Opponent urgency rises sharply at three, two, and one remaining cards, so the BotPlayer begins applying pressure before the final-card emergency. It compares the actual players reached by ordinary, skip, and reverse candidates; prefers draw attacks that are unlikely to be countered; and favors plays with a lower estimated response probability.

The BotPlayer also scores the structure of its remaining hand. It prefers candidate cards that leave more legal continuations and gives a decisive bonus to a two-player skip that returns a playable final card to itself. A suit-changing ace primarily declares the bot's strongest remaining suit. When multiple suits are equally strong, current discard history breaks the tie toward the suit with fewer unseen cards, reducing the estimated chance of an opponent response.

The BotPlayer does not keep a duplicate per-opponent history. Discarded cards can return to the deck when the discard pile is recycled, so persistent memory would eventually treat playable cards as unavailable and make its estimates incorrect. It instead reads the live discard pile, which always represents the cards that are currently public and unavailable.

The BotPlayer avoids spending the ace of spades when there is no draw attack, but uses legal defenses rather than accepting a draw penalty based on hidden knowledge. For the seven of hearts, it finishes immediately when that empties its hand. Otherwise, it considers ending only when the discard leaves it with fewer cards than every opponent. It then uses the scores of unseen cards and each opponent's visible card count to estimate the chance that its remaining score will tie or beat every opponent, ending the game only when that estimate reaches the configured confidence threshold. After an opponent discards the three of a standard suit—the lowest ordinary card—the BotPlayer treats that suit as potentially exhausted and prefers to continue pressing it only when the candidate card would make that same opponent the next actor.

These decisions remain subordinate to the same `Room` and `Card` legality rules used for human players.

## 8. Client interaction rules

- Non-decorative cards may be flipped with a click or the keyboard.
- Gameplay cards can begin a drag interaction; guide cards explicitly set `isDraggable: false` so they remain readable and flippable without becoming drag sources.
- Only cards in the local player's hand receive the discardable state and can be dropped onto the discard pile.
- The entire discard-pile rectangle is the drop target.
- A drag clone is appended to `body`, so its size is calculated from the rendered source card instead of inheriting body-level container-query dimensions. `Constants.CARD.DRAG_CLONE_SCALE` controls the clone-to-source ratio; `.25` means one-quarter size. The pointer offsets use the same scale to keep the clone anchored at the same relative point.
- Viewers do not receive player-only start or results overlays.
- The results table selects a player and displays that player's remaining cards.

HTML initializes mutable `data-*` states so the initial component contract is visible in the markup. Runtime boolean dataset assignments go through `DomUtils.setBooleanState`.

## 9. Error and notification policy

`UserNotification` represents an expected, actionable game condition, such as an unavailable name, an illegal play, or acting out of turn. The server converts it into an informational or warning message for the user.

Development failures—invalid internal card values, impossible model state, malformed code contracts, syntax errors, and similar defects—remain ordinary `Error` instances. The server sends a generic server-error notification and allows the error to reach logging so its stack trace remains available.

Do not replace development errors with `UserNotification`; players cannot take useful action on those failures.

## 10. Styling and responsive design

The interface is mobile-first. Unqualified rules define the mobile presentation, and one `min-width: 721px` stage serves both tablets and desktops. Common spacing, radius, and control dimensions are inherited through shared custom properties and container rules.

Stylesheets are organized in page order and by responsibility:

- `base.css`: shared design tokens, document structure, typography, controls, header, footer, focus, and motion defaults;
- `home.css`: Home page, room directory, and connection-view layout;
- `room.css`: active Room layout, players, opponents, and guide;
- `playing-card.css`: card containers and card faces;
- `table.css`: tabular information;
- `overlays.css`: alerts, countdown, suit selection, and room results.

## 11. Testing

The project uses `node:test` and `node:assert/strict`. Run `npm test` before completing a change. Use `npm run test:coverage` when reviewing untested branches.

Tests are grouped by domain:

- `card.test.js`: constants, scoring, card rules, and shared client utilities;
- `collections.test.js`: deck, hand, sorting, and player-circle behavior;
- `infrastructure.test.js`: serialization, state mapping, and throttling;
- `room.test.js`: membership, lifecycle, game flow, and bot choices;
- `user-notification.test.js`: expected versus developmental error classification.

New behavior should receive a focused regression test at the lowest stable layer. Pure CSS fixes should be verified in both responsive stages because the Node suite does not perform visual layout testing.

## 12. Extension guidelines

When adding a feature:

1. Add shared action, status, card, timing, or score values to `Constants`.
2. Put authoritative game policy in the core domain, normally `Room`, `Player`, or `Card`; put orchestration in `Host`.
3. Add or update the stable DTO in `StateMapper`; do not make controllers normalize competing data shapes.
4. Route a named action through `Host` and validate its Room/Player context.
5. Use an existing controller API pattern for the client interaction.
6. Initialize mutable HTML dataset state in the markup.
7. Reuse shared validation, notification, sorting, and DOM utilities.
8. Add tests for valid behavior, expected user failures, and important internal-contract failures.
9. Update this document, the README, and the in-page guide when rules or public behavior change.

## 13. Operational notes

- Default port: `8080`, overridden with `PORT`.
- Health check: `GET /health`.
- Graceful shutdown handles `SIGINT` and `SIGTERM` and closes connections before exit.
- Uncaught exceptions and unhandled promise rejections are logged and trigger Network shutdown because host state may be unsafe.
- The application is proprietary. See the README copyright and license notice.
