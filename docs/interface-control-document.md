# Pick 2 — Interface Control Document

| Document ID | Revision | Software baseline |
| --- | --- | --- |
| P2-ICD | 2.1 | 2026-11-12; package version 1.0.0, working tree |

## 1. Introduction

This document defines the external and browser interfaces realizing P2-SRS
P2-NFR-001–003 and P2-DC-002–003. It owns wire fields, status/close codes,
authentication, and resource-policy tables. Runtime ownership belongs to
[P2-SDD](software-design-description.md); installation belongs to
[P2-OM](operations-and-maintenance.md). Terms and reference conventions follow
[P2-DOC](README.md). All paths are relative to the configured Hosted server origin.

## 2. Connection and session admission

### 2.1 Upgrade and first frame

Upgrade the exact `/live` path without query parameters. The browser must supply
an explicitly allowed Origin. Remote deployments use HTTPS/WSS. The public config
stores an HTTP(S) deployment origin; HostedClient selects WS/WSS and `/live` from it.
HTTP serves assets, `config.js`, and plain-text `GET /health` (`OK`) only. Former
`/api` routes return 404. Health availability does not prove socket or game admission.

Within five seconds of upgrade, send one JSON text frame:

```json
{ "type": "create" }
```

This creates a bounded in-memory session with a random 256-bit base64url credential
and server-generated tab identity. The server responds before event delivery:

```json
{ "type": "ready", "service": "pick-2", "version": 2, "token": "<43-character-token>" }
```

The credential is private to this socket recipient. Keep it in memory; never put it
in URLs, subprotocol labels, cookies, browser storage, logs, or public snapshots.
The browser validates service, protocol version, and token shape before opening the
page's command flow. The handshake is the connection check; no HTTP preflight exists.

### 2.2 Authenticated reconnect and departure

To resume a retained session, use this first frame instead of `create`:

```json
{ "type": "authenticate", "token": "<token>", "after": 7 }
```

`after` is the last delivered event sequence, expressed as a nonnegative safe integer.
The server sends the same ready-frame shape and replays events after that cursor.
A retained session does not repeat room admission. One current socket owns the
session; late close/release from a replaced socket cannot affect its replacement.
Invalid/unavailable cursors retire that credential. Expired/unknown credentials
require a new session and normal room admission.

An authenticated `{ "type": "release" }` explicitly ends the session and membership.
HostedClient sends this best effort before closing on page departure or mode change.
Abrupt socket loss merely detaches the stream; retained membership expires under §5.
Release is not the `leave` command: Leave returns Home within the same session.

## 3. Commands, events, and recovery

### 3.1 Event delivery and acknowledgements

```json
{
  "type": "event",
  "sequence": 1,
  "response": { "view": "home", "message": null, "data": { "rooms": [] } }
}
```

The example illustrates the envelope; complete Home metadata is in §4. Deliver
consecutive events, then acknowledge with `{ "type": "acknowledge", "after": 1 }`.
Acknowledgement releases retained events. Reconnect replay uses the same sequence;
there is no separate HTTP directory response to reorder against pushed events.
Retention is bounded by both event count and bytes (§5).

### 3.2 Room and gameplay commands

All commands use `{ "command": "<name>", "data": {} }` on the authenticated socket.
Client-provided `tabId` never selects authority; the gateway overwrites it with the
session's server-owned identity before Host validates membership and game legality.

| Command | `data` fields |
| --- | --- |
| `list` | Empty object; Home directory, valid outside room membership |
| `create` | `roomName`, `playerName`, `playerLimit` |
| `join` | `roomName`, `playerName` |
| `view` | `roomName` |
| `leave` | Empty object; leave current membership and publish Home |
| `start` | `roomName`; `knockout: true`, `false`, or omitted for continuation |
| `draw` | `roomName`, optional `sortKey` |
| `discard` | `roomName`, `card: { value, suit }`, optional `sortKey` |
| `pass` | `roomName`, optional `sortKey` |
| `declare` | `roomName`, `suit` |

```json
{
  "command": "discard",
  "data": { "roomName": "Example Room", "card": { "value": "5", "suit": "hearts" }, "sortKey": "none" }
}
```

`sortKey` is `none`, `rank`, or `suit`; declared suits are clubs, diamonds, hearts,
and spades. `shared/HostedProtocol.js` owns the path, handshake version/deadline,
and complete command set. Sending successfully is not proof of a completed mutation;
Host's event/notification carries its authoritative outcome. Expected user failures
remain actionable notifications. Commands are never automatically resent after an
uncertain connection loss.

