# Pick 2 Software Documentation

## 1. Purpose and scope

Pick 2 is a browser-based, real-time card game. The server owns rooms, membership, turns, game rules, card scores, AI decisions, and persisted hand order. The browser owns presentation, temporary hand sorting, card flipping, drag interaction, and the local session identity stored for a browser tab.

This document describes the software as implemented. User-facing rules are summarized in the project README and in the guide embedded in `public/index.html`.

## 2. System architecture

```text
Browser
  AppController
    LobbyController
    RoomController
      LocalPlayerController
      overlay controllers
  ConnectionService
          │ WebSocket actions and response envelopes
          ▼
Server
  Server
    session registry and action routing
    StateMapper ───────────────► stable client DTOs
    Room
      PlayerCircle
      Player / AI behavior
      Deck, Hand, Card
```

Express serves the static browser application and `/health`. The WebSocket server shares the HTTP server and handles all live commands and synchronization.

### 2.1 Browser responsibilities

- `AppController` starts component dependencies and switches between lobby and room views.
- `ConnectionService` owns the WebSocket, reconnection, response parsing, the per-tab identifier, and the temporary hand sort key.
- View controllers render server snapshots and translate user interactions into named actions.
- Template utilities create reusable room rows, opponent panels, and playing cards.
- `DomUtils`, `NormalizeUtils`, `AssertUtils`, and `NotificationUtils` provide common contracts rather than repeating normalization or DOM-state logic.

The client does not normalize different player variants. Every player has one DTO shape, and `room.session.playerName` identifies the local player.

### 2.2 Server responsibilities

- `Server` starts HTTP and WebSocket services, registers rooms and sessions, routes actions, throttles requests, sends notifications, monitors connections, and closes abandoned rooms.
- `Room` serializes state-changing operations, enforces membership and game rules, advances turns, manages idle players, and completes games.
- `Player` contains player state and automated-player card selection.
- `PlayerCircle` maintains circular turn links, direction, and the nullable turn-owner cursor.
- `Card`, `Deck`, and `Hand` implement the card domain and collection behavior.
- `StateMapper` is the boundary between serialized domain state and stable client-facing DTOs.
- `Serializable` converts domain models and nested collections into plain transport-safe values.

## 3. Shared sources of truth

`public/scripts/Constants.js` is deliberately shared by browser and server code. It owns:

- action names;
- room, game, connection, and notification statuses;
- initial hand size, room capacity, default rooms, and idle duration;
- standard values, standard suits, joker suits, rank/value/suit/score sort options, and score overrides;
- card score calculation;
- reusable emoji groups and random emoji selection.

Card scoring must always use `Constants.getCardScore(value, suit)`. New action or status strings must be added to `Constants` before they are used elsewhere.

Generic development validation belongs in the shared assertion and normalization utilities. A domain class should retain local validation only when it applies domain policy or translates invalid user input into a user-facing notification.

## 4. Runtime lifecycle

### 4.1 Startup

1. `server/index.js` registers termination and fatal-error handlers.
2. `Server` creates the Express application, HTTP server, and WebSocket server.
3. Static files and `/health` are registered.
4. Default rooms and their AI players are created. The first two default rooms receive two AI players; the remaining rooms receive one.
5. Heartbeat monitoring starts.
6. The browser loads templates, establishes a WebSocket, and requests the lobby.

### 4.2 Room membership

The membership vocabulary is consistent across constants, routing, and domain operations:

- **create** creates and registers a room;
- **admit** enters a room as a visitor or player;
- **promote** changes a visitor into a player;
- **demote** changes a player into a visitor;
- **evict** removes an occupant.

Membership is locked while the room is starting, playing, or awaiting a suit declaration. Player names are unique within a room, and room capacity applies to player seats.

### 4.3 Game flow

