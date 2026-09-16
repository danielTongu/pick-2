# Pick 2 Software Design and Maintenance Guide

## 1. Purpose and authority

This document defines the observable behavior, architecture, contracts, and maintenance rules for Pick 2. It is written
for maintainers and contributors: it explains what the software must do and where a policy belongs without describing
every private implementation detail.

The document is normative where it uses **MUST**, **MUST NOT**, **SHOULD**, or **MAY**. When behavior changes, update
this document, the README, the in-page guide, and focused tests in the same change.

Pick 2 has Direct and Hosted modes. Both modes expose the same Home and Room experiences, actions, core rules, response
envelope, and client data shape. The transport and persistence boundary differs by mode.

## 2. Product vocabulary

- **Home** is the room directory and room-creation experience.
- **Room** is both the active play/viewing page and the core domain object for one match.
- **Card** is the Pick2 game piece and owns its identity, score, and rules.
- **Collection** is item storage. Its role comes from its owner and name: an actor hand, draw deck, or discard pile.
- **Actor** is a seated participant whose collection and turn state are private where appropriate. User-facing copy may
  call an Actor a Player.
- **Viewer** is connected to a Room without occupying a player seat.
- **Bot** is an automated Actor controlled by the host.
- **TurnOrder** is the Room's turn-order structure. It owns circular player order, direction, and the nullable
  turn-owner cursor. It MUST NOT own room or actor activity timestamps.
- **Host** is the authoritative coordinator for rooms, peers, actions, notifications, automated turns, and cleanup.

## 3. System boundaries

The application has root Home and Room entry points:

```text
index.html          Pick 2 Home page
room.html           Active Pick 2 Room page
index.js            Shared Home and Room application entry point
core/               Pick2 items, actors, turns, cards, rules, bots, and DTO mapping
runtime/            Client, Host, browser runtime, and Node hosted runtime
ui/                 Pick2 pages, cards, controllers, state, styles, and utilities
server.js           Node Network entry point
```

The UI translates user interaction into named actions and renders authoritative snapshots. It MUST NOT implement a
second copy of room rules or normalize competing player DTO shapes.

The Host owns orchestration and authority. Core owns identity, collections, turn order, lifecycle, transfers, rules, and
round state. `StateMapper` defines the boundary between domain state and browser-safe data. Direct and Hosted hosts MUST
preserve these responsibilities even when their transports differ.

Direct mode connects `Client` directly to a browser-owned Host and uses browser storage for custom room definitions.
Hosted mode connects through a WebSocket and uses the Node runtime's storage adapter. Hosted custom rooms do not
automatically receive bots; Direct custom rooms do according to the direct host profile. Default rooms remain available
according to the configured defaults.

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

### 5.1 Actions

The public action set is defined by `Constants`:

| Area                     | Actions                                                 |
| ------------------------ | ------------------------------------------------------- |
| Directory and membership | `list`, `create`, `view`, `join`, `leave`               |
| Play                     | `start`, `draw`, `discard`, `return`, `pass`, `declare` |

The Host MUST validate the Room and Player context for every action. A client-provided name, tab identifier, or room key
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

Starting requires at least two Players. In Direct mode, leaving an owned custom Room ends that browser-owned Room and
returns Home; configured default Rooms remain available. A finished Direct Room may be restarted without creating a new
Room.

### 5.3 End-to-end flows

#### Entering a Room as a Player

1. The client loads Home and requests the current Room directory.
2. The user creates a Room or selects an existing Room to view.
3. The client navigates to the Room page and requests a Room snapshot.
4. The user submits a valid Player name. The Host verifies the Room, seat capacity, name uniqueness, and membership
   state.
5. The Room adds the Player, removes that tab from its viewer set, updates the Player and Room activity timestamps, and
   returns the updated Room snapshot.
6. The Host sends the Player welcome notification after the state response.
7. If the Room now satisfies the start requirement, the Player may start the round.

