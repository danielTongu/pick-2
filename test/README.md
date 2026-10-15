# Tests

Run the full suite with `npm test`, or use `npm run test:coverage` to inspect coverage.
The scripts discover only `*.test.js`; helper modules are not counted as tests.

| Location | Responsibility | Focused command |
| --- | --- | --- |
| `core/` | Card rules, collections, validation, serialization, mapping, Room and Knockout rules | `npm run test:core` |
| `bots/` | Strategy decisions and bot execution | `npm run test:bots` |
| `host/` | Requests, connections, actions, notifications, throttling and lifecycle integration | `npm run test:host` |
| `server/` | Real WebSocket protection, wire privacy, and server lifecycle | `npm run test:server` |
| `ui/` | Sessions, controller behavior, custom elements, page contracts, metadata and styles | `npm run test:ui` |
| `architecture.test.js` | Import boundaries, JSDoc and source conventions | `node --test test/architecture.test.js` |

To run one scenario, put the name filter before the filename:

```sh
node --test --test-name-pattern='skip chain' test/bots/strategy.test.js
```

## Fixtures and isolation

- `helpers/bot.js` removes only the bot's presentation delay. It uses production decisions and leaves global timers intact.
- `helpers/room.js` creates a controlled active Room and registers idle-monitor cleanup.
- `helpers/host.js` connects one tab and captures responses per request. Tests own Host shutdown and register it with `t.after()`.
- `helpers/html.js` reads static opening-tag attributes. These checks cover markup contracts; they do not replace browser rendering or accessibility testing.

Add behavioral tests at the lowest stable layer. Keep bot tactics out of Room-rule tests and client sessions out of Host transport tests. Test notifications through received payloads. Source-text checks belong in architecture or UI contract tests; prefer executable controller tests for state changes.

## Audit notes

The reorganization preserves the domain, bot, transport and controller cases. It separates the former mixed `room`, `local-game`, and `infrastructure` suites by responsibility, including domain and Host Knockout coverage. The older bot scenarios now share an immediate bot instead of replacing global timers.

The duplicate landing metadata test was consolidated into navigation's stronger checks of canonical, social and structured metadata. The large shared-page assertion was replaced with separate landmark, asset, registration, membership and dialog contracts. Attribute order, optional `./` prefixes and current preview fixtures no longer cause false failures; metadata values, card ranks, local asset resolution and UI hooks remain checked. Static preview state is verified separately from real session startup.

The start-notification integration scenario uses a two-human custom room, avoiding randomized bot delays. Hosts register cleanup before assertions, so failures do not leave their lifecycle work running.

Coverage still has room to improve in DOM-heavy list/template utilities and controller interactions. Static page-contract checks verify shipped markup but do not execute those paths. Browser layout checks at mobile and desktop sizes remain separate.

`server/` tests open temporary localhost sockets and start a short-lived server process. They require local socket permission, including when run through `npm test`; no external service is contacted.
