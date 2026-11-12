# Tests

Run the full suite with `npm test`, or use `npm run test:coverage` to inspect coverage.
The scripts discover only `*.test.js`; helper modules are not counted as tests.

| Location | Responsibility | Focused command |
| --- | --- | --- |
| `model/` | Cards, collections, players, turns, and serialization | `npm run test:model` |
| `service/` | Room commands, Knockout, queue recovery, idle policy, card odds | `npm run test:service` |
| `shared/` | Validation and expected user failures | `npm run test:shared` |
| `bots/` | Strategy decisions and bot execution | `npm run test:bots` |
| `host/` | Command validation, membership records, mapping/privacy, throttling and lifecycle integration | `npm run test:host` |
| `server/` | WebSocket admission, live protocol protection, privacy, and server lifecycle | `npm run test:server` |
| `ui/` | Sessions, controller behavior, custom elements, page contracts, metadata and styles | `npm run test:ui` |
| `architecture.test.js` | Import boundaries, JSDoc and source conventions | `node --test test/architecture.test.js` |

To run one scenario, put the name filter before the filename:

```sh
node --test --test-name-pattern='skip chain' test/bots/strategy.test.js
```

## Fixtures and isolation

- `helpers/bot.js` removes only the bot's presentation delay. It uses production decisions and leaves global timers intact.
- `helpers/room-service.js` creates a controlled active RoomService and registers idle-monitor cleanup.
- `helpers/host.js` connects one tab and captures responses per request. Tests own Host shutdown and register it with `t.after()`.
- `helpers/live-socket.js` bridges browser socket callbacks to real authenticated Hosted streams.
- `helpers/memory-sockets.js` connects real HTTP/WebSocket parsers without binding a port.
- `helpers/html.js` reads static opening-tag attributes. These checks cover markup contracts; they do not replace browser rendering or accessibility testing.

Add behavioral tests at the lowest stable layer. Keep bot tactics out of Room-rule tests and client sessions out of Host transport tests. Test notifications through received payloads. Source-text checks belong in architecture or UI contract tests; prefer executable controller tests for state changes.

## Audit notes

The reorganization preserves the domain, bot, transport and controller cases. It separates the former mixed `room`, `local-game`, and `infrastructure` suites by responsibility, including domain and Host Knockout coverage. Bot scenarios use a dedicated immediate BotService instead of changing bot models
or replacing global timers. Idle-policy tests use isolated Node mock clocks.

The duplicate landing metadata test was consolidated into navigation's stronger checks of canonical, social and structured metadata. The large shared-page assertion was replaced with separate landmark, asset, registration, membership and dialog contracts. Attribute order, optional `./` prefixes and current preview fixtures no longer cause false failures; metadata values, card ranks, local asset resolution and UI hooks remain checked. Static preview state is verified separately from real session startup.

The start-notification integration scenario uses a two-human custom room, avoiding randomized bot delays. Hosts register cleanup before assertions, so failures do not leave their lifecycle work running.

Coverage still has room to improve in DOM-heavy list/template utilities and controller interactions. Static page-contract checks verify shipped markup but do not execute those paths. Browser layout checks at mobile and desktop sizes remain separate.

The server-process test opens a temporary localhost socket and starts a short-lived server process.
Hosted gateway and browser tests run against the real Host without network sockets.
WebSocket protocol tests run real upgrades and parsers over connected in-memory streams.
Only the server-process test requires local socket permission, including in `npm test`;
no external service is contacted.