#### Viewing a Room

1. The client requests an existing Room without a Player name.
2. The Host registers the tab as a Viewer and returns the Room snapshot.
3. The Room updates `Room.lastActiveAt` when the tab becomes a new Viewer.
4. The Viewer may later join if membership is unlocked, or leave and return to Home without becoming a Player.

#### Starting and playing a round

1. A Player requests `start`; the Host verifies ownership and the minimum Player count.
2. The Room resets round state, shuffles and deals its items, selects the opening play and turn owner, changes to
   `active`, records Room activity, and establishes idle monitoring.
3. The current human turn owner requests `draw`, `discard`, or `pass`.
4. The Room validates the action, applies its card and turn rules, updates the acting Player and Room activity, advances
   the turn when required, and refreshes monitoring.
5. The Host broadcasts the resulting Room snapshot. If the next turn belongs to a Bot, the Host continues the automated
   turn before returning to normal human interaction.
6. In Pick 2, a suit-changing card sets `room.pending` to an awaiting-decision descriptor; only its turn owner may
   declare the suit. The Room remains active.
7. When a round-ending condition occurs, the Room marks winning and losing actors, changes to `finished`, and stops
   active-turn monitoring.

#### Idle Player and empty-room cleanup

1. The Host monitors only the eligible human Players defined in the activity policy. Monitoring is transferred whenever
   the Room state or turn owner changes.
2. When the monitored Player exceeds the idle duration, the Host moves that Player to viewing state, updates Room
   activity, and sends the affected client a warning together with the updated Room snapshot.
3. If no Players remain, the Host leaves the Room available during one grace interval and schedules a second empty-room
   check.
4. If a Player rejoins before the check, the Room remains available; when the check runs it observes that the Room is no
   longer empty and does not close it.
5. If the Room is still empty when the check expires, the Host unregisters and removes it, then sends affected Room
   clients a combined Home snapshot and `Room closed` warning. Those clients navigate to Home and display the warning.

#### Leaving and returning Home

1. A Player or Viewer requests `leave`, or the transport closes and the Host removes the client from its Room
   membership.
2. The Room removes the participant, recycles a departing Player's hand when applicable, updates Room activity, and
   refreshes idle monitoring.
3. The Host continues a Bot turn if the Room remains valid; otherwise it starts or performs empty-room cleanup.
4. The departing client receives Home state and no longer controls the Room.

#### Hosted reconnect

The Hosted client reports connection state separately from Room state. A reconnecting browser MUST re-establish its
endpoint before issuing Room actions and MUST use a fresh authoritative snapshot rather than assuming that a prior
snapshot is still current. The Host remains the source of truth for membership, turns, activity, and cleanup during the
disconnect.

### 5.4 Room states

- **waiting**: no active turn is required; `turnOwnerKey` is null. Seated Players may perform the waiting-state actions
  allowed by the core rules.
- **active**: ordinary turn order and game legality apply. `pending` may describe a required game-specific decision
  without creating another lifecycle level.
- **finished**: the round has ended and actor collections provide final scores.

State transitions MUST clear or establish the turn-owner cursor consistently. Starting or resetting a round establishes
a valid owner; returning to waiting clears it.

## 6. Activity and idleness policy

### 6.1 Ownership of activity

`Player.lastActiveAt` measures activity for one seated Player. It is used to decide whether that Player is idle.
`Room.lastActiveAt` measures activity for the Room and is used for room-level recency and empty-room cleanup.

`TurnOrder` MUST NOT track activity. Turn order is not activity, and adding timestamps to the circle would duplicate
ownership and create inconsistent state.

### 6.2 What updates activity

A successful Player action MUST update both the acting Player and the Room. This includes drawing, discarding, returning
a discard, passing, and declaring a suit. Starting or resetting a round also establishes fresh activity for the relevant
lifecycle.

