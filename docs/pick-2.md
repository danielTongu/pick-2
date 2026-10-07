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
- **Room** is the active play/viewing context and owns the current `Match`.
- **Card** is the Pick2 game piece and owns its identity, rank, and rules.
- **Collection** is item storage. Its role comes from its owner and name: an actor hand, draw deck, or discard pile.
- **Actor** is a seated game entity whose collection and turn state are private where appropriate.
- **Viewer** is connected to a Room without occupying an actor seat.
- **Bot** is an automated Actor controlled by the host.
- **TurnOrder** is the Room's turn-order structure. It owns circular actor order, direction, and the nullable
  turn-owner cursor. It MUST NOT own room or actor activity timestamps.
- **Host** is the authoritative coordinator for rooms, connections, commands, notifications, automated turns, and cleanup.

## 3. System boundaries

The application has root Home, Connection, and Room entry points:

```text
index.html          Pick 2 Home page
connection.html     Hosted server selection page
room.html           Active Pick 2 Room page
ui/Session.js          Shared browser client session, Home, Connection, and Room sessions
ui/controllers/ConnectionController.js Hosted connection page controller
main.js             Browser startup and dependency wiring
core/               Pick2 items, actors, turns, cards, rules, bots, and DTO mapping
host/               Host coordination, connections, and request handling
ui/                 Pick2 pages, cards, controllers, state, styles, and utilities
server.js           Node HTTP/WebSocket server and process lifecycle
```

The UI translates user interaction into named commands and renders authoritative snapshots. It MUST NOT implement a
second copy of room rules or normalize competing actor DTO shapes.

The Host owns orchestration and authority. Core owns identity, collections, turn order, lifecycle, transfers, rules, and
match state. `StateMapper` defines the boundary between domain state and browser-safe data. Direct and Hosted hosts MUST
preserve these responsibilities even when their transports differ.

Direct mode connects `Session` directly to a browser-owned Host. Hosted mode connects the same Session API to a
server-owned Host through WebSocket transport. Both Hosts keep rooms only in memory: Direct rooms end when the browser
runtime ends, and Hosted rooms end when the server process ends. Hosted custom rooms do not automatically receive bots;
Direct custom rooms do according to the direct Host profile. Default rooms are created when each Host starts.

### 3.1 Runtime architecture

The runtime connects the UI to an authoritative `Host` without changing commands, responses, or game rules between
Direct and Hosted play. Transport and Host policy remain explicit differences:

```text
UI controller
    ↓ command
Session
    ├── local Host ──────────────────┐
    │   (in-tab, cloned messages)    │
    │                                ↓
    └── WebSocket → server.js → Host → Room → Match
                                            ↑
                                      HostConnection
```

Responses return through the same path and always use the canonical `{ view, message, data }` envelope.

| File | Responsibility |
| --- | --- |
| `host/HostConnection.js` | Owns Host-side connection state and transport send/disconnect callbacks. |
| `host/RoomMembership.js` | Tracks one tab's actor or viewer membership in a room. |
| `ui/Session.js` | Owns client requests, responses, local delivery, and WebSocket reconnects. |
| `ui/controllers/ConnectionController.js` | Owns the Hosted connection form and probe diagnostics. |
| `server.js` | Owns Node HTTP/WebSocket infrastructure, process lifecycle, and socket adaptation. |
| `host/Host.js` | Validates requests and coordinates rooms, membership, publication, throttling, automation, and cleanup. |
| `host/HostRequest.js` | Holds validated request data. |
| `host/HostRequestContext.js` | Holds resolved context for one host request. |
| `host/RoomLifecycle.js` | Owns deferred room closure, knockout starts, bot-return timers, and cleanup. |
| `host/ConnectionRegistry.js` | Owns Home subscriptions and room-membership indexes. |

### State and resource ownership

Store authoritative state on the object whose lifetime it describes. Owners perform their own reset and cleanup;
other layers request an operation or consume a snapshot rather than maintaining a parallel copy.

