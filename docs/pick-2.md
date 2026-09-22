# Pick 2 Software Design and Maintenance Guide

## 1. Purpose and authority

This document defines the observable behavior, architecture, contracts, and maintenance rules for Pick 2. It is written
for maintainers and contributors: it explains what the software must do and where a policy belongs without describing
every private implementation detail.

The document is normative where it uses **MUST**, **MUST NOT**, **SHOULD**, or **MAY**. When behavior changes, update
this document, the README, the in-page guide, and focused tests in the same change.

Pick 2 has Direct and Hosted modes. Both modes expose the same Home and Room experiences, commands, core rules, response
envelope, client data shape, and in-memory storage model. Their transport and configured Host policies differ.

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

| Runtime file | Responsibility |
| --- | --- |
| `runtime/Client.js` | Adds tab and sort context, validates responses, and notifies controllers. |
| `runtime/Command.js` | Validates requests, carries resolved command context, and dispatches commands. |
| `runtime/Transport.js` | Defines the peer channel and the direct and WebSocket endpoint implementations. |
| `runtime/BrowserRuntime.js` | Composes a browser-owned in-memory Host and direct Endpoint. |
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

The sequences below name every class that owns a step. Utility classes are named where they validate, map, persist, or
render data; the browser and WebSocket APIs are mentioned only at the boundary where a project class calls them.

#### Shared browser and transport startup

1. `main.js` reads `document.body.dataset.page` and constructs either `HomeView(roomUrl)` or `RoomView(homeUrl)`.
2. `main.js` calls `View.start()` on that concrete view. `HomeView.start()` and `RoomView.start()` create their own page
   controllers and bind their page-specific handlers; the base `View` supplies the shared client creation behavior.
3. `View.createClient(mode)` chooses only the transport. In direct mode it constructs `BrowserRuntime(new Game())` and
   uses the runtime's `Endpoint`. In hosted mode it constructs `WebSocketEndpoint` with the URL stored by `ViewState`.
   Both paths then construct the same `Client`, so controllers do not branch on transport type.
4. `Client.open()` supplies `EndpointEvents` to the selected endpoint. In direct mode `Endpoint` creates a `Connection`,
   while `BrowserRuntime` has already connected its in-memory `Host` through a `PeerChannel`. In hosted mode
   `WebSocketEndpoint` creates a `WebSocketConnection`; the server-side `WebSocketGateway` converts the accepted socket
   to a `PeerChannel` and passes that channel to `Host.accept()`.
5. `Host.accept()` creates a `PeerSession` in `SessionRegistry`, registers the peer for Home publication, and sends an
   initial Home snapshot after the Host is ready.
6. For every later request, `Client.request()` adds the browser tab identifier and the current sort key. `Connection`
   clones and forwards the request in direct mode; `WebSocketConnection` serializes it and `WebSocketGateway` parses it
   in hosted mode. Both arrive at the same `Host` peer receiver.
7. `Host` waits for readiness, `HostRequest.parse()` normalizes the request, `CommandContext` supplies request/session
   context, `RateLimit` applies connection-level limits, and `CommandRouter` dispatches the command to its `Host`
   handler.
8. For every Room response, `StateMapper` converts the authoritative `Room` to recipient-specific data, `PeerSession`
   publishes it, the selected transport carries it, and `Client` passes it to `RoomController.handleData()`.
   `RoomController.render()` then updates the page and its child controllers.

#### Loading Home and choosing a Room

1. `HomeView.start()` constructs `HomeController` and `NetworkConnectionController`, initializes both, binds navigation
   and registration handlers, and calls its connection routine.
2. `HomeView` obtains the preferred mode from `ViewState`. For Direct it immediately asks `View` for a `Client`. For
   Hosted it first asks `NetworkConnectionController` to discover and verify the endpoint, stores that URL in
   `ViewState`, and then asks `View` for the Client.
3. `HomeView` gives the selected Client to `HomeController` and calls `Client.open()` with controller callbacks. Hosted
   status and data callbacks keep `NetworkConnectionController` visible until Home data arrives; Direct shows Home
   immediately.
4. When the endpoint opens, `Client` calls `HomeController.handleClientOpen()`, which requests `list`.
5. `Host` routes `list`, obtains its registered rooms, and publishes the Home state through `PeerSession`.
6. `Client` calls `HomeController.handleData()`. `HomeController` stores the advertised capabilities and uses
   `RoomRowUtils` to render each available Room.
7. When the user submits the create form, `HomeController` uses `ValidationUtils` to validate and normalize the entered
   values before invoking the handler registered by `HomeView`.
