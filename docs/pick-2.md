# Pick 2 Software Design and Maintenance Reference

## 1. Purpose and authority

This document defines the observable behavior, architecture, contracts, and maintenance rules for Pick 2.
It explains what the software must do and where a policy belongs without describing
every private implementation detail.

The document is normative where it uses **MUST**, **MUST NOT**, **SHOULD**, or **MAY**. When behavior changes, update
this document, the README, the in-page FAQ, and focused tests in the same change.

Pick 2 has Direct and Hosted modes. Both modes expose the same Home and Room experiences, commands, core rules, response
envelope, client data shape, and in-memory storage model. Their transport and configured Host policies differ.

## 2. Product vocabulary

- **Home** is the room directory and room-creation experience.
- **Room** is both the active play/viewing page and the core domain object for one match.
- **Card** is the Pick2 game piece and owns its identity, rank, and rules.
- **Collection** is item storage. Its role comes from its owner and name: an actor hand, draw deck, or discard pile.
- **Actor** is a seated participant whose collection and turn state are private where appropriate. User-facing copy may
  call an Actor a Player.
- **Viewer** is connected to a Room without occupying a player seat.
- **Bot** is an automated Actor controlled by the host.
- **TurnOrder** is the Room's turn-order structure. It owns circular player order, direction, and the nullable
  turn-owner cursor. It MUST NOT own room or actor activity timestamps.
- **Host** is the authoritative coordinator for rooms, peers, commands, notifications, automated turns, and cleanup.

## 3. System boundaries

The application has root Home and Room entry points:

```text
index.html          Pick 2 Home page
room.html           Active Pick 2 Room page
ui/View.js          Shared Home and Room view objects
main.js             Browser startup and dependency wiring
core/               Pick2 items, actors, turns, cards, rules, bots, and DTO mapping
runtime/            Client, Host, browser runtime, and Node hosted runtime
ui/                 Pick2 pages, cards, controllers, state, styles, and utilities
server.js           Node WebSocketGateway entry point
```

The UI translates user interaction into named commands and renders authoritative snapshots. It MUST NOT implement a
second copy of room rules or normalize competing player DTO shapes.

The Host owns orchestration and authority. Core owns identity, collections, turn order, lifecycle, transfers, rules, and
round state. `StateMapper` defines the boundary between domain state and browser-safe data. Direct and Hosted hosts MUST
preserve these responsibilities even when their transports differ.

Direct mode connects `Client` directly to a browser-owned Host. Hosted mode connects the same Client API to a
server-owned Host through WebSocket transport. Both Hosts keep rooms only in memory: Direct rooms end when the browser
runtime ends, and Hosted rooms end when the server process ends. Hosted custom rooms do not automatically receive bots;
Direct custom rooms do according to the direct Host profile. Default rooms are created when each Host starts.

### 3.1 Runtime architecture

The runtime connects the UI to an authoritative `Host` without changing commands, responses, or game rules between
Direct and Hosted play. Transport and Host policy remain explicit differences:

```text
UI controller
    ↓ command
Client
    ├── Endpoint ─────────────────────┐
    │   (in-tab, cloned messages)     │
    │                                 ↓
    └── WebSocketEndpoint → WebSocketGateway → Host → Game / Room
                                      ↑
                                  PeerChannel
```

Responses return through the same path and always use the canonical `{ view, message, data }` envelope.

| File | Responsibility |
| --- | --- |
| `runtime/Client.js` | Adds tab and sort context, validates responses, and notifies controllers. |
| `runtime/Command.js` | Validates requests, carries resolved command context, and dispatches commands. |
| `runtime/Transport.js` | Defines the peer channel and the direct and WebSocket endpoint implementations. |
| `ui/View.js` | Selects Hosted transport or composes a browser-owned Host and direct Endpoint. |
| `runtime/WebSocketGateway.js` | Owns Node HTTP/WebSocket infrastructure and adapts sockets to peer channels. |
| `runtime/Host.js` | Defines Host policy and coordinates rooms, membership, publication, automation, and cleanup. |
| `runtime/RateLimit.js` | Enforces connection-, player-, and room-scoped throttles. |
| `runtime/RoomLifecycle.js` | Owns deferred empty-room checks and timer cleanup. |
| `runtime/Session.js` | Defines Host peer handles and owns peer, tab, room, and membership indexes. |