1. Starting requires at least two players.
2. The room creates and shuffles the deck, deals seven cards per player, chooses a valid initial discard, and selects the first player.
3. The turn owner may draw, discard, or pass subject to room rules.
4. Draw and pass actions permanently commit the player's selected hand sort. A discard commits the order while removing the selected card.
5. A newly drawn card resets the client's temporary sort to `none`, so it is visibly new until the player sorts again.
6. Suit-changing aces move the room to `pending` until the turn owner declares a standard suit.

While a room is `waiting`, `circle.turnOwnerKey` is `null`. With no turn owner, any seated player may draw one card or discard a card without turn-order or discard-legality checks. Starting a game assigns a random turn owner; resetting to `waiting` clears the cursor again.
7. Emptying a hand or playing the seven of hearts finishes a playing game.
8. Remaining hand scores determine the winner or tied winners.

Card rules and game-ending rules are enforced only while the room is actively playing. Outside play, any card may be placed on any other card.

### 4.4 Idle and empty-room cleanup

When a player exceeds `Constants.MAX_IDLE_MS`, the server removes or demotes that player and sends the relevant notification. If no players remain, the server schedules an empty-room check for another `MAX_IDLE_MS`. The closure callback checks the room again before evicting remaining visitors and removing the room, preventing a stale timer from closing an occupied room.

## 5. WebSocket protocol

### 5.1 Client request

Requests contain an action `type` from `Constants.ACTIONS` and a `payload` object. ConnectionService also associates the browser-tab identity with the connection.

Supported action families are:

| Area | Actions |
| --- | --- |
| Navigation | `view_lobby` |
| Membership | `create_room`, `admit_visitor`, `admit_player`, `promote_visitor`, `demote_player`, `evict_occupant` |
| Game | `start_game`, `draw_card`, `discard_card`, `pass_player`, `suit_change` |

Action handlers validate session ownership on the server. A client-provided name never grants control of another player's session.

### 5.2 Server response

Every response uses the envelope produced by `StateMapper.toResponse`:

```js
{
    view: "lobby" | "room" | null,
    message: { status, title, message } | null,
    sync: Object | null
}
```

The first meaningful statement is placed in `title`; the body contains only the remaining message so notifications do not repeat their opening text.

### 5.3 Room payload

The room sync contains room metadata, session identity, a browser-safe `circle`, discard pile, deck count, winners, scores, and suit-selection state. The circle preserves the server-side ownership field names and nesting:

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

The browser finds the local player by comparing `room.session.playerName` with `player.name`. Visitors have no local player match. Card count remains derived from `player.hand.cards.length` on both sides.

Boolean fields and boolean DOM dataset states use `is` names, such as `isWinner`, `data-is-turn-owner`, `data-is-selected`, and `data-is-face-down`.

## 6. Card and hand model

A card DTO contains `value`, `suit`, `score`, and `rotation`. Standard cards use a standard suit; jokers use red or black joker suits.

`Hand` owns `cards`, `score`, and the persisted `sortKey`. Its score updates whenever cards are added or removed. Card count is derived from `cards.length` rather than stored as duplicate domain state.

Temporary browser sorting uses `CardSortUtils` and does not mutate the server for each selection. The sort key is sent with the player's next draw, discard, or pass, at which point the room commits the order and resets the temporary selection.

## 7. Automated-player policy

The AI evaluates its own legal cards using only public game information: turn order, visible hand counts, card effects, and discard history. It never reads an opponent's card identities or hand score. For each candidate play, it subtracts its own cards and the current discard pile from the complete deck, then estimates the chance that the projected next player has a legal response. Opponent urgency rises sharply at three, two, and one remaining cards, so the AI begins applying pressure before the final-card emergency. It compares the actual players reached by ordinary, skip, and reverse candidates; prefers draw attacks that are unlikely to be countered; and favors plays with a lower estimated response probability.

