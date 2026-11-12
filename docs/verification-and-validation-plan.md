# Pick 2 — Verification and Validation Plan

| Document ID | Revision | Software baseline |
| --- | --- | --- |
| P2-VVP | 2.1 | 2026-11-12; package version 1.0.0, working tree |

## 1. Introduction

### 1.1 Purpose and references

This plan defines how the [P2-SRS](software-requirements-specification.md) baseline
is verified and its user workflows validated. Its information-item structure is
tailored from test-documentation reference [4] in [P2-DOC](README.md#5-references).
A mapped test asset is a verification route, not proof that every requirement has
completed formal acceptance. P2-SDD and P2-ICD supply the design/interface criteria.

### 1.2 Test items and exclusions

Items include domain models, RoomService lifecycle, bots, Host authorization and
mapping, browser sessions/controllers, static HTTP assets/configuration, WebSocket admission/protocol protection,
and server process cleanup. Unit/integration checks do not establish native browser
layout/accessibility, production capacity, deployment TLS/proxy correctness, or
restart recovery. The latter recovery feature is outside product scope.

## 2. Verification strategy

### 2.1 Environment, techniques, and execution

Use Node.js 22 and install locked dependencies with `npm ci`. `npm test` discovers
`test/**/*.test.js`; `npm run test:coverage` adds built-in source coverage reporting.
No external database/service is required. Gateway/client checks use real Host logic;
HTTP asset and live parser checks run over in-memory streams. The server-process test also
binds a temporary localhost port, so socket restrictions shall be reported as an
execution limitation, not silently counted as a pass.

| Command | Responsibility |
| --- | --- |
| `npm run test:model` | Card rules, collections, players, turn order, serialization |
| `npm run test:service` | Room/Knockout workflows, queue recovery, cancellation/disposal, idle monitoring, odds |
| `npm run test:bots` | Decision policy and delayed executor behavior |
| `npm run test:shared` | Name/value validation and expected user failures |
| `npm run test:host` | Commands, membership, throttling, limits, notifications, StateMapper privacy |
| `npm run test:ui` | Session/client recovery, controllers, custom cards, page/style/metadata contracts |
| `npm run test:server` | Static-route isolation, socket admission/Origin policy, frames, replay, budgets, heartbeat, process lifecycle |
| `node --test test/architecture.test.js` | Dependency boundaries, resolved imports, JSDoc, source conventions |

Run affected tests while editing, then the full suite before completion. For one
scenario, place the filter before the filename:

```sh
node --test --test-name-pattern='skip chain' test/bots/strategy.test.js
```

The GitHub Actions workflow `.github/workflows/test.yml` runs on pushes and pull
requests. It provisions Node.js 22, caches npm downloads by lockfile, runs `npm ci`,
and executes `npm test` on Ubuntu. It has read-only repository permissions, a
ten-minute job deadline, and cancels superseded runs for the same ref. A local pass
is not evidence that the hosted workflow has executed; inspect its GitHub run after
pushing the workflow and lockfile.

### 2.2 Fixtures, isolation, and evidence

Each test owns and releases its Host, room service, socket, timer, or mock lifetime.
Use real rule/strategy execution with controlled state; do not replace global timers
to bypass behavior. Scoped mock clocks are valid for timer/cancellation tests.
`test/README.md` owns fixture implementation details. Source/HTML checks are contract
inspections; they do not substitute for interactive browser execution.

Record the source baseline, runtime, command, exit status, counts, failures, and
execution limitations. Coverage percentages indicate executed paths, not acceptance
or completeness. No percentage threshold or performance target is asserted here.

## 3. Requirements traceability

Each P2-SRS identifier below has a design/interface owner and verification assets.
Paths are relative to the repository root. AT identifiers refer to §4. Multiple
requirements may share one behavioral suite; separate tests are unnecessary when
existing assertions already exercise the contract.

| Requirement | Design / interface owner | Automated assets and acceptance |
| --- | --- | --- |
| P2-FR-001 | SDD §2; ICD §6 | `test/ui/session.test.js`, `test/host/host.test.js`; AT-01/02 |
| P2-FR-002 | SDD §4.1; ICD §2/3 | `test/host/host.test.js`, `test/ui/navigation.test.js`; AT-01/02 |
| P2-FR-003 | SDD §4.1 | `test/host/host.test.js`; AT-01 |
| P2-FR-004 | SDD §4.1 | `test/host/host.test.js`; AT-01/02 |
| P2-FR-005 | SRS §4.1; SDD §4.1 | `test/shared/validation.test.js`, `test/host/host.test.js`, `test/host/room-capacity.test.js` |
| P2-FR-006 | SDD §4.2 | `test/service/room-service.test.js`; AT-03 |
| P2-FR-007 | SDD §4.2 | `test/model/card.test.js`, `test/service/room-service.test.js`, `test/service/queue.test.js`; AT-03 |
| P2-FR-008 | SRS §4.2; SDD §4.2 | `test/service/room-service.test.js`; AT-03 |
| P2-FR-009 | SRS §4.3; SDD §4.2 | `test/model/card.test.js`, `test/service/room-service.test.js`; AT-03 |
| P2-FR-010 | SDD §4.2; ICD §3.2 | `test/service/room-service.test.js`, `test/ui/suit-selection-controller.test.js`; AT-03 |
| P2-FR-011 | SRS §4.3; SDD §4.2 | `test/service/room-service.test.js`, `test/ui/results-controller.test.js`; AT-04 |
| P2-FR-012 | SRS §4.4; SDD §4.2 | `test/service/knockout.test.js`, `test/host/knockout.test.js`; AT-05 |
| P2-FR-013 | SRS §4.5; SDD §6 | `test/bots/strategy.test.js`, `test/bots/bot-service.test.js`, `test/service/card-odds.test.js` |
| P2-FR-014 | SDD §4.2 | `test/host/match-commands.test.js`, `test/service/room-service.test.js`; AT-04 |
| P2-FR-015 | SDD §4.2; ICD §3.2 | `test/model/card-collection.test.js`, `test/service/room-service.test.js`; AT-03 |
| P2-FR-016 | SRS §4.5; SDD §4.3 | `test/service/idle-monitor.test.js`; AT-08 for full demotion/notice |
| P2-FR-017 | SDD §4.3; ICD §4.1 | `test/host/host.test.js`, `test/ui/navigation.test.js`; AT-08 |
| P2-FR-018 | SDD §4.4; ICD §3.3 | `test/ui/hosted-client.test.js`, `test/server/websocket-gateway.test.js`, `test/ui/connection.test.js`; AT-07 |
| P2-FR-019 | SDD §5.1; ICD §4.1 | `test/ui/room-results-transition.test.js`, `test/ui/alert-controller.test.js`, `test/ui/suit-selection-controller.test.js`; AT-04/06 |
| P2-FR-020 | SDD §5.1; OM §5 | `test/ui/faq.test.js`, `test/ui/ui-preview.test.js`; AT-06 |
| P2-NFR-001 | SDD §3.2; ICD §4.2 | `test/host/hand-privacy.test.js`, `test/server/hosted-gateway.test.js`, `test/server/websocket-gateway.test.js`; AT-02/04 |
| P2-NFR-002 | SDD §4.1; ICD §2/3/3 | `test/server/hosted-gateway.test.js`, `test/host/host.test.js`, `test/server/websocket-gateway.test.js` |
| P2-NFR-003 | ICD §5 | `test/server/hosted-gateway.test.js`, `test/server/http-application.test.js`, `test/server/websocket-gateway.test.js`, `test/host/request-throttle.test.js` |
| P2-NFR-004 | SDD §4.2 | `test/service/queue.test.js`, `test/service/room-service.test.js` |
| P2-NFR-005 | SDD §4.3 | `test/service/automation-lifecycle.test.js`, `test/host/match-commands.test.js` |
| P2-NFR-006 | SDD §4.4 | `test/ui/hosted-client.test.js` |
| P2-NFR-007 | SDD §5 | `test/ui/playing-card.test.js`, `test/ui/page-contracts.test.js`, `test/ui/styles.test.js`; AT-06 |
| P2-NFR-008 | SDD §4.4; ICD §3.2/3.3 | `test/shared/user-notification.test.js`, `test/host/action-notifications.test.js`, `test/server/http-application.test.js` |
| P2-NFR-009 | SDD §4.3; OM §3 | `test/service/automation-lifecycle.test.js`, `test/server/server-process.test.js`; AT-09 |
| P2-NFR-010 | SRS §2; SDD §2.2 | `test/ui/session.test.js`, `test/server/hosted-gateway.test.js`; AT-09 and source inspection of memory ownership |
| P2-FR-021 | ICD §6; OM §2.2 | `test/ui/connection.test.js`, `test/server/http-application.test.js`, `test/server/server-process.test.js` |
| P2-NFR-011 | ICD §6; OM §2.2 | `test/server/http-application.test.js`, `test/server/server-process.test.js` |
| P2-DC-001 | SDD §2.1 | `test/architecture.test.js` |
| P2-DC-002 | SDD §2.1/3.2 | `test/architecture.test.js`, `test/host/state-mapper.test.js`, `test/host/hand-privacy.test.js` |
| P2-DC-003 | SDD §2.1; ICD §2/3 | `test/architecture.test.js`, `test/ui/hosted-client.test.js` |

## 4. User and operational acceptance procedures

Use a supported graphical browser against a fresh Local runtime and a Hosted
runtime. Use separate tabs for different humans/viewers; keep credentials separate.
Capture browser/version, viewport, baseline, observed result, and any defect.

| ID | Procedure | Expected result |
| --- | --- | --- |
| AT-01 | In Local Home, create a custom room, inspect defaults, start, play, leave | Open seats fill with bots; valid turns advance; Leave returns Home |
| AT-02 | In Live, create with Alice, join Bob in another tab, view in a third, use Invite | Same room and counts; viewer takes no seat; private hands remain hidden |
| AT-03 | Try matching/nonmatching drops, Draw/Pass, draw defenses, ace declaration, and sorting | Illegal actions show errors; legal effects and allowances match SRS §4; new draws clear temporary sort |
| AT-04 | Finish a match, dismiss results, receive another finished snapshot, then draw/start | Results open once; final hands reveal; ordinary resume preserves hands; continuation hides private hands |
| AT-05 | Run Knockout with three/four players, including penalty ties and a departure | Finished roster persists, nonqualifiers become viewers at continuation, final/tie/forfeit follows SRS, bots return |
| AT-06 | Inspect all pages below/above 721px; expand guides without JS; use keyboard controls/dialogs | Readable landmarks/layout, visible focus, correct labels/overlays, no runtime fixtures |
| AT-07 | Interrupt a live socket, recover within expiry, then exhaust retries | Retained membership and replay without duplicate mutation/admission; exhaustion opens manual choices |
| AT-08 | Let eligible Live humans idle, then keep the room empty through grace | Idle participant becomes warned viewer; abandoned room closes with a carried Home notice |
| AT-09 | Send SIGINT/SIGTERM, restart the server, and inspect browser behavior | Clean process exit; no restored room state; clients recover only through current admission |

Static preview procedures are defined once in P2-OM §5. They support AT-06 but do
not execute drag, network, focus, or timing behavior.

## 5. Entry, exit, suspension, and incident criteria

Entry requires installed dependencies, a controlled baseline, and the necessary
local socket/browser permissions. Exit for a change requires its affected automated
checks and full suite to pass, applicable AT procedures to be recorded, and known
limitations to be disclosed. A documentation-only restructure requires link/anchor,
traceability, and source-reference validation; it does not establish new browser
acceptance evidence.

Suspend a procedure if its prerequisite environment is unavailable or an earlier
failure makes later observations invalid. Preserve the first failure, restore a
clean fixture/runtime, and rerun the affected procedure after correction. Record
incidents with requirement/AT ID, baseline, reproduction, expected/actual outcome,
severity, and resolution. Never fabricate passed checks or silently skip blocked tests.

## 6. Execution record

Entries identify historical baselines. Earlier REST/probe records describe the
pre-migration implementation and do not prescribe the current protocol.

The documentation-restructure execution record is populated from the actual
verification run below. Manual AT-01–09 are not newly executed by this documentation
change; automated mapping does not imply their acceptance sign-off.

| Record | Baseline | Command / inspection | Result |
| --- | --- | --- | --- |
| VR-20261111-01 | Working tree dated 2026-11-11; Node.js v22.23.1 | `npm test` | Exit 0; 290 passed, 0 failed, 0 skipped, 0 cancelled |
| VR-20261111-02 | Same documentation baseline | Local Markdown links/anchors, source references, table structure, requirement mapping | 7 documents; 33 links/anchors and 77 source references valid; all 33 requirements mapped exactly once |
| VR-20261111-03 | Same working tree | `git diff --check`; obsolete documentation-link search | No whitespace errors or references to removed documentation paths |
| VR-20261111-04 | Deployment configuration/static serving working tree; Node.js v22.23.1 | `npm test` | Exit 0; 292 passed, 0 failed, 0 skipped, 0 cancelled; includes allowed/denied static routes, traversal rejection, module configuration/validation, real-process environment override and image delivery |
| VR-20261111-05 | Same deployment change | Documentation links, source references, requirement mapping; `git diff --check` | 33 local links/anchors and 81 source references valid; all 35 requirements mapped once; no whitespace errors |
| VR-20261112-01 | Flow/ownership refactor working tree; Node.js v22.23.1 | `npm test` | Exit 0; 297 passed, 0 failed, 0 skipped, 0 cancelled; includes same-owner bot progress and late probe success/failure after Local switch or page departure |
| VR-20261112-02 | Same refactor | Documentation links, source references, requirement mapping; `git diff --check` | 33 local links/anchors and 85 source references valid; all 35 requirements mapped once; no whitespace errors |
| VR-20261112-03 | WebSocket-only protocol v2 working tree; Node.js v22.23.1 | `npm test` | Exit 0; 296 passed, 0 failed, 0 skipped, 0 cancelled; replaces obsolete REST tests with socket creation/admission, explicit release, private snapshots, replay/expiry, command/frame budgets, malformed handshake/sequence, deadlines, uncertain-mutation and real-process checks |
| VR-20261112-04 | Same protocol migration | Local documentation links/anchors, source references, requirement mapping; `git diff --check` | 33 local links/anchors and 85 source references valid; all 35 requirements mapped once; no whitespace errors |
| VR-20261112-05 | Retry/locked-install/CI working tree; Node.js v22.23.1 | `npm ci` with writable temporary npm cache, then `npm test` | Clean installation of 68 locked packages; exit 0; 298 passed, 0 failed, 0 skipped, 0 cancelled; repeated sequence/cursor errors stop after five retries despite ready frames |
| VR-20261112-06 | Same change | Workflow YAML parsing/trigger-permission-command checks; documentation links/source references/traceability; `git diff --check` | Workflow configuration valid; 33 links/anchors and 85 source references valid; 35 requirements mapped once; no whitespace errors. Hosted GitHub execution awaits push. |