Viewer activity MUST update only `Room.lastActiveAt`. A viewer becoming a Player MUST update the new
`Player.lastActiveAt` and `Room.lastActiveAt`. Joining, leaving a viewer, and moving a Player to viewing state update
Room activity when the membership change actually occurs.

Failed actions MUST NOT be treated as successful Player activity. Internal state-reset transitions may refresh
timestamps when they establish a new monitoring window; they MUST NOT introduce a separate circle timestamp.

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

Starting creates and shuffles a deck, deals seven cards to each Player, chooses a valid initial discard, and selects the
first turn owner. The turn owner may draw, discard, or pass only when the action is legal for the current state.

While playing, turn order, draw penalties, discard legality, skip/reverse effects, and suit declarations are
authoritative core rules. A suit-changing ace moves the Room to pending until its owner declares a standard suit.

While waiting with no turn owner, the waiting-state permissions apply and playing-only legality checks do not. A round
finishes when a hand is emptied or the seven of hearts ends the round under its rule. Remaining hand scores determine
the winner or tied winners.

While waiting, a Player may return any real discard card to their own hand. The `return` action MUST validate
membership, waiting state, and card presence inside the Room operation queue. It preserves the card's rotation, updates
hand score and activity, and broadcasts the transfer without consuming draw allowance or applying card effects. Returns
MUST be rejected in every other state.

Hand sorting is committed with the next draw, discard, return, or pass. Temporary browser sorting is not a server-side
action for every selection. Drawing resets the temporary client sort to `none` so newly drawn cards are visibly distinct
until the Player sorts again.

All scoring MUST use the shared card-score policy in `Constants`; no UI or bot may calculate a competing score.

## 8. Automated Players

Bots use the same legal action and card rules as human Players. Their strategy MAY use their own cards, public turn
order, visible hand counts, card effects, and discard history. It MUST NOT inspect opponents' hidden card identities or
private hand scores.

Because discarded cards may return to the deck when the discard pile is recycled, bot decisions MUST use the live public
discard pile rather than a permanent assumption that a discarded card is unavailable.

Bot heuristics may estimate responses, urgency, suit strength, and the value of ending a round, but those estimates are
subordinate to authoritative Room legality. A strategy change requires focused tests for both the chosen behavior and
the unchanged legality boundary.

## 9. Client/server contract

Requests contain an action and data object. The client adds the per-tab identifier and current temporary hand sort
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

When a Room closes, affected Room clients receive Home data and a `Room closed` warning with `No players remain.` They
MUST navigate to Home and display that warning. This is a single state transition, not a stale Room followed by a
separate best-effort redirect.

Home room summaries include `name`, `state`, `actorLimit`, `viewers`, `lastActiveAt`, and `createdAt`. Room data adds
`localActorName`, `turnOrder`, public collections, winners, and pending decision state. `turnOrder.actorCount` is the
canonical occupied-seat count. `collections.play.items` contains public discards; `collections.draw.itemCount` exposes
only the draw count.

The browser-safe turn order contains `actors`, `actorCount`, `turnOwnerKey`, and `direction`. It MUST NOT contain
`createdAt` or `lastActiveAt`. Each actor DTO has one stable foundation with `key`, `name`, `state`, and `collection`;
Pick 2 adds only required fields such as `drawAllowance`.

Pick 2 uses `core/Actor.js` for identity, activity, a configured collection, and resettable round state. Its room uses
`core/TurnOrder.js` for ordered membership and turn ownership through `add`, `remove`, `get`, `setOwner`, `move`,
`relative`, and `reverse`. Core code calls game pieces `items`, players `actors`, and item storage a `collection`.

## 10. Notifications and failures

`UserNotification` is for expected, actionable conditions such as an invalid name, full Room, illegal play, or acting
out of turn. It becomes an informational or warning notification suitable for the user.

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
- A `PlayingCard` is interactive only when its controller supplies a drop destination. This enables keyboard/pointer
  flipping and pointer dragging. Eligible local-hand cards target the discard pile; waiting discard cards target the
  local hand. Other discard states, guide cards, result cards, and the Home fan are static and omit interaction markup
  and listeners. Suit-only markers are always static. The complete property and event contract is defined below.