| Owner | Structures and lifetime |
| --- | --- |
| `Card` / `CardCollection` | Card identity and collection items. Counts and penalties are derived. |
| `Actor` / `BotActor` | Identity, hand, draw allowance, actor state, and idle monitoring. BotActor executes delayed commands through Room. |
| `BotStrategy` / `CardOdds` | One-decision snapshots of the bot hand, reachable opponent hands, and public match information; pure probability calculations. The draw collection and distant hands remain unknown. |
| `TurnOrder` | Actor map, ordered actor keys, turn owner, and direction. Its map and key list are maintained together. |
| `Match` | Draw/play collections, pending declaration, declared suit, match state, and last discarding actor. |
| `Knockout` | Continuation state and lost bot names. Names accumulate while nonqualifiers are pruned and are consumed on bot restoration. Ordinary matches retain no names (`null`). |
| `Room` | Room identity, actor capacity, viewer identities, activity, serialized mutation queue, and state-change callbacks. Room operations coordinate its match and membership changes. |
| `Host` | Registered rooms, runtime capabilities/policy, lifecycle scheduling, automation, and orchestration guards. It retains no duplicate bot roster. |
| `ConnectionRegistry` / `RoomMembership` | Transport memberships, Home subscriptions, and room indexes. Membership maps a tab to its current connection and optional actor name. |
| `HostConnection` / `RequestThrottle` | Connection resources/authentication and request-rate history, respectively. Neither stores match outcomes. |
| `HostRequest` / `HostRequestContext` | Validated command data and resolved references for one request only. |
| `Session` / `SessionState` | Client transport, reconnect resources, tab identity, sort preference, and persisted navigation state. `RoomSession` owns admission intent and reconnect admission history. |
| UI controllers | DOM references, latest display snapshots, selection, dialog transitions, and presentation timers. Results retain the displayed snapshot so later roster changes do not alter the result. |
| `server.js` | HTTP/WebSocket servers, socket adaptation, process maintenance, and shutdown resources. |

Room viewer identities and transport memberships serve distinct purposes: core counts room viewers without depending
on connections; the registry authenticates and routes those viewers. Host coordinates both during join, leave, and
elimination. Human players are never retained for automatic restoration; they remain viewers until they rejoin.

UI action guards are convenience checks against the latest snapshot. Core remains authoritative when a command arrives.

Changes belong to the layer that owns the concern:

- browser connection and reconnection behavior belongs in `ui/Session.js`;
- Hosted connection selection and probing belong in `ConnectionSession` in `ui/Session.js`;
- HTTP, WebSocket-server, and process-facing behavior belongs in `server.js`;
- connection and membership indexing belongs in `host/ConnectionRegistry.js`;
- authentication, command coordination, publication, and room cleanup belong in `Host.js`;
- card and match rules belong in `core/`;
- browser-safe response mapping belongs in `core/StateMapper.js`;
- page behavior and rendering belong in `ui/`.

