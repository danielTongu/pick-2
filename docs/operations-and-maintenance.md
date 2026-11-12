# Pick 2 — Operations and Maintenance Guide

| Document ID | Revision | Software baseline |
| --- | --- | --- |
| P2-OM | 2.1 | 2026-11-12; package version 1.0.0, working tree |

## 1. Introduction

This guide defines installation, operation, development, and presentation-review
procedures. It supports P2-SRS operational requirements and the architecture in
[P2-SDD](software-design-description.md). Transport configuration values and security
policies are owned exclusively by [P2-ICD §5](interface-control-document.md#5-deployment-policies-and-resource-bounds).
Verification commands and acceptance criteria belong to [P2-VVP](verification-and-validation-plan.md).

## 2. Installation and deployment

### 2.1 Prerequisites and local startup

Install Node.js 22 and npm, then run from the repository root:

```sh
npm ci
npm start
```

Open [http://localhost:8080](http://localhost:8080). `npm run dev` uses Node watch
mode. `npm start` launches `server/main.js`; root `main.js` is the browser entry
point. There is no frontend bundler, generated application build directory, database
migration, or external test service. Installation may need dependency-registry access. `package-lock.json` pins the
complete dependency graph; keep it under version control. Use `npm ci` for clean
installs. When intentionally changing dependencies, run `npm install`, review both
manifest/lockfile changes, and verify the resulting clean install and test suite.

### 2.2 Static frontend and Hosted server

Serve the repository root for static Local play. The canonical public frontend is
[https://danieltongu.github.io/pick-2/](https://danieltongu.github.io/pick-2/).
The browser imports the public root `config.js` module. The Node server generates
this module using `GAME_SERVER_ORIGIN`, falling back to the shipped configuration
(`http://localhost:8080`) when unset. Empty explicitly selects Local mode. Valid
nonempty Node settings must be an HTTP(S) origin with no credentials, path, query,
or fragment; invalid settings fail startup. The frontend page address is never
inferred as the server endpoint.

For static hosting, deploy a replacement `config.js` alongside `main.js`:

```js
/** Public deployment settings; no credentials or secrets. */
export const configuration = { hostedOrigin: "https://live.example.com" };
```

Use `hostedOrigin: ""` for Local by default. The static frontend's deployed config
is independent of the Hosted server environment; configure the frontend actually used
by players. Configure static hosting to revalidate this file on navigation. Node
responses for `/config.js` use `Cache-Control: no-store`. Changes take effect after
a server restart and page reload; already running sessions retain their endpoint.

For a remote HTTPS frontend, provide HTTPS/WSS through the deployment environment
and configure the actual frontend origin on the server, for example in a POSIX shell:

```sh
GAME_SERVER_ORIGIN=https://live.example.com WS_ALLOWED_ORIGINS=https://game.example.com PORT=8080 npm start
```

A reverse proxy must forward static/configuration requests and the `/live` WebSocket
upgrade. Configure exact trusted proxy IPs only when controlled by the deployment.
Use P2-ICD's complete `WS_*` policies rather than copying its tables here.
`PORT` changes the HTTP listening port. The shipped app has no installer or bundled
standalone executable. Static file links continue to work under a frontend subdirectory;
the configured Hosted origin exposes its WebSocket channel at the root `/live` path.

The Node static allowlist exposes `/`, the three HTML pages, `main.js`, `config.js`,
`sitemap.xml`, browser modules in `model/`, `service/`, `host/`, `shared/`, and the
required `ui/` modules/styles/templates/images. Host/service source is required for
Local play. Other repository routes return 404; directory indexes, dotfiles, encoded
path variants, and traversal paths are not allowed. Add new browser asset types to
`server/HttpApplication.js` deliberately and verify both allowed and denied routes.
`/health` remains available for deployment checks. Former `/api` routes return 404.

## 3. Operational procedures and limitations

Deploy frontend and backend together: this protocol uses `/live` and a version-2
ready frame. The former REST adapter and `API_*` settings are removed. Rename those
settings as specified in P2-ICD §5; the command budget is
`WS_MAX_COMMANDS_PER_WINDOW`. There is no compatibility alias. Static frontends
still configure their own public `config.js`; reverse proxies must allow WebSocket
upgrade and ping/pong traffic. Choose an idle timeout that permits the heartbeat.

### 3.1 Startup and health inspection

Start the process from a controlled baseline and inspect its startup output. The
server reports its localhost and current IPv4 LAN URLs. `GET /health` returns `OK`;
this demonstrates HTTP response availability, not authenticated socket admission,
a working game workflow, or measured server capacity. Home connects directly over
WebSocket. Connection checks the version-2 ready frame using the same client,
without HTTP probes. Verify actual Live admission
and gameplay using P2-VVP AT-02/03/07 after deployment changes.

### 3.2 Shutdown, incident handling, and restart

Use SIGINT or SIGTERM for graceful shutdown. The process stops maintenance and live
streams, begins session release, disposes Host room resources, drains pending work,
and closes HTTP within its shutdown deadline. Fatal exceptions/unhandled rejections
are logged and initiate shutdown because authoritative state may be unsafe.

Inspect diagnostic errors without publishing credentials or private snapshots.
Check origin/proxy configuration, capacity, JSON/frame bounds, and the client recovery
page when admission fails. Do not infer a game failure from a page-render callback
error alone; the latter has a separate client error boundary.

Restart creates fresh default rooms; custom rooms, hands, replay buffers, and
credentials do not survive. There is no database backup/restore or automatic game
reconstruction. Direct rooms likewise end with their browser-owned runtime. The
software is proprietary; the root README owns copyright/license terms.

## 4. Maintenance procedures

### 4.1 Source layout and change ownership

| Location | Ownership |
| --- | --- |
| `main.js`, root HTML pages | Browser entry and semantic page structures |
| `model/` | Identity, cards/collections, players, turns, Match/Knockout, serialization |
| `service/` | Room workflows, mutation queue, game revision, bot decisions/delays, idle resources |
| `host/` | Command contexts, membership records, authorization, scheduling, StateMapper publication |
| `shared/` | Constants, validation, expected failures, Hosted protocol vocabulary |
| `server/` | Node entry `main.js`, HTTP composition, sessions, WebSocket protection |
| `ui/` | Session transport/page lifecycles; independent `SessionState.js` tab persistence; controllers, custom card, utilities, templates, styles, artwork |
| `test/` | Behavioral suites and owned fixtures; see P2-VVP |
| `docs/` | Controlled information items listed by P2-DOC |
| `sitemap.xml` | Canonical Home entry; dynamic pages remain excluded |

Keep plain command/membership data as records rather than data-only wrapper classes.
Place behavior with its state/lifetime owner. Use existing validation, notification,
ordering, template, and DOM-state utilities. Do not add competing DTOs, scoring
policies, or transport authority. Before changing a major architecture boundary,
explain its fit/tradeoffs and recommend keeping or replacing it.

### 4.2 Source documentation and coding conventions

Application classes, fields, methods, accessors, and named functions require adjacent
JSDoc. Public/extension comments describe behavior, parameters, meaningful results,
and important failures; private fields carry useful types. Comments explain contracts
and decisions rather than repeating assignments. Test callbacks and ordinary locals
are not APIs. The architecture test checks declaration coverage and import boundaries.
There is no configured HTML JSDoc generator or npm generation command; source comments
are the maintained API documentation.

Use PascalCase classes, camelCase ordinary members, UPPER_SNAKE_CASE constants, and
unit-bearing duration names. Private members use `#camelCase`; extension hooks use
`_camelCase`. Mutable static metadata remains camelCase. External dictionary keys
retain their protocol spelling. Arrange fields before construction/APIs, preserve
initializer order, group related helpers, and keep getter/setter pairs adjacent.
Prefer named explicit control flow, avoid redundant state/returns, and reuse shared
behavior rather than introducing repeated code.

### 4.3 Documentation and verification change control

Update the owning requirement and its traceability row when behavior changes.
Keep design decisions in P2-SDD, schemas/limits in P2-ICD, installation/preview here,
and player procedures in P2-UM. Update the in-page Home guide/Room FAQ with public
rule changes. Do not recreate a second omnibus reference or duplicate configuration
tables. Preserve stable requirement IDs and record baseline changes through Git.

Run the affected suite and `npm test`; use coverage for targeted branch review.
Record applicable manual acceptance after UI/deployment changes. A process test
blocked by socket permissions is a limitation to report, not a pass. Match/room
closure tests must dispose resources so failed assertions do not leave work running.

## 5. Static presentation review

### 5.1 Procedure and limits

Open `index.html` or `room.html` with JavaScript disabled, or remove the final module
script in a temporary local copy. CSS and card artwork work without a running Host.
Set `body[data-ui-preview="true"]` to show `.ui-fixture` sample rooms, opponents,
cards, and results. Runtime startup disables preview and removes these fixtures
before admission. Edit attributes and reload to inspect states; keep one overlay
open at a time. Repeat interactive behavior with JavaScript enabled afterward.

Static previews assess layout, colors, visibility, and CSS animation. They do not
verify clicks, drag behavior, network retries, focus, legality, or timers. Inspect
Home and Room at mobile and 721px-plus widths; include Connection for connection changes.

### 5.2 State controls

| Element | Attribute / control | Values and effect |
| --- | --- | --- |
| Home/Room header aside; Connection `#site-shell` | `data-connection-status` | connecting, reconnecting, connected, disconnected, error, unconfigured |
| Room `#site-shell` | `data-connection-mode` | direct/hosted: label, Live Invite, Local idle-warning visibility |
| Home radio controls | `checked` | Select Local/Live or Create/Join |
| `#list-panel` | `data-directory-state` | populated/empty directory presentation |
| Room table cells | `data-name`, `data-state`, count attributes | Display identity, lifecycle, and values |
| `#room-view` | `data-membership` | player: hand/three-row layout; viewer: no hand/two rows and Join |
| `#player-commands` | `data-match-state` | waiting/active/finished: command visibility |
| Player regions | `data-player-state` | ready, active, won, lost, qualified, eliminated |
| Player outputs | `data-player-name`, `data-item-count`, `data-draw-allowance`, `data-idle-seconds` | Display name, counts, allowance, idle warning |
| `playing-card` | `data-value`, `data-suit`, `data-is-face-up` | Card face/back; retain `.playing-card-center` for static rendering |
| Dialogs except Play | `hidden` | Remove to preview; add to close |
| `#play-dialog` | `data-state` | open/closed |
| Alert | `data-status` | info/warning/error/success accent |
| Result rows | `data-player-state`, `aria-selected` | Winner and selection presentation |

For a seated active-turn preview, set preview true, membership player, match active,
and local player active. Remove `hidden` on results to inspect its sample data.
Unique elements use IDs; repeated regions/cards/fixtures use classes. Presentation
property and card-drop contracts are specified in P2-SDD §5.2.
