# Pick 2 — Software Requirements Specification

| Document ID | Revision | Software baseline |
| --- | --- | --- |
| P2-SRS | 2.0 | 2026-11-12; package version 1.0.0, working tree |

## 1. Introduction

### 1.1 Purpose

This specification states the observable requirements for Pick 2. It follows the
requirements-information-item conventions of reference [1], tailored as described
in the [documentation register](README.md). Verification mappings are maintained in
[P2-VVP](verification-and-validation-plan.md#3-requirements-traceability).

### 1.2 Scope and intended users

Pick 2 is a browser shedding-card game for human players, automated opponents, and
viewers. Local mode runs an isolated Host in the browser. Live mode shares a Node
Host through one WebSocket channel for admission, commands, and pushed updates. The application
has no database, accounts, durable saved games, or cross-process room registry.

### 1.3 Definitions and references

Terms and references [1]–[5] are defined in [P2-DOC](README.md#4-terms-and-abbreviations).
The [interface specification](interface-control-document.md) defines field-level
contracts; the [design description](software-design-description.md) explains their realization.

## 2. Overall description

### 2.1 Product perspective and environment

The product consists of Home, Connection, and Room browser pages, an in-browser
Direct runtime, and an optional Hosted Node runtime. A graphical browser with
JavaScript/ES modules is required for interactive play. Node.js 22 and npm support
Hosted execution and automated tests. Static hosting can provide Local play alone.
Rooms and sessions exist only for their owning runtime's lifetime.

### 2.2 User classes

| Class | Permitted interaction |
| --- | --- |
| Human Player | Occupies a seat and submits game actions under room/turn rules |
| Viewer | Observes public room state and requests a seat when admission is eligible |
| Bot | Occupies a seat and submits automated decisions through the same authoritative rules |
| Operator | Configures origins, limits, deployment, and process lifecycle |
| Maintainer | Changes implementation, documentation, and verification together |

### 2.3 Assumptions and exclusions

Remote deployment supplies reachable HTTP/WebSocket infrastructure and the allowed
frontend origin. TLS termination and deployment-level denial-of-service protection
are environmental responsibilities. A configured capacity limit is not a measured
throughput or concurrency guarantee. Browser layout, focus, and accessibility need
manual acceptance in addition to static checks. Account registration, persistent
scores, installers, and distributed rooms are outside this baseline.

## 3. Specific requirements

All requirements below describe the current product baseline. Priority is essential
for every listed requirement; changing one requires an explicit product decision.
Detailed game-rule terms in §4 qualify the associated functional requirements.

### 3.1 Functional requirements

| Identifier | Requirement |
| --- | --- |
| P2-FR-001 | The application shall expose Local and Live modes with the same game rules and public snapshot shape. |
| P2-FR-002 | Home shall display the available directory and support room creation, seating requests, viewing, and leaving. |
| P2-FR-003 | Each Host shall initialize its configured default rooms and bots. |
| P2-FR-004 | Creating a custom Local room shall fill its open seats with bots; a custom Hosted room shall not add bots automatically. |
| P2-FR-005 | Admission shall enforce validated names, unique seated player identity within a room, capacity, lifecycle, and current connection membership. |
| P2-FR-006 | Starting a match shall require at least two players and deal seven cards per player, a legal initial discard, and a first owner. |
| P2-FR-007 | Active card commands shall validate turn ownership, held-card ownership, current legality, and pending decisions before applying game effects. |
| P2-FR-008 | Draw and Pass shall consume the current draw allowance according to §4.2. |
| P2-FR-009 | Special cards shall apply the effects in §4.3, except that a match-ending discard shall finish before any subsequent effect. |
| P2-FR-010 | A suit declaration shall be accepted only for the current owner's pending declaration and one standard suit. |
| P2-FR-011 | An ordinary result shall mark every lowest-penalty player as a winner, including ties. |
| P2-FR-012 | Knockout shall apply qualification, continuation, final, and departure rules in §4.4. |
| P2-FR-013 | Bots shall use authoritative legal commands and the information-access policy in §4.5. |
| P2-FR-014 | Waiting-state draws/discards shall preserve preparation behavior; the next authenticated ordinary finished-match command shall resume waiting without resetting hands. |
| P2-FR-015 | Hand sorting shall use `none`, `rank`, or `suit`; the next Draw/Discard/Pass shall commit the selection, and drawing shall clear the temporary client sort. |
| P2-FR-016 | Eligible Hosted humans shall be demoted to viewing with a warning after the configured idle window; Direct mode shall disable automatic idle demotion. |
| P2-FR-017 | A room that remains empty through its grace interval shall be unregistered and its clients returned Home with a room-closure notice. |
| P2-FR-018 | Live recovery shall retry within the defined budget, retain valid session membership, replay missed events, and open manual recovery after exhaustion. |
| P2-FR-019 | The UI shall preserve combined state/notification responses and apply the dialog-transition rules specified in P2-SDD §5. |
| P2-FR-020 | Home and Room shall provide expandable guides that remain readable without JavaScript; preview fixtures shall be removed before runtime admission. |
| P2-FR-021 | The browser shall read its Hosted endpoint from a public deployment configuration module; Node deployments shall support an environment override, and an empty endpoint shall select Local by default. |

### 3.2 Quality and operational requirements

| Identifier | Requirement |
| --- | --- |
| P2-NFR-001 | Public snapshots shall hide other players' cards/penalties until results and expose only a draw-deck count for every recipient. |
| P2-NFR-002 | Hosted commands shall derive authority from secret-token session membership rather than client-supplied identities. |
| P2-NFR-003 | Hosted admission, requests, frames, retained events, and buffered output shall be bounded by the policies in P2-ICD §5. |
| P2-NFR-004 | RoomService shall serialize seated game mutations and revalidate action eligibility within the mutation queue. |
| P2-NFR-005 | Room disposal and match replacement shall invalidate delayed bot work; queued bot decisions shall also validate the captured game revision and exact owner identity. |
| P2-NFR-006 | A page callback exception shall be reported independently of transport recovery and shall not retire valid credentials. |
| P2-NFR-007 | Presentation shall use semantic page controls, descriptive card names, and the mobile/wider-layout contracts in P2-SDD §5. |
| P2-NFR-008 | Expected user failures shall produce actionable notifications; unexpected runtime failures shall preserve diagnostic errors and expose only generic server failure details. |
| P2-NFR-009 | Server shutdown shall release sockets, sessions, room monitors, and scheduled work on SIGINT/SIGTERM; fatal process errors shall initiate bounded shutdown. |
| P2-NFR-010 | Game and session state shall remain in memory and shall not be represented as recoverable after its owning runtime terminates. |
| P2-NFR-011 | Node static serving shall expose only approved browser assets and required Local-play modules; private repository paths and traversal requests shall not expose files. Deployment configuration shall contain no secrets and Node shall reject invalid nonempty endpoint origins. |

### 3.3 Design constraints

| Identifier | Requirement |
| --- | --- |
| P2-DC-001 | Models shall depend only on model/shared code and shall not schedule timers; services shall not depend on Host, UI, or public mapping. |
| P2-DC-002 | Host shall remain independent of Node/browser transport APIs and shall publish through recipient-specific StateMapper output. |
| P2-DC-003 | Hosted session creation, directory/admission, gameplay, and updates shall use one WebSocket protocol without HTTP admission, HTTP probes, or gameplay polling. |

## 4. Domain rules

### 4.1 Identity, seating, and states

Player names contain 2–24 characters and room names 2–48. The accepted form is
Unicode letters/numbers separated by single spaces, straight/curly apostrophes,
or hyphens, without outer whitespace or repeated separators. Normalized lookup keys
do not substitute for creation validation. Capacity counts players, not viewers;
the default maximum is four. Join is unavailable during an active or unfinished
Knockout. The lifecycle states are `waiting`, `active`, and `finished`; a pending
declaration is an active-match decision, not another lifecycle state.

### 4.2 Matching, drawing, and transfer rules

Ordinary play matches suit or value, with wild-card exceptions. A declared suit
permits that suit, any ace, or a joker. An active draw attack permits an equal/higher
natural draw-card value or ace of spades: two can be answered by two/joker/shield;
joker can be answered by joker/shield. A defending attack replaces the allowance
with two or four; penalties do not accumulate. Drawing the penalty advances the
turn. After an ordinary one-card draw, the owner may still discard or pass. Pass
consumes any remaining allowance before advancing. An empty draw collection is
refilled from discards while retaining the top card; insufficient cards are an
internal error. Directly taking a discard back into a hand is unavailable.

### 4.3 Special cards and scoring

| Card | Active-play effect | Hand penalty |
| --- | --- | --- |
| 3–10 except seven of hearts | Ordinary matching; eight skips the next player | Numeric value |
| Jack | Reverse with three or more players; skip the opponent with two | 11 |
| Queen / king | Ordinary matching | 12 / 13 |
| Ace of clubs, diamonds, hearts | Legal discard followed by the owner's suit declaration | 14 |
| Two | Give the next player a two-card allowance | 20 |
| Seven of hearts | Legal discard immediately ends the match | 30 |
| Black or red joker | Wild discard; give the next player four cards | 40 |
| Ace of spades | Wild discard; cancel a draw attack without choosing a suit | 50 |

A hand penalty is the sum of ranks. Empty hands score zero. Emptying a hand or
legally discarding seven of hearts ends the match immediately. All layers use the
same rank policy; rotation is presentation data, not an influence on legality.

### 4.4 Knockout

For a match begun with at least three players, everyone tied for highest penalty
is eliminated; other players qualify. The finished roster remains visible until
continuation starts. At that start eliminated humans become viewers and eliminated
bots are sidelined. With at least two qualifiers, continuation occurs after the
configured wait or a seated human's accepted Start. One survivor wins; no survivors
means a tied series. The last two play an ordinary lowest-penalty final, including
ties. Departure from an active two-player Knockout awards the remaining player a
forfeit win. Departed player metrics cannot be displayed after roster removal.
Sidelined bots return after the completed series and its presentation delay.

### 4.5 Bot information and idle eligibility

BotStrategy may inspect the hands of opponents reachable over its projected next
two turns. Distant opponents provide identity/count information; the draw collection
remains unknown. Decisions use copied state and the current public discard pile,
including recycling, rather than retained live domain references.

Hosted idle monitoring follows eligible humans: all waiting humans, the active
human owner, qualified humans awaiting Knockout continuation, and seated humans in
ordinary finished states until resumed/removed. Bots are excluded. Successful game
mutations refresh eligible windows and room activity. Viewer changes update room
activity only when membership changes. Failed commands do not count as successful
activity. Transport heartbeats do not count as player activity.

## 5. Verification and unresolved scope

P2-VVP §3 maps every requirement to its owning design/interface section and test
assets. Automated checks establish behavior in controlled scenarios; browser/manual
acceptance and deployment-capacity measurement remain distinct activities. No
performance SLA, complete accessibility certification, or distributed persistence
is claimed by this baseline.
