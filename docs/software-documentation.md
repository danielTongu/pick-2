# Pick 2 Software Documentation

## 1. Purpose and scope

Pick 2 is a browser card game with Local and Server play modes. Both modes use the same game page, session page, UI controllers, `GameClient` API, action vocabulary, response envelopes, and `src/core` rules. Server mode uses the Node server; Local mode uses an in-browser `LocalServer` and fills `capacity - 1` seats with AI players.

User-facing rules are summarized in the project README and in the guide embedded in `session/index.html`.

## 2. System architecture

All JavaScript is organized beneath one source root:

```text
index.html          Shared Game and session registry
session/index.html  Shared Session and guide
src/client          GameClient, client state, and transports
src/core         Rules, models, AI behavior, and DTO mapping
src/ui           Shared controllers, card element, and browser utilities
src/local        In-browser LocalServer
src/server       Express/WebSocket Server and shared Server sessions
web/shared       Shared styles, templates, and artwork
```

The Node server and static hosts serve the same two HTML files and assets. Play
mode is selected by choosing a transport, not by loading an edition-specific UI.

```text
Browser
  GameController / SessionController
             │
         GameClient
             │ canonical actions and response envelopes
       ┌─────┴──────────┐
  LocalTransport   WebSocketTransport
       │                  │
  LocalServer           Server
       └─────┬────────────┘
    StateMapper ───────────────► stable client DTOs
    Session
      PlayerCircle
      Player / AI behavior
      Deck, Hand, Card
```

Express serves the same game, session, source, and web assets as a static host, plus `/health`. The WebSocket server shares the HTTP server and handles Server-mode commands and synchronization.

### 2.1 Browser responsibilities

- `src/main.js` starts either the game or session controller from `body[data-page]`.
- `GameClient` owns response parsing, the per-tab identifier, and the temporary hand sort key.
- `LocalTransport` and `WebSocketTransport` implement the same `connect`, `send`, and `close` API.
- View controllers render snapshots and translate user interactions into named actions without knowing which transport is active.
- Template utilities create reusable session rows and opponent panels.
- The `PlayingCard` custom element owns card rendering, face state, accessibility, and drag interaction through explicit method APIs.
- `DomUtils`, `NormalizeUtils`, `AssertUtils`, and `NotificationUtils` provide common contracts rather than repeating normalization or DOM-state logic.

The client does not normalize different player variants. Every player has one DTO shape, and `localPlayerName` identifies the local player in a Session payload.

### 2.2 Server responsibilities

- `LocalServer` implements the canonical action protocol in the browser, stores local session configurations, creates one human, and fills the remaining session capacity with AI players.
- `Server` starts HTTP and WebSocket services, registers shared sessions and clients, routes actions, throttles requests, sends notifications, monitors connections, and closes abandoned sessions.
- `Session` serializes state-changing operations, enforces membership and game rules, advances turns, manages idle players, and completes games.
- `Player` contains player state and automated-player card selection.
- `PlayerCircle` maintains circular turn links, direction, and the nullable turn-owner cursor.
- `Card`, `Deck`, and `Hand` implement the card domain and collection behavior.
- `StateMapper` is the boundary between serialized domain state and stable client-facing DTOs.
- `Serializable` converts domain models and nested collections into plain transport-safe values.

## 3. Shared sources of truth

`src/core/Constants.js` is deliberately shared by both applications and the server runtime. It owns:

- action names;
- session, game, connection, and notification statuses;
- initial hand size, session capacity, default sessions, local opponent names, and idle duration;
- standard values, standard suits, joker suits, rank/value/suit/score sort options, and score overrides;
- card score calculation;
- reusable emoji groups and random emoji selection.

Card scoring must always use `Constants.getCardScore(value, suit)`. New action or status strings must be added to `Constants` before they are used elsewhere.

Generic development validation belongs in the shared assertion and normalization utilities. A domain class should retain local validation only when it applies domain policy or translates invalid user input into a user-facing notification.

## 4. Runtime lifecycle

### 4.1 Startup

1. The browser loads `src/main.js` from either the game or session page.
2. Local mode constructs `GameClient → LocalTransport → LocalServer`, seeds `Constants.DEFAULT_SESSIONS`, and works on any static host.
3. The game probes the configured WebSocket server and enables Server mode when it is reachable.
4. Server mode constructs `GameClient → WebSocketTransport → Server`.
5. When Node is running, `src/server/index.js` starts HTTP and WebSocket services, registers `/health`, serves the shared pages and assets, creates default sessions, and starts heartbeat monitoring.

### 4.2 Session membership