The AI also scores the structure of its remaining hand. It prefers candidate cards that leave more legal continuations and gives a decisive bonus to a two-player skip that returns a playable final card to itself. A suit-changing ace primarily declares the AI's strongest remaining suit. When multiple suits are equally strong, current discard history breaks the tie toward the suit with fewer unseen cards, reducing the estimated chance of an opponent response.

The AI does not keep a duplicate per-opponent history. Discarded cards can return to the deck when the discard pile is recycled, so persistent memory would eventually treat playable cards as unavailable and make its estimates incorrect. It instead reads the live discard pile, which always represents the cards that are currently public and unavailable.

The AI avoids spending the ace of spades when there is no draw attack, but uses legal defenses rather than accepting a draw penalty based on hidden knowledge. For the seven of hearts, it finishes immediately when that empties its hand. Otherwise, it considers ending only when the discard leaves it with fewer cards than every opponent. It then uses the scores of unseen cards and each opponent's visible card count to estimate the chance that its remaining score will tie or beat every opponent, ending the game only when that estimate reaches the configured confidence threshold. After an opponent discards the three of a standard suit—the lowest ordinary card—the AI treats that suit as potentially exhausted and prefers to continue pressing it only when the candidate card would make that same opponent the next actor.

These decisions remain subordinate to the same `Room` and `Card` legality rules used for human players.

## 8. Client interaction rules

- All displayed cards may be flipped with a single click.
- All displayed cards can begin a drag interaction.
- Only cards in the local player's hand receive the discardable state and can be dropped onto the discard pile.
- The entire discard-pile rectangle is the drop target.
- Visitors do not receive player-only start or game-end overlays.
- The game-end statistics table selects a player and displays that player's remaining cards.

HTML initializes mutable `data-*` states so the initial component contract is visible in the markup. Runtime boolean dataset assignments go through `DomUtils.setBooleanState`.

## 9. Error and notification policy

`UserNotification` represents an expected, actionable game condition, such as an unavailable name, an illegal play, or acting out of turn. The server converts it into an informational or warning message for the user.

Development failures—invalid internal card values, impossible model state, malformed code contracts, syntax errors, and similar defects—remain ordinary `Error` instances. The server sends a generic server-error notification and allows the error to reach logging so its stack trace remains available.

Do not replace development errors with `UserNotification`; players cannot take useful action on those failures.

## 10. Styling and responsive design

The interface is mobile-first and has two responsive stages: small screens, then a shared tablet/desktop layout beginning at 641 px. Common spacing, radius, and control dimensions are inherited through stylesheet tokens and container rules. Room actions and room information remain stacked, while room admission actions remain side by side.

Stylesheets are organized in page order and by responsibility:

- `tokens.css`: common design values;
- `app.css`: page, lobby, room, guide, and footer;
- `card.css`: card containers and card faces;
- `opponent.css`: opponent presentation;
- `table-data.css`: tabular information;
- `overlays.css`: alerts, countdown, suit selection, and game end.

## 11. Testing

The project uses `node:test` and `node:assert/strict`. Run `npm test` before completing a change. Use `npm run test:coverage` when reviewing untested branches.

Tests are grouped by domain:

- `card.test.js`: constants, scoring, card rules, and shared client utilities;
- `collections.test.js`: deck, hand, sorting, and player-circle behavior;
- `infrastructure.test.js`: serialization, state mapping, and throttling;
- `room.test.js`: membership, lifecycle, game flow, and AI choices;
- `user-notification.test.js`: expected versus developmental error classification.

New behavior should receive a focused regression test at the lowest stable layer. Pure CSS fixes should be verified in both responsive stages because the Node suite does not perform visual layout testing.

## 12. Extension guidelines

When adding a feature:

1. Add shared action, status, card, timing, or score values to `Constants`.
2. Put authoritative policy in the server domain, normally `Room`, `Player`, or `Card`.
3. Add or update the stable DTO in `StateMapper`; do not make controllers normalize competing payload shapes.
4. Route a named action through `Server` and validate its room/player session.
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