8. When the user creates, joins, or views a Room, `HomeView` stores the selected mode and a complete admission intent in
   `ViewState`, constructs the Room URL, and asks the browser to navigate to it.

#### Creating a Room and entering as its first Player

1. `main.js` constructs `RoomView`; its constructor reads the admission intent from `ViewState`. If the URL names a Room
   but no saved intent exists, `RoomView` creates a view intent for that Room.
2. `RoomView.start()` constructs and initializes `RoomController`, creates the shared `Client`, and opens it with that
   controller's `ClientEvents`. It then gives `RoomController` the Client and admission intent and registers ready/Home
   callbacks. Finally it constructs and initializes `GuideController` and registers page-hide disconnection. Direct
   endpoint readiness is queued as a microtask, and Hosted readiness is asynchronous, so these bindings complete before
   `Client` announces open.
3. The initial unaccompanied Home snapshot sent by `Host.accept()` may reach `RoomController`; `handleData()` ignores it
   because the Room is neither leaving nor processing a Home-bound notification.
4. On transport open, `Client` calls `RoomController.handleClientOpen()`. `RoomController` sends the saved `create`
   request through `Client.request()`.
5. The request follows the shared transport path to `Host`. `Host` validates and normalizes the Room and Player data,
   applies admission throttling, and asks the configured `Game` factory to create a `Room`.
6. `Host` registers the new `Room` and attaches `Room.onAnyChange` and, when configured, `Room.onActorIdle`.
   `RoomLifecycle` remains available to `Host` for a later empty-Room timer; registration itself does not start one.
7. `Host` calls `Room.joinActor()`. `Room` creates the human `Actor`, removes the tab from its viewer set if necessary,
   records actor and room activity, and notifies its change listener.
8. When `HostOptions.customBots` is configured as `fill`, `Host` fills the remaining configured seats by calling
   `Room.joinActor()` with automated membership. `Room` constructs each `BotActor` and adds it through the same Room
   membership operation.
9. `SessionRegistry` associates the requesting `PeerSession` and tab with the Room and Player. `Host` then publishes the
   recipient-specific Room state, sends the Player welcome notification, and broadcasts the changed Home directory.
10. `Client` sends the state to `RoomController.handleData()`. `RoomController` stores the snapshot and calls
   `RoomController.render()`; `RoomRowUtils` renders Room metadata and participants, while `LocalPlayerController`
   renders the local hand and available controls.
11. `RoomController` invokes its ready handler. `RoomView` changes a successful saved `create` intent to `join` and
    persists it through `ViewState`, so a reconnect requests the existing seat rather than creating the Room again.

#### Viewing an existing Room and then joining it

1. `RoomView` and `RoomController` repeat the Room-page startup above, but `RoomController.handleClientOpen()` sends
   `view` with the Room key.
2. `Host` resolves the Room and session through `CommandContext`, then calls `Room.view()`.
3. `Room` registers the tab as a Viewer, updates `Room.lastActiveAt` only when it is new, and invokes `onAnyChange` so
   `Host` refreshes existing Room sessions before admitting the new one.
4. `SessionRegistry` records the viewer membership. `Host`, `StateMapper`, `PeerSession`, the selected transport,
   `Client`, and `RoomController` deliver and render the viewer-specific Room snapshot in that order.
5. When the Viewer submits a Player name, `RoomController` validates the input and sends `join` through `Client`.
6. `Host` verifies that the Room exists, membership is open, a seat is available, the name is valid and unique, and the
   session is allowed to join. It then calls `Room.joinActor()`.
7. `Room` creates the `Actor`, removes the same tab from its viewer set, updates actor and Room activity, and invokes
   `Room.onAnyChange`; `Host` first refreshes sessions using their membership as it exists at that instant.
8. `SessionRegistry` then upgrades the requesting session from Viewer to Player. `Host` publishes that session's
   Player-specific Room state and sends its welcome notification. Home subscribers are not part of the Room-state
   publication; their directory is refreshed by explicit Home broadcasts such as Room creation or closure.
9. `Client` gives the state to `RoomController`; `RoomController.render()` now supplies the local actor to
   `LocalPlayerController`, which replaces viewer controls with the Player's hand and permitted actions.

#### Starting a round and completing an ordinary turn

1. The start control invokes the handler bound by `RoomController`, which calls `Client.request("start")`.
2. The request traverses the selected connection, `HostRequest`, `CommandContext`, `RateLimit`, and `CommandRouter` to
   the start handler on `Host`.