The Session vocabulary is consistent across constants, routing, and domain operations:

- **list** returns the Game's session registry;
- **create** creates a Session and joins its first Player;
- **view** opens an existing Session without joining as a Player;
- **join** adds the client as a Player, including after `view`;
- **leave** removes the client from the Session and returns it to the Game.

Joining is locked while the Session is playing or awaiting a suit declaration. Viewers and Players may leave at any time. Player names are unique within a Session, and Session capacity applies only to Player seats.

### 4.3 Game flow

1. Starting requires at least two players.
2. The session creates and shuffles the deck, deals seven cards per player, chooses a valid initial discard, and selects the first player.
3. The turn owner may draw, discard, or pass subject to session rules.
4. Draw and pass actions permanently commit the player's selected hand sort. A discard commits the order while removing the selected card.
5. A newly drawn card resets the client's temporary sort to `none`, so it is visibly new until the player sorts again.
6. Suit-changing aces move the session to `pending` until the turn owner declares a standard suit.

While a session is `waiting`, `circle.turnOwnerKey` is `null`. With no turn owner, any seated player may draw one card or discard a card without turn-order or discard-legality checks. Starting the Session assigns a random turn owner; resetting to `waiting` clears the cursor again.
7. Emptying a hand or playing the seven of hearts finishes a playing game.
8. Remaining hand scores determine the winner or tied winners.

Card rules and session-ending rules are enforced only while the session is actively playing. Outside play, any card may be placed on any other card.

In Local mode, leaving ends the browser-local session and returns to the game.
User-created session entries are removed when their player leaves, while sessions
from the shared `Constants.DEFAULT_SESSIONS` configuration remain available. A
seated Local player can select `Play` from either `waiting` or `finished`, so
completed rounds restart without creating a new session.

### 4.4 Idle and empty-session cleanup

When a Player exceeds `Constants.MAX_IDLE_MS`, the server removes that Player while leaving the client in viewing state, then sends a notification. If no Players remain, the server schedules an empty-session check for another `MAX_IDLE_MS`. The closure callback checks the Session again before returning its viewers to the Game and removing it, preventing a stale timer from closing an occupied Session.

## 5. Game protocol

### 5.1 Client request

Local and Server requests contain an action `type` from `Constants.ACTIONS` and a `payload` object. `GameClient` adds the browser-tab identity and current hand sort key before delegating to either transport.

Supported action families are:

| Area | Actions |
| --- | --- |
| Session | `list`, `create`, `view`, `join`, `leave` |
| Play | `start`, `draw`, `discard`, `pass`, `declare` |

Action handlers validate session ownership on the server. A client-provided name never grants control of another player's session.

### 5.2 Response

Both servers use the envelope produced by `StateMapper.toResponse`:

```js
{
    view: "game" | "session" | null,
    message: { status, title, message } | null,
    sync: Object | null
}
```

The first meaningful statement is placed in `title`; the body contains only the remaining message so notifications do not repeat their opening text.

### 5.3 Session payload

The Session sync contains Session metadata, `localPlayerName`, a browser-safe `circle`, discard pile, deck count, winners, scores, and suit-selection state. The circle preserves the server-side ownership field names and nesting:

```js
{
    players,
    playerCount,
    turnOwnerKey,
    direction
}
```

Both server and browser code use the shared `TurnUtils.hasTurnOwner(turnOwnerKey)` and `TurnUtils.isTurnOwner(turnOwnerKey, playerKey)` predicates. No derived ownership aliases are added to the wire payload. Each browser-safe player consistently has:

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

Temporary browser sorting uses `CardSortUtils` and does not mutate the server for each selection. The sort key is sent with the player's next draw, discard, or pass, at which point the session commits the order and resets the temporary selection.

## 7. Automated-player policy

The AI evaluates its own legal cards using only public game information: turn order, visible hand counts, card effects, and discard history. It never reads an opponent's card identities or hand score. For each candidate play, it subtracts its own cards and the current discard pile from the complete deck, then estimates the chance that the projected next player has a legal response. Opponent urgency rises sharply at three, two, and one remaining cards, so the AI begins applying pressure before the final-card emergency. It compares the actual players reached by ordinary, skip, and reverse candidates; prefers draw attacks that are unlikely to be countered; and favors plays with a lower estimated response probability.

The AI also scores the structure of its remaining hand. It prefers candidate cards that leave more legal continuations and gives a decisive bonus to a two-player skip that returns a playable final card to itself. A suit-changing ace primarily declares the AI's strongest remaining suit. When multiple suits are equally strong, current discard history breaks the tie toward the suit with fewer unseen cards, reducing the estimated chance of an opponent response.