### 3.3 Rejections and recovery

| Code | Meaning / client behavior |
| --- | --- |
| HTTP 403 | Upgrade has missing, opaque, or unlisted Origin |
| HTTP 404 | Wrong upgrade path, including query parameters |
| HTTP 429/503 | Upgrade rate/IP/global capacity or shutdown refusal |
| 1003 | Binary frame rejected; JSON text required |
| 1007 | Malformed JSON rejected |
| 1008 | First-frame deadline, invalid command shape, or command/message policy failure |
| 1009 | Oversized incoming message |
| 1011 | Unexpected admission failure; public reason excludes internal details |
| 1013 | Session capacity, creation-rate, IP limit, or session-owner shutdown refusal |
| 4000 | Current stream replaced by another authenticated socket |
| 4001 | Credential rejected, expired, released, or replay budget exhausted; create/readmit |
| 4009 | Invalid/unavailable cursor; old credential retired, create/readmit |

A normal page retries after 1, 2, 4, 8, and 16 seconds, retaining token and cursor
across ordinary network loss. Protocol failures have a separate budget of five
retries per explicit client start; successful ready frames cannot reset it. Repeated
invalid frames or cursor rejections use increasing backoff and then manual recovery,
even if authentication succeeds between failures. Each opening/authentication attempt has a five-second
deadline. Exhaustion clears saved room intent and opens Connection for manual Retry
Live or Local selection. Connection's manual check uses the same HostedClient with
automatic retries disabled; it releases its temporary session on success before
returning Home. It never probes HTTP or silently selects Local.

Page callback failures are logged separately and do not trigger credential recovery.
Heartbeats extend transport liveness, not game activity. No saved-game recovery exists
after the owning process exits. Protocol version 2 and `/live` require coordinated
frontend/backend deployment; there is no compatibility REST adapter.

## 4. Public data and notification interface

### 4.1 Envelope and directory

| Record | Fields and meaning |
| --- | --- |
| Envelope | `view: "home" \| "room" \| null`, `message: Notification \| null`, `data: object \| null` |
| Notification | `status: "success" \| "error" \| "warning" \| "info"`, `title: string`, `message: string` |
| Home | `rooms: RoomSummary[]`, `connectionMode`, `capabilities` |
| RoomSummary | `name`, `playerLimit`, viewer count, `createdAt`/`lastActiveAt` ISO timestamps, nested `match` summary |
| Match summary | `state`, `isKnockout`, `turnOrder.playerCount` |
| Capabilities | Boolean `create`, `join`, `view`, `invite`, `botFill`, `restart` |

A response containing both state and message shall preserve both. Room closure
uses one Home envelope plus its warning, carried across navigation. Empty message
text is hidden. Successful Start uses its countdown rather than an extra success alert;
action notifications otherwise target the initiator, and directory refreshes do not
produce success alerts. Notification wording is defined by Constants.

### 4.2 Detailed room and privacy

| Record | Fields and redaction |
| --- | --- |
| Room data | Room summary, `localPlayerName`, complete public `match`; Host adds connection metadata and `isBusy` |
| Match | `state`, `turnOrder`, `collections`, `isKnockout`, `isKnockoutComplete`, `nextMatchAvailable`, `pending`, `declaredSuit` |
| TurnOrder | Ordered `players`, `playerCount`, nullable `ownerKey`, `direction`; no activity timestamps |
| Player | `key`, `name`, `state`, `drawAllowance`, `collection` |
| Player collection | `items`, public `itemCount`, `penalty` |
| Collections | `play.items` for public discards; `draw.itemCount` only |
| Card | `value`, `suit`, `rank`, `rotation` |
| Declared-suit marker | Suit and zero rotation only; not a deck card |

During waiting/active play, only the seated recipient receives their hand and
penalty. All other hands have `items: []`, their real count, and `penalty: null`.
Viewers receive no private hands. Finished snapshots reveal seated hands/penalties;
continuation hides them again. The draw deck never exposes cards. Winner status
comes from Player state, and occupied seats from `match.turnOrder.playerCount`.
StateMapper applies this boundary before cloning, retention, or network delivery.

## 5. Deployment policies and resource bounds

### 5.1 Origin and proxy policy

`WS_ALLOWED_ORIGINS` replaces the exact comma-separated allowlist for live upgrades. Defaults permit `https://danieltongu.github.io` and HTTP localhost,
loopback, and current IPv4 LAN addresses at the listening port. Origins contain only
scheme, hostname, and optional port; no paths or wildcards.