3. `Host` authenticates that the requester is a seated Player in the Room, then asks `Room.startRound()` to start.
4. `Room` checks its state and minimum actor count, resets round-only data, shuffles and deals through its game
   operations, chooses the opening play and turn owner, changes to `active`, records activity, and refreshes idle
   monitoring.
5. `Room` invokes `onAnyChange`; `Host` maps and broadcasts a separate authoritative snapshot for every Room session.
6. Each `Client` passes its snapshot to `RoomController.render()`. `RoomController` renders the Room, discard pile,
   actors, and local controls through `RoomRowUtils` and `LocalPlayerController`; the waiting-to-active transition also
   follows the countdown-dialog flow below.
7. A draw or pass control in `LocalPlayerController`, a dropped hand card handled by `RoomController`, or a returned
   discard card handled by `RoomController` reaches `RoomController`'s player-command/card-move handler.
8. `RoomController` calls `Client.request()` with `draw`, `pass`, `discard`, or `return`, clears any temporary client-side
   sort state for a card move, and immediately rerenders the pending local presentation.
9. `Host` authenticates and throttles the actor command, then calls `Game.execute()`.
10. `Game.execute()` selects the corresponding Room operation: `Room.drawItems()`, `Room.passTurn()`,
    `Room.playItem()`, `Room.returnItem()`, or `Room.declareSuit()`.
11. `Room` queues the operation, validates state, turn ownership, pending decisions, card ownership, and game rules;
    mutates cards and actor state; records actor and Room activity; advances the turn when required; refreshes idle
    monitoring; and invokes `onAnyChange`.
12. `Host`, `StateMapper`, `PeerSession`, the selected transport, `Client`, and `RoomController` broadcast and render the
    resulting state in that order.
13. If the next owner is a Bot, `Host` continues the automated turn. `Game.runAutomatedTurn()` asks `BotActor` to choose
    and take its action, the same `Room` operations apply it, and the same publication chain repeats until a human input
    or pending decision is required.

#### Finishing a round and allowing the next transaction

1. When a Room operation detects the round-ending condition, `Room` marks the winning and losing actors, changes its
   state to `finished`, stops active-turn monitoring, records the mutation, and invokes `onAnyChange`.
2. `Host`, `StateMapper`, `PeerSession`, the transport, and `Client` deliver the finished snapshot to
   `RoomController`; `RoomController` renders the finished board before evaluating dialog transitions.
3. `RoomController` compares its previous state with the new state. A transition into `finished` for a Player invokes
   `ResultsController.show()` as described below. The Room remains `finished`; neither `Host` nor `RoomController`
   immediately resets it.
4. The finished-state controls remain available for a free card transaction. When an actor next requests a game
   command, the request reaches `Game.execute()` through the normal command path.
5. `Game.execute()` sees `Room.state === finished` and first awaits `Room.resumeWaiting()`. `Room` changes from
   `finished` to `waiting`, clears completed-round control metadata (`pending`, declared suit, and turn owner), and
   preserves actors, hands, deck, and discard pile for the requested free transaction. `Room.resumeWaiting()` invokes
   `onAnyChange`, so `Host` publishes this waiting snapshot and `RoomController` hides the results dialog.
6. `Game.execute()` then invokes the requested Room operation. Waiting-state play rules no longer restrict the free
   transaction. The operation performs a second `onAnyChange` publication through `Host` → `StateMapper` →
   `PeerSession` → transport → `Client` → `RoomController`, now containing the transaction result.
7. If no actor sends a command, step 5 never runs, so the Room state and final result data stay `finished`.

#### Dialog display and dismissal flows

##### Alert dialog

1. `Host` produces a user notification for a rejected request, warning, welcome, idle action, or Room closure and sends
   it through `PeerSession`; client-side validation and invite-copy outcomes may instead originate in `HomeController` or
   `RoomController` without a Host round trip.
2. For a notification-only response, `Client` calls `HomeController.handleNotification()` or
   `RoomController.handleNotification()`. For a combined Home-state and notification response, `Client` passes both to
   `RoomController.handleData()` so navigation and the notice remain one transition.
3. The receiving controller calls `NotificationUtils.normalize()` and passes the normalized notification to its own
   `AlertController`.
4. `AlertController.show()` writes the status, icon, title, and message into `#alert-dialog`, then uses inherited
   `ViewController.show()` behavior to display it.
5. `AlertController` has already used `ViewController.bindDismissButton()` to bind `#alert-ok-button`; clicking it calls
   the inherited hide behavior and closes the dialog.
6. If `RoomController` receives an admission failure or Room-closure notification before it has a usable Room snapshot,
   it invokes the Home callback instead of displaying the alert in place. `RoomView` stores the notice with `ViewState`,
   clears the Room intent, disconnects the `Client`, and navigates Home. `HomeView` takes the saved notice from
   `ViewState`, passes it to `HomeController`, and `HomeController` follows steps 3–5 to display the alert there.