Changes belong to the layer that owns the concern:

- connection and reconnection behavior belongs in `Transport.js`;
- HTTP, WebSocket-server, and process-facing behavior belongs in `WebSocketGateway.js`;
- peer and membership indexing belongs in `Session.js`;
- authentication, command coordination, publication, and room cleanup belong in `Host.js`;
- card and round rules belong in `core/`;
- browser-safe response mapping belongs in `core/StateMapper.js`;
- page behavior and rendering belong in `ui/`.

The complete request, publication, reconnect, and teardown sequences are traced in [End-to-end flows](#53-end-to-end-flows).

`Host` MUST remain transport-neutral. It MUST NOT import browser globals, Node modules, Express, or WebSocket libraries.

## 4. Names and identity

Player and room names are user-facing identifiers, not arbitrary strings. A valid name MUST:

- contain between 2 and 24 characters for a Player, or between 2 and 48 characters for a Room;
- contain Unicode letters or numbers, with words separated only by spaces, apostrophes, curly apostrophes, or hyphens;
- have no leading or trailing whitespace;
- contain no symbols, control characters, repeated separator patterns, or separator-only content.

The accepted form is equivalent to:

```regex
^[\p{L}\p{N}]+(?:[ '\u2019-][\p{L}\p{N}]+)*$
```

Validation MUST occur at the user-facing boundary and again in the domain model. Normalized player keys are lookup
identifiers and may be more tolerant than creation validation; a key MUST NOT be treated as proof that the original
display name was valid.

Player names MUST be unique within a Room. Room capacity applies only to Players, not Viewers.

## 5. Room lifecycle and membership

### 5.1 Commands

The public command set is defined by `Constants`:

| Area                     | Commands                                                 |
| ------------------------ | ------------------------------------------------------- |
| Directory and membership | `list`, `create`, `view`, `join`, `leave`               |
| Play                     | `start`, `draw`, `discard`, `return`, `pass`, `declare` |

The Host MUST validate the Room and Player context for every command. A client-provided name, tab identifier, or room key
MUST NOT grant authority over another participant or Room.

### 5.2 Membership rules

- `list` returns the Home directory.
- `create` creates a Room and joins its first Player.
- `view` opens an existing Room without taking a seat. A successful new viewer updates `Room.lastActiveAt`.
- `join` adds a Player and removes that tab from the viewer set when applicable. Joining is allowed only while the Room
  is waiting or finished, according to the host profile and current lifecycle rules. Joining updates both the new
  Player's activity and the Room's activity.
- `leave` removes the current participant and returns the client to Home.
- A Player may move to viewing state. This updates Room activity and refreshes idle monitoring for the remaining
  eligible Players.
- A Viewer may leave at any time. Removing a viewer updates Room activity only when a viewer was actually removed.

### 5.3 End-to-end flows

Every scenario below uses the same startup, command, and publication paths. Later subsections describe only what differs;
they do not restate this pipeline.

#### Canonical startup and command pipeline

1. `main.js` chooses `HomeView` or `RoomView` from the page, and the view creates its controller and a `Client`.
2. `View.createClient(mode)` selects the transport. Direct mode composes `Host`, `Endpoint`, and `Connection`; Hosted
   mode uses `WebSocketEndpoint`, `WebSocketConnection`, and the server-side `WebSocketGateway`. Both connect
   the same `Client` to a `Host` through a `PeerChannel`.
3. `Host.accept()` creates a `PeerSession` in `SessionRegistry` and publishes the initial Home snapshot after startup.
4. `Client.request()` adds the tab identifier and current sort key. The selected transport delivers the request to
   `Host`, where `HostRequest`, `CommandContext`, `RateLimit`, and `CommandRouter` validate and dispatch it.
5. The handler authenticates the session and invokes the relevant `Room` or `Game` operation. Room mutations are queued,
   update activity and monitoring as required, and call `Room.onAnyChange`.
6. `Host` uses `StateMapper` to create recipient-specific data and publishes it through `PeerSession`. The transport
   returns it to `Client`, which sends it to the page controller for a complete render.

Unless a subsection says otherwise, “send,” “publish,” and “render” refer to steps 4–6 of this pipeline.

#### Home and Room admission

`HomeView` reads the preferred mode from `ViewState`. Hosted mode first uses `NetworkConnectionController` to discover
and verify its endpoint. When the client opens, `HomeController` sends `list`, stores the advertised capabilities, and
renders the directory through `RoomRowUtils`. Before navigating, it validates form input and `HomeView` stores the mode
and complete `create`, `view`, or `join` admission intent in `ViewState`.

`RoomView` restores that intent, constructs `RoomController` and `FaqController`, and opens the shared client. An
unaccompanied initial Home snapshot is ignored on the Room page. On open, `RoomController` sends the saved intent:

- `create`: `Host` validates admission, creates and registers the `Room`, attaches change and optional idle callbacks,
  joins the first human, and fills remaining seats with Bots when its `customBots` policy is `fill`. `SessionRegistry`
  records membership; the Host sends Room state and a welcome notification and refreshes the Home directory. After
  success, `RoomView` persists `join` instead of `create` so reconnect cannot recreate the Room.
- `view`: `Room.view()` adds the tab as a Viewer and updates Room activity only for a new viewer. `SessionRegistry` then
  records viewer membership and the Host sends viewer-specific state.
- `join`: `Host` checks lifecycle, capacity, name uniqueness, and session eligibility. `Room.joinActor()` creates the
  Actor, removes the tab from the viewer set, and updates activity. `SessionRegistry` upgrades the membership before the
  Host sends Player-specific state and the welcome notification.

Room publications do not implicitly refresh Home subscribers. Room creation and closure explicitly broadcast the Home
directory.

#### Round and command lifecycle

For `start`, `Host` verifies seated membership and calls `Room.startRound()`. The Room checks its state and minimum actor
count, resets round data, deals, selects the opening play and turn owner, changes to `active`, and publishes. A local
Player's `waiting`-to-`active` render triggers the countdown described in [Dialog transitions](#dialog-transitions).

For `draw`, `pass`, `discard`, `return`, or `declare`, `Game.execute()` selects the corresponding Room operation. The
Room validates lifecycle, turn and pending-decision ownership, card ownership, and game rules before mutating. If the
next owner is a Bot, `Host` continues `Game.runAutomatedTurn()` through the same operations and publication pipeline
until human input or a pending decision is required.

When a round ends, the Room records winners and losers, changes to `finished`, stops turn monitoring, and publishes. It
remains finished until the next authenticated game command. `Game.execute()` then calls `Room.resumeWaiting()`, which
clears completed-round control metadata while preserving players and collections, publishes the waiting state, and
applies the requested free transaction. With no later command, the final state remains observable.

#### Dialog transitions

All dialogs inherit display and dismissal behavior from `ViewController`; their controllers own content and cleanup.

| Dialog | Opens when | Closes or updates when |
| --- | --- | --- |
| Alert | A controller receives a normalized server or client notification. | Its dismiss button hides it. Admission failures and Room-closure notices are saved in `ViewState`, carried Home, and displayed there. |
| Countdown | A local Player renders a `waiting`-to-`active` transition. | Its timer reaches zero or the Player dismisses it. Viewers and other transitions do not open it. |
| Suit selection | The local Player owns a pending `declare` decision. | Submission sends `declare`; any snapshot without that local pending decision hides it. Temporary dismissal schedules redisplay while it remains pending. |
| Results | A local Player first renders a transition into `finished`. | Dismissal clears its rendered details. Later finished snapshots do not reopen it; a non-finished snapshot keeps it hidden. |

#### Idle Player and empty-Room cleanup

The monitored human Players are defined in [Who is monitored](#63-who-is-monitored). When an idle timer expires, `Host`
moves that Player to viewing state, publishes the Room, and sends the affected client a warning. If no Players remain,
`RoomLifecycle` schedules an empty-Room check for the grace interval; a later join cancels it.

When the check expires, `Host` verifies that the Room is still empty, detaches its callbacks, unregisters it, refreshes
the Home directory, and sends affected Room sessions a single response containing Home state and a `Room closed`
notification. `RoomView` saves the warning, disconnects, and returns Home, where the alert flow displays it.

#### Departure and hosted reconnect

On `leave`, `RoomController` clears the admission intent, disconnects, and navigates Home while the canonical pipeline
removes the Viewer or Player. `Room` recycles a departing Player's hand when applicable and refreshes activity and idle
monitoring; `SessionRegistry` removes membership; `Host` applies Bot continuation or empty-Room cleanup and publishes to
remaining sessions. A transport closure performs the same server-side membership cleanup.

On a Hosted connection loss, `WebSocketConnection` reports status and performs bounded reconnect attempts without
changing authoritative Room state. A new socket produces a replacement `PeerSession`; the controller sends `list` or
its saved admission intent again using the same tab identifier. `Host` and `SessionRegistry` replace stale peer ownership
and publish a fresh authoritative snapshot, which the controller renders completely before normal handling resumes.

### 5.4 Room states

- **waiting**: no active turn is required; `turnOwnerKey` is null. Seated Players may perform the waiting-state commands
  allowed by the core rules.
- **active**: ordinary turn order and game legality apply. `pending` may describe a required game-specific decision
  without creating another lifecycle level.
- **finished**: the round has ended and actor collections provide final penalties. It remains observable until the next
  authenticated actor command resumes waiting or a new round starts.

State transitions MUST clear or establish the turn-owner cursor consistently. Starting a round establishes a valid
owner; resuming waiting after finished clears it.

## 6. Activity and idleness policy

### 6.1 Ownership of activity

`Player.lastActiveAt` measures activity for one seated Player. It is used to decide whether that Player is idle.
`Room.lastActiveAt` measures activity for the Room and is used for room-level recency and empty-room cleanup.

`TurnOrder` MUST NOT track activity. Turn order is not activity, and adding timestamps to the circle would duplicate
ownership and create inconsistent state.

### 6.2 What updates activity

A successful Player command MUST update both the acting Player and the Room. This includes drawing, discarding, returning
a discard, passing, and declaring a suit. Starting a round or resuming waiting after finished also establishes fresh
activity for the relevant lifecycle.

Viewer activity MUST update only `Room.lastActiveAt`. A viewer becoming a Player MUST update the new
`Player.lastActiveAt` and `Room.lastActiveAt`. Joining, leaving a viewer, and moving a Player to viewing state update
Room activity when the membership change actually occurs.

Failed commands MUST NOT be treated as successful Player activity. Internal lifecycle transitions may refresh timestamps
when they establish a new monitoring window; they MUST NOT introduce a separate circle timestamp.

### 6.3 Who is monitored

Hosted idle monitoring uses `Constants.MAX_IDLE_MS` (currently 30 seconds). Bots are never monitored because the host
advances automated turns promptly.

- While the Room is **active** and has a turn owner, only the current human turn owner is monitored.
- While the Room is **waiting**, every human Player is monitored.
- Players who are not eligible under the current state MUST have idle monitoring stopped.
- When the monitored set changes, each newly monitored Player begins a fresh idle window. Advancing a turn therefore
  transfers the monitoring window to the new human owner.

An idle human Player is demoted to viewing state, not silently deleted from the Room interaction. The affected client
MUST receive a warning notification. If the demotion leaves the Room with no Players, the Host starts a grace-period
empty-room check for another `MAX_IDLE_MS`.

When the empty-room check expires and the Room is still empty, the Host MUST close and unregister the Room. Direct mode
disables automatic idle monitoring; its lifecycle is owned by the browser page.

## 7. Game rules and round behavior

Starting requires at least two Players. It creates and shuffles a deck, deals seven cards to each Player, chooses a valid
initial discard, and selects the first turn owner. The turn owner may draw, discard, or pass only when the command is
legal for the current state.

While playing, turn order, draw penalties, discard legality, skip/reverse effects, and suit declarations are
authoritative core rules. A suit-changing ace moves the Room to pending until its owner declares a standard suit.

While waiting with no turn owner, the waiting-state permissions apply and playing-only legality checks do not. A round
finishes when a hand is emptied or the seven of hearts ends the round under its rule. Remaining hand penalties determine
the winner or tied winners.

While waiting, a Player may move cards freely in either direction between their hand and the discard pile, subject to
membership and card-presence validation inside the Room operation queue. Finished Rooms expose the same controls; the
first authenticated game command changes the Room to waiting before applying the requested transaction. These free
transactions preserve card rotation, update penalty and activity, and do not consume draw allowance or apply playing-card
effects. They are rejected while the Room is active unless the active-round rules specifically permit the command.

Hand sorting is committed with the next draw, discard, return, or pass. Temporary browser sorting is not a server-side
command for every selection. Drawing resets the temporary client sort to `none` so newly drawn cards are visibly distinct
until the Player sorts again.

All ranks MUST use the shared card-rank policy in `Constants`; no UI or bot may calculate a competing rank.

## 8. Automated Players

Bots use the same legal command and card rules as human Players. Their strategy MAY use their own cards, public turn
order, visible hand counts, card effects, and discard history. It MUST NOT inspect opponents' hidden card identities or
private hand penalties.

Because discarded cards may return to the deck when the discard pile is recycled, bot decisions MUST use the live public
discard pile rather than a permanent assumption that a discarded card is unavailable.

Bot heuristics may estimate responses, urgency, suit strength, and the value of ending a round, but those estimates are
subordinate to authoritative Room legality. A strategy change requires focused tests for both the chosen behavior and
the unchanged legality boundary.

## 9. Client/server contract

Requests contain a command and data object. The client adds the per-tab identifier and current temporary hand sort
before sending. Room requests use `data.roomName`; browser navigation uses:

```text
room.html?mode=<direct-or-hosted>&room=<room-name>
```

Responses use one envelope in both modes:

```js
{
    view: "home" | "room" | null,
    message: { status, title, message } | null,
    data: Object | null
}
```

`view` identifies the state destination. `data` is the authoritative snapshot. `message` is an optional user-facing
notification. A response MAY contain both `data` and `message`; clients MUST process the state transition and
notification together rather than dropping the notice.

Room closure MUST use one response containing Home data and the `Room closed` warning, allowing the client to navigate
and preserve the notice as the single transition traced in [Idle Player and empty-Room
cleanup](#idle-player-and-empty-room-cleanup).

Home room summaries include `name`, `state`, `actorLimit`, `viewers`, `lastActiveAt`, and `createdAt`. Room data adds
`localActorName`, `turnOrder`, public collections, winners, and pending decision state. `turnOrder.actorCount` is the
canonical occupied-seat count. `collections.play.items` contains public discards; `collections.draw.itemCount` exposes
only the draw count.

The browser-safe turn order contains `actors`, `actorCount`, `turnOwnerKey`, and `direction`. It MUST NOT contain
`createdAt` or `lastActiveAt`. Each actor DTO has one stable foundation with `key`, `name`, `state`, and `collection`;
Pick 2 adds only required fields such as `drawAllowance`.

`Actor`, `TurnOrder`, and `Collection` retain the responsibilities defined in [Product vocabulary](#2-product-vocabulary);
their browser-safe forms MUST preserve those boundaries rather than introducing a second DTO model.

## 10. Notifications and failures

`UserNotification` is for expected, actionable conditions such as an invalid name, full Room, illegal play, or acting
out of turn. The Host converts it to a user-facing error notification rather than treating it as an internal failure.

Development failures, malformed contracts, impossible domain state, invalid internal card values, and syntax or
infrastructure defects MUST remain ordinary errors. The runtime sends a generic server-error notification while
preserving the original error for logging and diagnosis. Do not convert a development failure into `UserNotification`
merely to avoid handling it.

The notification title contains the first meaningful statement. The message body contains only the remaining detail,
preventing duplicated opening text.

## 11. UI, accessibility, and presentation contracts

- The default CSS presentation is mobile-first.
- One `min-width: 721px` stage serves tablet and desktop layouts; do not add additional width breakpoints without
  documenting the need.
- Common foundations belong in the appropriate base stylesheet. Table foundations belong in `ui/styles/table.css`.
- Hovered or keyboard-focused table rows use translucent cyan. A selected row uses solid cyan text without adding a
  background.
- Mutable UI state uses existing `data-*` hooks and `DomUtils.setBooleanState`.
- A `PlayingCard` is interactive only when its controller supplies a drop destination. The complete state matrix,
  property behavior, event contract, and static-card rules are defined in section 12.
- Viewers do not receive Player-only start or result overlays.
- When a local Player exists, displayed Player sequences begin with that Player while preserving circle order.
- Templates resolve relative to their owning component module and live under `ui/templates/`.

## 12. Card data and interaction

`core/Card.js` owns card identity, Pick2 ranking and special-card rules. `core/CardCollection.js` provides the
collection used by hands and decks, including the canonical deck factory and instance sorting. Card presentation and
artwork live in `ui/`.

Each card has a `rank`; a collection's `penalty` is the sum of its card ranks. The actor with the lowest remaining
penalty wins.

`Card` is immutable initial game data. Its `value`, `suit`, and `rotation` fields are validated during construction;
`rank` is calculated and stored once. Its `id` is derived from the frozen value and suit. Create another
`Card` to change its data. Rotation defaults to a random angle when omitted. `toJSON()` preserves the saved format
`{value, suit, rank, rotation}`.

`PlayingCard` displays this data. Supplying a destination enables both user flipping and dragging; omitting it creates a
static card:

```js
const card = new Card("a", "spades", 15);
const handCard = PlayingCard.create(card, discardPile);
const faqCard = PlayingCard.create(card);

// Presentation can be updated programmatically for either kind.
faqCard.isFaceUp = false;
faqCard.rotation = null; // Let CSS choose the angle.
```

The destination must be an HTML element or `null`. It is stored privately for the lifetime of that element. There is no
shared destination and no separate `isInteractive`, `isDraggable`, `data-interactive`, or `data-decorative` setting.
Controllers recreate cards when room state changes.

| Destination and state                                 | Drop target  | User interaction |
| ----------------------------------------------------- | ------------ | ---------------- |
| Local hand while waiting or finished                  | Discard pile | Flip and drag    |
| Local hand during an allowed playing turn             | Discard pile | Flip and drag    |
| Discard pile while waiting or finished, with a Player | Local hand   | Flip and drag    |
| Other discard states, spectators, FAQ, fan, results   | None         | None             |

Awaiting-decision and transport-busy states disable interaction. A suit-only declared-suit display always remains
static. Waiting or finished Players may take any real card in the discard pile into their own hand; this is not
restricted to their own earlier discards.

### 12.1 Element properties and markup

The element's `value` and `suit` getters read its presentation attributes. `rank` uses the supplied game rank,
falling back to the canonical rank. It returns `null` for suit-only cards. The `rotation` and `isFaceUp`
setters validate changes and synchronize CSS or accessibility. `isDragging` reads the active drag state, with no
separate stored boolean.

All cards use `data-value`, `data-suit`, and `data-is-face-up`. An explicit rotation uses `--card-rotation`; clearing it
makes the getter return `null`. Static cards use `role="img"` and a descriptive accessible name. Interactive cards
additionally have a drag handle, `role="button"`, `tabindex="0"`, and `data-is-dragging`. Static cards omit drag state
attributes, handles, and interaction listeners. The decorative Home fan is hidden through its containing element's
`aria-hidden`.

`update(card)` validates before changing identity or rotation, cancels any active drag, and preserves face state. Assign
`isFaceUp` directly to flip programmatically. Drag previews are freshly constructed static cards, preserving face and
rotation. At drag start, the source computed height is captured in pixels as the preview's `--card-height`. It stays
fixed throughout the drag, with width and visual details derived from that height. The destination resumes its own
responsive sizing after the transfer. Rotated bounding rectangles and viewport size do not set preview height.

### 12.2 Card transfers

A release inside the configured target dispatches `card_drop` there with `{card: {value, suit}, source, target}`.
Releasing elsewhere restores the source. The element never moves cards between game collections itself.

`RoomController` routes a hand drop to `discard` and an eligible discard-to-hand drop to `return`; both use the command
flow in section 5.3, including its finished-to-waiting transition. `Room.returnItem()` performs membership,
card-presence, and transfer validation in its queue. Invalid, duplicate, or stale returns cannot move a card, and a
return neither consumes draw allowance nor applies playing-card effects.

## 13. Testing and verification

Run `npm test` before completing a change. Use `npm run test:coverage` when reviewing branch coverage. Focused tests
belong at the lowest stable layer:

- `card.test.js`: constants, scoring, and card rules;
- `card-collections.test.js` and `collections.test.js`: deck, hand, sorting, serialization, and TurnOrder behavior;
- `infrastructure.test.js`: serialization, state mapping, and throttling;
- `room.test.js`: membership, lifecycle, activity, idle monitoring, game flow, and bot choices;
- `user-notification.test.js`: expected versus developmental error handling;
- `local-game.test.js` and `network-connection.test.js`: page structure, routing, transport, and deployment-facing
  contracts.

Any change to activity policy MUST test Player and Room timestamps, monitored human selection by lifecycle state, bot
exclusion, demotion notification, and empty-room closure. Any change to common markup or CSS MUST be checked against the
root `index.html` Home and `room.html`, including the mobile and 721px presentations.

Every application class, class field, method, getter, setter, and named function MUST have adjacent JSDoc. Public and
extension APIs document their behavioral contract, parameters, return value, and important failures where applicable.
Private declarations may use a concise purpose statement; private fields include a useful `@type`. Test callbacks and
ordinary local variables are not APIs and do not require JSDoc. The architecture test enforces declaration coverage.

## 14. Extension rules

1. Keep timing, protocol, item identities, rules, and scoring in the appropriate core modules.
2. Use `CardCollection` for every card-storage role and add specialized behavior only when Pick 2 needs it.
3. Map game state in `StateMapper` and integrate it through `Game`; hosting receives the game explicitly.
4. Validate Room, Player, Viewer, and ownership context in the Host before dispatching a command.
5. Reuse existing controller, template, validation, notification, sorting, and DOM-state patterns.
6. Preserve semantic markup, `data-*` state hooks, accessibility relationships, and the repository's CSS cascade
   standards.
7. Add tests for valid behavior, expected user failures, and important internal contract failures.
8. Update this document, the README, and the in-page FAQ whenever public behavior, policy, or operational behavior
   changes.

## 15. Operations

- Default Node port: `8080`; override with `PORT`.
- Health endpoint: `GET /health`.
- Node serves Pick 2 Home at `/` and active rooms at `/room.html`. The same relative links work below a static host's
  subdirectory.
- Room exit and failed admission return to Pick 2 Home.
- Graceful shutdown handles `SIGINT` and `SIGTERM` and closes connections.
- Uncaught exceptions and unhandled promise rejections are logged and trigger `WebSocketGateway` shutdown because Host
  state may be unsafe.
- The application is proprietary; see the README copyright and license notice.