`WS_TRUSTED_PROXY_IPS` lists exact proxy addresses. By default limits use the socket
peer and ignore forwarded headers. Through trusted peers only, the common resolver
walks X-Forwarded-For toward the nearest untrusted address and normalizes IPv4-mapped
IPv6. Spoofed headers from untrusted peers cannot choose a bucket. Without proxy
configuration, reverse-proxy clients share one IP bucket. CIDR/hostname trust is unsupported.

Legacy `API_*` environment settings are removed. Rename the origin/proxy/session
settings to their `WS_*` counterparts; request budget becomes
`WS_MAX_COMMANDS_PER_WINDOW`. `WS_MAX_PAYLOAD_BYTES` now bounds WebSocket frames only.

### 5.2 Session and command bounds

| Environment setting | Default | Bound |
| --- | --- | --- |
| `WS_MAX_SESSIONS` | 5,000 | Retained Hosted sessions |
| `WS_MAX_SESSIONS_PER_IP` | 128 | Retained sessions for one resolved client IP |
| `WS_MAX_SESSION_CREATES_PER_IP` | 120 per 60 s | Creation attempts, including after release |
| `WS_MAX_EVENT_BYTES` | 262,144 | Unacknowledged replay bytes per session |
| `WS_MAX_COMMANDS_PER_WINDOW` | 80 per 10 s | Authenticated commands per session |
| `WS_SESSION_TTL_MS` | 60,000 | Transport inactivity before expiry |

Class bounds additionally permit 128 retained events, eight unfinished Host commands
per session, and 10,000 retained creation-IP counters. Maintenance checks every ten
seconds. Release/expiry releases session capacity immediately and closes its stream,
then releases authoritative membership. Idle-player demotion and empty-room cleanup
use the separate 30-second `ROOM_WAIT_MS`; Local mode does not enable idle demotion.

### 5.3 Live and process bounds

| Environment setting | Default | Bound |
| --- | --- | --- |
| `WS_MAX_CONNECTIONS` | 5,000 | Established live sockets |
| `WS_MAX_CONNECTIONS_PER_IP` | 128 | Established sockets from one resolved IP |
| `WS_MAX_UPGRADES_PER_IP` | 120 per 60 s | Upgrade attempts |
| `WS_MAX_PAYLOAD_BYTES` | 8,192 | Incoming message size |
| `WS_MAX_BUFFERED_BYTES` | 262,144 | Queued outgoing bytes per socket |
| `WS_MAX_MESSAGES_PER_WINDOW` | 60 per 10 s | Frames, including authentication and acknowledgements |

Compression is disabled. Heartbeats run every ten seconds; a missing following
heartbeat removes a stale socket. Protocol closes allow one second before termination.
There are at most 10,000 retained upgrade-IP counters. HTTP has 10-second header and
15-second request deadlines, with at most 50 headers. Process shutdown is bounded
by ten seconds. All configured resource limits must be positive integers.

`Host.MAX_ROOMS` separately defaults to 1,000 registered rooms, including defaults.
Closing a room frees capacity; directory, existing joining/viewing, and normal play
remain available at registration capacity. Neither this policy nor socket/session
budgets constitute measured deployment-capacity guarantees.

## 6. Browser/local interfaces and verification

The public `/config.js` ES module exports `configuration.hostedOrigin`. Node derives
it from `GAME_SERVER_ORIGIN` or the shipped config and sends JavaScript with
`Cache-Control: no-store`. Empty selects Local by default; nonempty server settings
must be a credential-free HTTP(S) origin without path, query, or fragment. Static
frontends supply the same module independently; see P2-OM §2.2. This is public
configuration, not secret storage. Static assets are restricted to the browser
allowlist in `HttpApplication.js`; private repository routes return 404.

Browser room navigation is `room.html?mode=<direct-or-hosted>&room=<encoded-name>`.
`ui/SessionState.js` holds mode, admission intent, and carried notice in tab storage,
but not credentials or a separately verified endpoint. Direct requests use `{ command, data }`
and a local tab identity. Both modes deliver the same envelope in §4.

PlayingCard property/event contracts and dialog transitions are owned by P2-SDD §5;
preview controls by P2-OM §5. Interface changes require the corresponding server,
client, mapping/privacy, and browser tests in P2-VVP §3. No duplicate DTO schema or
alternate transport command vocabulary is introduced by an extension.