The AI does not keep a duplicate per-opponent history. Discarded cards can return to the deck when the discard pile is recycled, so persistent memory would eventually treat playable cards as unavailable and make its estimates incorrect. It instead reads the live discard pile, which always represents the cards that are currently public and unavailable.

The AI avoids spending the ace of spades when there is no draw attack, but uses legal defenses rather than accepting a draw penalty based on hidden knowledge. For the seven of hearts, it finishes immediately when that empties its hand. Otherwise, it considers ending only when the discard leaves it with fewer cards than every opponent. It then uses the scores of unseen cards and each opponent's visible card count to estimate the chance that its remaining score will tie or beat every opponent, ending the game only when that estimate reaches the configured confidence threshold. After an opponent discards the three of a standard suit—the lowest ordinary card—the AI treats that suit as potentially exhausted and prefers to continue pressing it only when the candidate card would make that same opponent the next actor.

These decisions remain subordinate to the same `Session` and `Card` legality rules used for human players.

## 8. Client interaction rules

- All displayed cards may be flipped with a single click.
- All displayed cards can begin a drag interaction.
- Only cards in the local player's hand receive the discardable state and can be dropped onto the discard pile.
- The entire discard-pile rectangle is the drop target.
- Viewers do not receive player-only start or session-end overlays.
- The session-end statistics table selects a player and displays that player's remaining cards.

HTML initializes mutable `data-*` states so the initial component contract is visible in the markup. Runtime boolean dataset assignments go through `DomUtils.setBooleanState`.

## 9. Error and notification policy

`UserNotification` represents an expected, actionable game condition, such as an unavailable name, an illegal play, or acting out of turn. The server converts it into an informational or warning message for the user.

Development failures—invalid internal card values, impossible model state, malformed code contracts, syntax errors, and similar defects—remain ordinary `Error` instances. The server sends a generic server-error notification and allows the error to reach logging so its stack trace remains available.

Do not replace development errors with `UserNotification`; players cannot take useful action on those failures.

## 10. Styling and responsive design

The interface is mobile-first and uses content-driven breakpoints: card sizing expands at 641 px, the compact shell and guide apply through 720 px, and Game panels remain stacked through 900 px. Common spacing, radius, and control dimensions are inherited through stylesheet tokens and container rules. Session actions and Session information remain stacked, while create/join controls remain side by side.

Stylesheets are organized in page order and by responsibility:

- `tokens.css`: common design values;
- `base.css`: shared document structure, typography, focus, and motion defaults;
- `pick2-index.css`: Game page layout and controls;
- `session-index.css`: Session layout, players, opponents, and guide;
- `app-footer.css`: the footer shared by both pages;
- `playing-card.css`: card containers and card faces;
- `table-data.css`: tabular information;
- `overlays.css`: alerts, countdown, suit selection, and Session results.

## 11. Testing

The project uses `node:test` and `node:assert/strict`. Run `npm test` before completing a change. Use `npm run test:coverage` when reviewing untested branches.

Tests are grouped by domain:

- `card.test.js`: constants, scoring, card rules, and shared client utilities;
- `collections.test.js`: deck, hand, sorting, and player-circle behavior;
- `infrastructure.test.js`: serialization, state mapping, and throttling;
- `session.test.js`: membership, lifecycle, game flow, and AI choices;
- `user-notification.test.js`: expected versus developmental error classification.

New behavior should receive a focused regression test at the lowest stable layer. Pure CSS fixes should be verified in both responsive stages because the Node suite does not perform visual layout testing.

## 12. Extension guidelines

When adding a feature:

1. Add shared action, status, card, timing, or score values to `Constants`.
2. Put authoritative policy in the server domain, normally `Session`, `Player`, or `Card`.
3. Add or update the stable DTO in `StateMapper`; do not make controllers normalize competing payload shapes.
4. Route a named action through `Server` and validate its session/player session.
5. Use an existing controller API pattern for the client interaction.
6. Initialize mutable HTML dataset state in the markup.
7. Reuse shared validation, notification, sorting, and DOM utilities.
8. Add tests for valid behavior, expected user failures, and important internal-contract failures.
9. Update this document, the README, and the in-page guide when rules or public behavior change.

## 13. Operational notes

- Default port: `8080`, overridden with `PORT`.
- Health check: `GET /health`.
- Graceful shutdown handles `SIGINT` and `SIGTERM` and closes connections before exit.
- Uncaught exceptions and unhandled promise rejections are logged and trigger shutdown because server state may be unsafe.
- The application is proprietary. See the README copyright and license notice.