##### Round countdown dialog

1. After every Room snapshot, `RoomController.render()` compares its stored previous state with the incoming state.
2. Only a local Player transition from `waiting` to `active` calls `CountdownController.show()`; a Viewer does not see
   it, and a direct `finished`-to-`active` transition does not satisfy this condition.
3. `CountdownController.show()` normalizes the configured countdown duration, cancels any older timer, renders the
   remaining value, uses `ViewController.show()` to display the dialog, and starts its interval.
4. `CountdownController` rerenders once per second. At zero it calls `hide()`, which stops the interval and uses the
   inherited hide behavior. Its bound OK button can invoke the same `hide()` path early.

##### Suit-selection dialog

1. `Room.playItem()` recognizes a suit-changing card and stores a pending `declare` decision with its owning actor,
   leaving the Room `active`.
2. `Room.onAnyChange`, `Host`, and `StateMapper` include that pending decision in each permitted snapshot; the normal
   publication chain delivers it to `RoomController`.
3. `RoomController.render()` shows `SuitSelectionController` only when the pending command is `declare` and the local
   Player owns that decision. Every other snapshot causes it to call `SuitSelectionController.hide()`.
4. `SuitSelectionController.show()` renders and displays the dialog through `ViewController`. A temporary-dismiss
   control hides it and schedules it to reappear after the configured countdown period while the decision remains local.
5. On submission, `SuitSelectionController` reads the checked suit, hides itself, and invokes the handler registered by
   `RoomController`.
6. `RoomController` sends `declare` through `Client`; `Host` authenticates it, `Game.execute()` calls
   `Room.declareSuit()`, and `Room` verifies the pending owner, applies the suit, clears `Room.pending`, and publishes.
7. The next snapshot reaches `RoomController.render()` with no pending declaration, so it keeps
   `SuitSelectionController` hidden. `SuitSelectionController.hide()` also clears any scheduled redisplay timer.

##### Results dialog

1. The finished snapshot reaches `RoomController.render()` through the finish flow above.
2. If a local Player exists, the previous state was not `finished`, and the new state is `finished`, `RoomController`
   calls `ResultsController.show(room)` exactly once for that transition. Viewers do not satisfy the local-Player check.
3. `ResultsController` orders actors with the local Player first, derives the win/loss message and statistics, renders
   the actor rows, and invokes inherited `ViewController.show()` to display the dialog.
4. Selecting an actor row by pointer or keyboard asks `ResultsController` to render that actor's cards in the results
   detail area.
5. `ViewController.bindDismissButton()` connects the results-dismiss control to `ResultsController.hide()`.
   `ResultsController.hide()` clears its actor list, statistics, and cards before invoking the inherited hide behavior.
6. Another snapshot that is still `finished` does not reopen the dialog because `RoomController` has already recorded
   `finished` as its previous state. A later actor command changes the Room to `waiting` as described above, and
   `RoomController.render()` keeps the results dialog hidden for the non-finished state.

#### Idle Player and empty-Room cleanup

1. Each `Room` mutation calls its idle-monitor refresh. `Room` selects only the eligible human Player defined by the
   activity policy and arms that Actor's idle timer; state or turn-owner changes transfer or cancel monitoring.
2. When the timer expires, `Room` invokes `Room.onActorIdle`. `Host` installed that callback when it registered the Room,
   so `Host` identifies the Player session and asks the Room to move the Player to viewing state.
3. `Room` updates membership and Room activity, refreshes monitoring, and invokes `onAnyChange`. `Host` publishes the new
   snapshot and sends the affected client an idle warning through `PeerSession`.
4. `Client` routes the snapshot to `RoomController.render()` and the warning to `RoomController.handleNotification()`;
   the latter displays it through `NotificationUtils` and `AlertController`.
5. If no Players remain, `Host` asks `RoomLifecycle` to retain the empty Room for its grace interval and schedule an
   empty-Room check.
6. If a Player joins before that check, `Host` cancels the Room's timer in `RoomLifecycle`, so the Room remains
   registered.
7. If the timer expires, `RoomLifecycle` invokes the callback registered by `Host`. `Host` checks the Room again and,
   only if it is still empty, detaches the Room callbacks, unregisters and removes the Room, broadcasts the changed Home
   directory, and sends affected Room sessions Home state plus a `Room closed` notification.