The complete request, publication, reconnect, and teardown sequences are traced in [End-to-end flows](#53-end-to-end-flows).

`Host` MUST remain transport-neutral. It MUST NOT import browser globals, Node modules, Express, or WebSocket libraries.

## 4. Names and identity

Actor and room names are user-facing identifiers, not arbitrary strings. A valid name MUST:

- contain between 2 and 24 characters for an Actor, or between 2 and 48 characters for a Room;
- contain Unicode letters or numbers, with words separated only by spaces, apostrophes, curly apostrophes, or hyphens;
- have no leading or trailing whitespace;
- contain no symbols, control characters, repeated separator patterns, or separator-only content.

The accepted form is equivalent to:

```regex
^[\p{L}\p{N}]+(?:[ '\u2019-][\p{L}\p{N}]+)*$
```

Validation MUST occur at the user-facing boundary and again in the domain model. Normalized actor keys are lookup
identifiers and may be more tolerant than creation validation; a key MUST NOT be treated as proof that the original
display name was valid.

Actor names MUST be unique within a Room. Room capacity applies only to Actors, not Viewers.

## 5. Room lifecycle and membership

### 5.1 Commands

The public command set is defined by `Constants`:

| Area                     | Commands                                                 |
| ------------------------ | ------------------------------------------------------- |
| Directory and membership | `list`, `create`, `view`, `join`, `leave`               |
| Play                     | `start`, `draw`, `discard`, `pass`, `declare` |

The Host MUST validate the Room and Actor context for every command. A client-provided name, tab identifier, or room key
MUST NOT grant authority over another actor or Room.

### 5.2 Membership rules

- `list` returns the Home directory.
- `create` creates a Room and joins its first Actor.
- `view` opens an existing Room without taking a seat. A successful new viewer updates `Room.lastActiveAt`.
- `join` adds an Actor and removes that tab from the viewer set when applicable. Joining is allowed only while the Room
  is waiting or finished, according to the host profile and current lifecycle rules. Joining updates both the new
  Actor's activity and the Room's activity.
- `leave` removes the current actor and returns the client to Home.
- A Actor may move to viewing state. This updates Room activity and refreshes idle monitoring for the remaining
  eligible Actors.
- A Viewer may leave at any time. Removing a viewer updates Room activity only when a viewer was actually removed.

### 5.3 End-to-end flows

Every scenario below uses the same startup, command, and publication paths. Later subsections describe only what differs;
they do not restate this pipeline.

#### Canonical startup and command pipeline

1. `main.js` chooses `HomeSession`, `ConnectionSession`, or `RoomSession` from the page; each owns its page lifecycle.
2. `ConnectionSession` verifies a Hosted server on its own page. `Session.connect()` then selects the Host location: in Direct
   mode the browser runs `Session` and `Host` in-process; in Hosted mode Session uses WebSocket to reach `server.js` and `Host`.
3. `Host.accept()` creates a `HostConnection` in `ConnectionRegistry` and publishes the initial Home snapshot after startup.
4. `Session.request()` adds the tab identifier and current sort key. The selected transport delivers the request to
   `Host`, where `HostRequest` and `HostRequestContext` validate and resolve it, `RequestThrottle` throttles it, and `Host` dispatches it.
5. The handler authenticates the membership and invokes the relevant `Host` or `Room` operation. Room mutations are queued,
   update activity and monitoring as required, and call `Room.onAnyChange`.
6. `Host` uses `StateMapper` to create recipient-specific data and publishes it through `HostConnection`. The transport
   returns it to `Session`, which sends it to the page controller for a complete render.

Unless a subsection says otherwise, “send,” “publish,” and “render” refer to steps 4–6 of this pipeline.

#### Home and Room admission

`HomeSession` reads the preferred mode from `SessionState`. The standalone `ConnectionSession` discovers
and verifies its endpoint; `ConnectionController` renders the endpoint, attempt, probe duration, timeout, and failure
diagnostics. A successful WebSocket probe establishes availability, not game admission. When the client opens,
`HomeController` sends `list`, stores the advertised capabilities, and
renders the directory through `RoomRowUtils`. Before navigating, it validates form input and `HomeSession` stores the mode
and complete `create`, `view`, or `join` admission intent in `SessionState`.

`RoomSession` restores that intent, constructs `RoomController` and `FaqController`, and opens the shared client. An
unaccompanied initial Home snapshot is ignored on the Room page. On open, `RoomController` delegates to `RoomSession.openRoom()`, which sends its saved intent:

- `create`: `Host` validates admission, creates and registers the `Room`, attaches change and optional idle callbacks,
  joins the first human, and fills remaining seats with Bots when its `customBots` policy is `fill`. `ConnectionRegistry`
  records membership; the Host sends Room state and a welcome notification and refreshes the Home directory. After
  success, `RoomSession` persists `join` instead of `create` so reconnect cannot recreate the Room.
- `view`: `Room.view()` adds the tab as a Viewer and updates Room activity only for a new viewer. `ConnectionRegistry` then
  records viewer membership and the Host sends viewer-specific state.
- `join`: `Host` checks lifecycle, capacity, name uniqueness, and membership eligibility. `Room.joinActor()` creates the
  Actor, removes the tab from the viewer set, and updates activity. `ConnectionRegistry` upgrades the membership before the
  Host sends Actor-specific state and the welcome notification.

Room publications do not implicitly refresh Home subscribers. Room creation and closure explicitly broadcast the Home
directory.

#### Match and command lifecycle

For `start`, `Host` verifies seated membership and calls `Room.startMatch()`. The Room checks its state and minimum actor
count, resets match data, deals, selects the opening play and turn owner, changes to `active`, and publishes. A local
Actor's `waiting`-to-`active` render triggers the countdown described in [Dialog transitions](#dialog-transitions).

For `draw`, `pass`, `discard`, or `declare`, `Host.executeMatchCommand()` selects the corresponding Room operation. The
Room validates lifecycle, turn and pending-decision ownership, card ownership, and game rules before mutating. If the
next owner is a Bot, `Host` continues `Host.runAutomatedTurn()` through the same operations and publication pipeline
until human input or a pending decision is required.

When a match ends, the Room marks actors `WON` or `LOST`, changes to `finished`, stops turn monitoring, and publishes. It
remains finished until the next authenticated match command. `Host.executeMatchCommand()` then calls `Room.resumeWaiting()`, which
clears completed-match control metadata while preserving actors and collections, publishes the waiting state, and
applies the requested free transaction. With no later command, the final state remains observable.

#### Dialog transitions

All dialogs inherit display and dismissal behavior from `ViewController`; their controllers own content and cleanup.

| Dialog | Opens when | Closes or updates when |
| --- | --- | --- |
| Alert | A controller receives a normalized server or client notification. | Its dismiss button hides it. Admission failures and Room-closure notices are saved in `SessionState`, carried Home, and displayed there. |
| Countdown | A local Actor renders a `waiting`-to-`active` transition. | Its timer reaches zero or the Actor dismisses it. Viewers and other transitions do not open it. |
| Suit selection | The local Actor owns a pending `declare` decision. | Submission sends `declare`; any snapshot without that local pending decision hides it. Temporary dismissal schedules redisplay while it remains pending. |
| Results | A local Actor first renders a transition into `finished`. | Dismissal clears its rendered details. Later finished snapshots do not reopen it; a non-finished snapshot keeps it hidden. |

#### Idle Actor and empty-Room cleanup

The monitored human Actors are defined in [Who is monitored](#63-who-is-monitored). When an idle timer expires, `Host`
moves that Actor to viewing state, publishes the Room, and sends the affected client a warning. If no Actors remain,
`RoomLifecycle` schedules an empty-Room check for the grace interval; a later join cancels it.

When the check expires, `Host` verifies that the Room is still empty, detaches its callbacks, unregisters it, refreshes
the Home directory, and sends affected Room memberships a single response containing Home state and a `Room closed`
notification. `RoomSession` saves the warning, disconnects, and returns Home, where the alert flow displays it.

#### Departure and hosted reconnect

On `leave`, `RoomController` submits the command and asks `RoomSession` to clear the admission intent, disconnect,
and navigate Home while the canonical pipeline
removes the Viewer or Actor. `Room` recycles a departing Actor's hand when applicable and refreshes activity and idle
monitoring; `ConnectionRegistry` removes membership; `Host` applies Bot continuation or empty-Room cleanup and publishes to
remaining memberships. A transport closure performs the same server-side membership cleanup.

On a Hosted connection loss, `Session` reports status and performs bounded reconnect attempts without
changing authoritative Room state. A new socket produces a replacement `HostConnection`; the Home controller sends `list`, or
`RoomSession` resubmits its admission intent using the same tab identifier. `Host` and `ConnectionRegistry` replace stale connection ownership
and publish a fresh authoritative snapshot, which the controller renders completely before normal handling resumes.

### 5.4 Room states

- **waiting**: no active turn is required; `turnOwnerKey` is null. Seated Actors may perform the waiting-state commands
  allowed by the core rules.
- **active**: ordinary turn order and game legality apply. `pending` may describe a required game-specific decision
  without creating another lifecycle level.
- **finished**: the match has ended and actor collections provide final penalties. It remains observable until the next
  authenticated actor command resumes waiting or a new match starts.

State transitions MUST clear or establish the turn-owner cursor consistently. Starting a match establishes a valid
owner; resuming waiting after finished clears it.

## 6. Activity and idleness policy

### 6.1 Ownership of activity

`Actor` owns its idle timer. `recordActivity()` restarts that timer when monitoring is enabled; no unused actor
activity timestamp is retained.
`Room.lastActiveAt` measures activity for the Room and is used for room-level recency and empty-room cleanup.

`TurnOrder` MUST NOT track activity. Turn order is not activity, and adding timestamps to the circle would duplicate
ownership and create inconsistent state.

### 6.2 What updates activity

A successful Actor command MUST update both the acting Actor and the Room. This includes drawing, discarding,
passing, and declaring a suit. Starting a match or resuming waiting after finished also establishes fresh
activity for the relevant lifecycle.

Viewer activity MUST update only `Room.lastActiveAt`. A viewer becoming an Actor MUST update the new
Actor idle monitoring and `Room.lastActiveAt`. Joining, leaving a viewer, and moving an Actor to viewing state update
Room activity when the membership change actually occurs.

Failed commands MUST NOT be treated as successful Actor activity. Internal lifecycle transitions may refresh room activity and actor idle timers
when they establish a new monitoring window; they MUST NOT introduce a separate circle timestamp.

### 6.3 Who is monitored

Hosted idle monitoring uses `Constants.ROOM_WAIT_MS` (currently 30 seconds). Bots are never monitored because the host
advances automated turns promptly.

- While the Room is **active** and has a turn owner, only the current human turn owner is monitored.
- While the Room is **waiting**, every human Actor is monitored.
- Actors who are not eligible under the current state MUST have idle monitoring stopped.
- When the monitored set changes, each newly monitored Actor begins a fresh idle window. Advancing a turn therefore
  transfers the monitoring window to the new human owner.

An idle human Actor is demoted to viewing state, not silently deleted from the Room interaction. The affected client
MUST receive a warning notification. If the demotion leaves the Room with no Actors, the Host starts a grace-period
empty-room check for another `ROOM_WAIT_MS`.

When the empty-room check expires and the Room is still empty, the Host MUST close and unregister the Room. Direct mode
disables automatic idle monitoring; its lifecycle is owned by the browser page.

## 7. Game rules and match behavior

Starting requires at least two Actors. It creates and shuffles a deck, deals seven cards to each Actor, chooses a valid
initial discard, and selects the first turn owner. The turn owner may draw, discard, or pass only when the command is
legal for the current state.

While playing, turn order, draw penalties, discard legality, skip/reverse effects, and suit declarations are
authoritative core rules. A suit-changing ace moves the Room to pending until its owner declares a standard suit.

While waiting with no turn owner, the waiting-state permissions apply and playing-only legality checks do not. A match
finishes when a hand is emptied or the seven of hearts ends the match under its rule. Remaining hand penalties determine
the winner or tied winners.

`Room.js` defines `Room`, `Match`, and `Knockout` together. A Room retains membership, viewers, serialized card commands, activity, and publication; its current Match owns the turn order, collections, card transfers, pending decision, and ordinary result rules. `Knockout extends Match` and overrides elimination and next-match preparation. Room and UI access match state through `room.match`; transport snapshots nest those fields under `match`.

Start offers One match or Knockout once at least two Actors are seated. One match retains the existing single-match result. Knockout starts a series where a match that began with
three or more Actors marks every Actor tied for the highest remaining hand penalty as eliminated and the others as
qualified. The Host converts eliminated humans to Viewers and sidelines eliminated Bots until the Knockout ends. The Room
marks Actors `QUALIFIED` or `ELIMINATED`, retaining the finished `turnOrder` and its result metrics until the next match begins. At that start, the Room removes eliminated Actors from the order, and the Host demotes eliminated humans and sidelines eliminated Bots. A finished Knockout has no next match when fewer than two Actors qualified. The next match starts after `ROOM_WAIT_MS` (30 seconds), or any seated human can start it sooner
with Start. Idle monitoring continues while they wait. One survivor wins immediately, and no survivors means a tie. A match played one-on-one uses the ordinary
lowest-penalty winner or tie result, with no penalty elimination. If one Actor leaves an active Knockout one-on-one, the
other wins by forfeit. The results dialog reads the finished `turnOrder` directly; a departed Actor's metrics are no
longer available after that Actor leaves.

While waiting, an Actor may draw cards or discard cards from their hand. A card on the discard pile cannot be taken
directly back into a hand. Finished One Rooms expose the same controls; the first authenticated match command changes
the Room to waiting before applying the requested action. Waiting-state discards preserve card rotation and update
penalty and activity without applying playing-card effects. Active-match rules govern draws and discards while playing.

Hand sorting is committed with the next draw, discard, or pass. Temporary browser sorting is not a server-side
command for every selection. Drawing resets the temporary client sort to `none` so newly drawn cards are visibly distinct
until the Actor sorts again.

All ranks MUST use the shared card-rank policy in `Constants`; no UI or bot may calculate a competing rank.

## 8. Automated Actors

Bots use hard mode by default and follow the same legal command and card rules as human Actors.
Targeting is dynamic: legal cards and pending declarations determine which actors can receive the
next two turns under the current direction and actor count. The bot inspects those reachable hands,
represents other actors by identity and card count, and never inspects the draw collection.
A projected turn returning to the bot has no opponent target; it is scored as hand continuation.
With one opponent, both jack and eight return the turn to the bot, so no separate reverse or
skip opponent position is queried.

BotActor handles turn timing and submits commands. BotStrategy copies its decision information and
separates penalty shedding, opponent pressure, remaining-hand setup, and special-card conservation.
It checks actual projected opponents' cards for legal responses, attack defenses, and suit declarations, and
computes their remaining penalties when considering seven of hearts. For distant opponents it uses
CardOdds and an unknown-card pool reconstructed from the canonical deck minus its own hand, inspected
reachable opponent hands, and the live public play collection. No difficulty toggle is required.

CardCollection owns `getLegalCards`, `getSuitCounts`, and `getDominantSuit` as read-only queries.
BotStrategy calls these directly on copied collections; Actor provides no forwarding wrappers.
The dominant suit describes frequency, not a strategic decision; predicted declarations check its
safety before considering other suits.

The decision pipeline collects all rule-legal cards, maps each discard to its first and following
actors and draw allowance, then applies conservation and strategy scoring. Suit-changing candidates
carry their selected declaration through scoring; pending declarations use the same evaluation.
Suit choice prioritizes avoiding a next-actor or following-actor finish, then the most common held
suit. Equal counts favor held penalty and then unknown-card scarcity.

Finishing-risk checks include seven of hearts in a multi-card opponent hand. The bot compares
its penalty after the candidate discard with that opponent's penalty after seven of hearts; a
match-ending response has no projected following turn. Hand setup rewards the share of remaining
penalty kept playable, rather than only the number of connected cards.

Card selection first avoids giving the projected actor a playable final card. When every viable
choice allows an immediate opponent finish, it sheds the highest card penalty to improve its
remaining result and knockout qualification chances. Jack and eight targets follow actor-count
rules and the current turn direction.

Selection separates penalty shedding, draw defense, and opponent pressure scoring, with distinct
offensive and defensive priorities. Attack projects the first responding actor's
legal replies and the next actor's finishing opportunity. A forced penalty draw clears the allowance
but leaves the top discard in place, so an unprovoked joker can expose a following one-card actor.
If a safer play lets the intermediate actor block that finish, the bot keeps its attack card. If the
finish cannot be prevented by any available response, it prioritizes shedding penalty. Defense during
an active draw attack prioritizes legal counterattacks and shields without vetoing them for a later
finishing threat. Unknown newly drawn cards remain uncertain; the bot never inspects the draw pile.

Without an active draw attack, a Bot preserves its ace of spades and draws when it has no other legal card.
After drawing, it plays a legal non-ace option when available. If the ace of spades is its only legal option,
it releases that shield only when the next opponent in the current turn direction does not have exactly one card;
otherwise it passes and keeps the shield. This decision uses the opponent's visible hand count, never hidden cards.

Because discarded cards may return to the deck when the discard pile is recycled, bot decisions MUST use the live public
discard pile rather than a permanent assumption that a discarded card is unavailable.

Bot heuristics may estimate responses, urgency, suit strength, and the value of ending a match, but those estimates are
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
and preserve the notice as the single transition traced in [Idle Actor and empty-Room
cleanup](#idle-actor-and-empty-room-cleanup).

Home room summaries include `name`, `state`, `actorLimit`, `viewers`, `lastActiveAt`, and `createdAt`. Room data adds
`localActorName` and `match` with its turn order, public collections, and pending decision state. Winner status comes from each Actor's state. `match.turnOrder.actorCount` is the
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
- Viewers do not receive Actor-only start or result overlays.
- When a local Actor exists, displayed Actor sequences begin with that Actor while preserving circle order.
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
| Discard pile, spectators, FAQ, fan, results           | None         | None             |

Awaiting-decision and transport-busy states disable interaction. A suit-only declared-suit display always remains
static. Discard-pile cards are display-only in every match state.

### 12.1 Element properties and markup

The element's `value` and `suit` getters read its presentation attributes. Supplied rank is retained in `data-rank`
for card-update comparison. The `rotation` and `isFaceUp`
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

`RoomController` routes a hand drop to `discard` through the command flow in section 5.3, including its
finished-to-waiting transition. The discard pile has no drag destination back to a hand.

## 13. Testing and verification

Run `npm test` before completing a change. Use `npm run test:coverage` when reviewing branch coverage. Focused tests
belong at the lowest stable layer:

- `card.test.js`: constants, scoring, and card rules;
- `card-collections.test.js` and `collections.test.js`: deck, hand, sorting, serialization, and TurnOrder behavior;
- `infrastructure.test.js`: serialization, state mapping, and throttling;
- `room.test.js`: membership, lifecycle, activity, idle monitoring, game flow, and bot choices;
- `user-notification.test.js`: expected versus developmental error handling;
- `local-game.test.js` and `connection.test.js`: page structure, routing, transport, and deployment-facing
  contracts.

Any change to activity policy MUST test Actor and Room timestamps, monitored human selection by lifecycle state, bot
exclusion, demotion notification, and empty-room closure. Any change to common markup or CSS MUST be checked against the
root `index.html` Home and `room.html`, including the mobile and 721px presentations.

Every application class, class field, method, getter, setter, and named function MUST have adjacent JSDoc. Public and
extension APIs document their behavioral contract, parameters, return value, and important failures where applicable.
Private declarations may use a concise purpose statement; private fields include a useful `@type`. Test callbacks and
ordinary local variables are not APIs and do not require JSDoc. The architecture test enforces declaration coverage.

## 14. Extension rules

1. Keep timing, protocol, item identities, rules, and scoring in the appropriate core modules.
2. Use `CardCollection` for every card-storage role and add specialized behavior only when Pick 2 needs it.
3. Map match state in `StateMapper`; `Host` constructs rooms and coordinates commands and automated turns directly.
4. Validate Room, Actor, Viewer, and ownership context in the Host before dispatching a command.
5. Reuse existing controller, template, validation, notification, sorting, and DOM-state patterns.
6. Preserve semantic markup, `data-*` state hooks, accessibility relationships, and the repository's CSS cascade
   standards.
7. Add tests for valid behavior, expected user failures, and important internal contract failures.
8. Update this document, the README, and the in-page FAQ whenever public behavior, policy, or operational behavior
   changes.

The collapsed Home guide, About Pick 2 & rooms, sits immediately above `home-directory` and introduces the game and covers the steps before entering a room: connection modes, creating or joining a room, and watching live rooms. The in-room FAQ takes over with seating, match setup, playing, special cards, scoring, and Knockout. Both share the same nested `details` structure and `ui/styles/faq.css`, and contain their content in HTML, so they can be expanded without JavaScript or a connection. Home has canonical search metadata and appears in `sitemap.xml`; dynamic Room and Connection pages remain excluded from indexing.

## 15. Operations

- Default Node port: `8080`; override with `PORT`.
- Health endpoint: `GET /health`.
- Node serves Pick 2 Home at `/` and active rooms at `/room.html`. The same relative links work below a static host's
  subdirectory.
- Room exit and failed admission return to Pick 2 Home.
- Graceful shutdown handles `SIGINT` and `SIGTERM` and closes connections.
- Uncaught exceptions and unhandled promise rejections are logged and trigger server shutdown because Host
  state may be unsafe.
- The application is proprietary; see the README copyright and license notice.