- Viewers do not receive Player-only start or result overlays.
- When a local Player exists, displayed Player sequences begin with that Player while preserving circle order.
- Templates resolve relative to their owning component module and live under `ui/templates/`.

## 12. Card data and interaction

`core/Card.js` owns card identity, Pick2 scoring and special-card rules. `core/CardCollection.js` provides the
collection used by hands and decks, including the canonical deck factory. Card presentation and artwork live in `ui/`.

`Card` is immutable initial game data. Its ordinary `value`, `suit`, and `rotation` fields are validated during
construction. Only `rank` and `score` need getters, since they are derived from identity. Create another `Card` to
change its data. Rotation defaults to a random angle when omitted. `toJSON()` preserves the saved format
`{value, suit, score, rotation}`.

`PlayingCard` displays this data. Supplying a destination enables both user flipping and dragging; omitting it creates a
static card:

```js
const card = new Card("a", "spades", 15);
const handCard = PlayingCard.create(card, discardPile);
const guideCard = PlayingCard.create(card);

// Presentation can be updated programmatically for either kind.
guideCard.isFaceUp = false;
guideCard.rotation = null; // Let CSS choose the angle.
```

The destination must be an HTML element or `null`. It is stored privately for the lifetime of that element. There is no
shared destination and no separate `isInteractive`, `isDraggable`, `data-interactive`, or `data-decorative` setting.
Controllers recreate cards when room state changes.

| Destination and state                                 | Drop target  | User interaction |
| ----------------------------------------------------- | ------------ | ---------------- |
| Local hand while waiting                              | Discard pile | Flip and drag    |
| Local hand during an allowed playing turn             | Discard pile | Flip and drag    |
| Discard pile while waiting, with a local player       | Local hand   | Flip and drag    |
| Other discard states, spectators, guide, fan, results | None         | None             |

Awaiting-decision and transport-busy states disable interaction. A suit-only declared-suit display always remains
static. Waiting players may take any real card in the discard pile into their own hand; this is not restricted to their
own earlier discards.

### 12.1 Element properties and markup

The element's `value` and `suit` getters read its presentation attributes. `rank` is calculated; `score` uses the
supplied game score, falling back to natural rank. Both return `null` for suit-only cards. The `rotation` and `isFaceUp`
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

The Room controller routes a hand drop to `discard` and a waiting discard return to `return`. Both Direct and Hosted
modes use the same authenticated Host handler. `Room.returnItem()` validates membership, waiting state, card presence,
and sorting inside its operation queue, then moves the card, updates hand score and activity, and broadcasts the new
state. Invalid, duplicate, or stale returns cannot move a card. Returning does not consume a draw allowance or apply
playing-card effects.

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
4. Validate Room, Player, Viewer, and ownership context in the Host before dispatching an action.
5. Reuse existing controller, template, validation, notification, sorting, and DOM-state patterns.
6. Preserve semantic markup, `data-*` state hooks, accessibility relationships, and the repository's CSS cascade
   standards.
7. Add tests for valid behavior, expected user failures, and important internal contract failures.
8. Update this document, the README, and the in-page guide whenever public behavior, policy, or operational behavior
   changes.

## 15. Operations

- Default Node port: `8080`; override with `PORT`.
- Health endpoint: `GET /health`.
- Node serves Pick 2 Home at `/` and active rooms at `/room.html`. The same relative links work below a static host's
  subdirectory.
- Room exit and failed admission return to Pick 2 Home.
- Graceful shutdown handles `SIGINT` and `SIGTERM` and closes connections.
- Uncaught exceptions and unhandled promise rejections are logged and trigger Network shutdown because host state may be
  unsafe.
- The application is proprietary; see the README copyright and license notice.