8. `Client` passes that response to `RoomController`; `RoomController` invokes its Home callback, and `RoomView` stores
   the warning in `ViewState`, disconnects, and navigates Home. `HomeView`, `HomeController`, and `AlertController` then
   display the warning by the alert flow above.

#### Leaving and returning Home

1. A Player or Viewer activates the leave control bound by `RoomController`.
2. `RoomController` requests `leave` through `Client` and invokes the Home callback; `RoomView` clears the saved intent,
   disconnects the client, and navigates Home.
3. Independently, the request follows the normal transport and routing chain to `Host`. `Host` resolves the session and
   calls the appropriate Room departure operation.
4. `Room` removes the Viewer or Player, recycles a departing Player's hand when applicable, updates Room activity,
   refreshes idle monitoring, and invokes `onAnyChange`.
5. `SessionRegistry` removes the Room membership. `Host` continues an eligible Bot turn or applies empty-Room cleanup,
   then publishes the updated Room to remaining Room sessions. It broadcasts Home state if cleanup closes the Room.
6. A transport closure follows the server half of the same flow: `Connection` or `WebSocketGateway` informs `Host`, and
   `Host` removes that peer's membership through `SessionRegistry` and `Room` before applying Bot/cleanup behavior.
7. On the new page, `main.js`, `HomeView`, `Client`, and `HomeController` execute the Home-loading flow and render the
   current directory.

#### Hosted reconnect

1. `WebSocketConnection` detects closure, reports connection status through `EndpointEvents`, and schedules its bounded
   reconnect attempts. `Client` forwards status to `NetworkConnectionController`, which updates the connection display
   without changing authoritative Room state.
2. When a new socket opens, `WebSocketGateway` creates a new `PeerChannel` and calls `Host.accept()`; `Host` creates the
   replacement `PeerSession`.
3. `WebSocketConnection` reports open to `Client`, and `Client` again calls `RoomController.handleClientOpen()` (or
   `HomeController.handleClientOpen()` on Home).
4. `HomeController` requests a fresh `list`. `RoomController` resends its saved admission intent; after an initial create,
   `RoomView` has persisted that intent as `join`, and `RoomController` also avoids repeating `create` on a later open.
5. `Client` reuses the tab identifier kept for the browser tab. `Host` and `SessionRegistry` use it to replace stale peer
   ownership and restore the permitted Room membership rather than trusting the browser's old snapshot.
6. `Host`, `StateMapper`, and `PeerSession` publish fresh authoritative state through the new connection. `Client` passes
   it to the page controller, which completely rerenders from that snapshot; normal command handling resumes only over
   the re-established endpoint.

### 5.4 Room states

- **waiting**: no active turn is required; `turnOwnerKey` is null. Seated Players may perform the waiting-state commands
  allowed by the core rules.
- **active**: ordinary turn order and game legality apply. `pending` may describe a required game-specific decision
  without creating another lifecycle level.
- **finished**: the round has ended and actor collections provide final scores. It remains observable until the next
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
finishes when a hand is emptied or the seven of hearts ends the round under its rule. Remaining hand scores determine
the winner or tied winners.

While waiting, a Player may move cards freely in either direction between their hand and the discard pile, subject to
membership and card-presence validation inside the Room operation queue. Finished Rooms expose the same controls; the
first authenticated game command changes the Room to waiting before applying the requested transaction. These free
transactions preserve card rotation, update score and activity, and do not consume draw allowance or apply playing-card
effects. They are rejected while the Room is active unless the active-round rules specifically permit the command.

Hand sorting is committed with the next draw, discard, return, or pass. Temporary browser sorting is not a server-side
command for every selection. Drawing resets the temporary client sort to `none` so newly drawn cards are visibly distinct
until the Player sorts again.

All scoring MUST use the shared card-score policy in `Constants`; no UI or bot may calculate a competing score.

## 8. Automated Players

Bots use the same legal command and card rules as human Players. Their strategy MAY use their own cards, public turn
order, visible hand counts, card effects, and discard history. It MUST NOT inspect opponents' hidden card identities or
private hand scores.

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
| Local hand while waiting or finished                  | Discard pile | Flip and drag    |
| Local hand during an allowed playing turn             | Discard pile | Flip and drag    |
| Discard pile while waiting or finished, with a Player | Local hand   | Flip and drag    |
| Other discard states, spectators, guide, fan, results | None         | None             |

Awaiting-decision and transport-busy states disable interaction. A suit-only declared-suit display always remains
static. Waiting or finished Players may take any real card in the discard pile into their own hand; this is not
restricted to their own earlier discards.

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
8. Update this document, the README, and the in-page guide whenever public behavior, policy, or operational behavior
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
