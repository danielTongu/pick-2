# Pick 2

Pick 2 is a proprietary, real-time multiplayer shedding card game for the browser. Players can create or enter rooms, play against people and built-in AI players, or watch as visitors.

The application uses a dependency-free JavaScript client, an Express server, and WebSockets for synchronized gameplay.

## Features

- Live multiplayer rooms with consistent player state across clients
- Human players, automated opponents, and visitors
- Room creation, browsing, filtering, promotion, demotion, and eviction
- Automatic reconnection using a browser-tab session identifier
- Server-authoritative turns, card rules, scoring, and game completion
- Local hand sorting by value, suit, or score, committed on the next move
- Click-to-flip and pointer-based card dragging
- Mobile-first interface with tablet and desktop support
- Player-only game-start and game-end overlays
- Idle-player removal and delayed empty-room cleanup
- Health endpoint at `/health`

## Requirements

- Node.js 18 or newer
- npm

## Run locally

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

Open [http://localhost:8080](http://localhost:8080). Use a second browser or private window to test another independent session.

Development watch mode:

```bash
npm run dev
```

To select another port:

```bash
PORT=3000 npm start
```

## Test

Run the complete automated suite:

```bash
npm test
```

Run it with Node's coverage report:

```bash
npm run test:coverage
```

The suite covers cards and scoring, collections, serialization, state mapping, throttling, room membership, game rules, AI decisions, shared utilities, and error classification.

## How to play

1. Enter a name in the lobby.
2. Enter an existing room as a player or visitor, or create a room.
3. Visitors may join the game while room membership is unlocked.
4. A game may start when at least two players are seated.
5. On your turn, discard a legal card, draw, or pass when allowed.
6. Empty your hand, or play the seven of hearts, to finish the game.
7. The player or tied players with the lowest remaining hand score win.

Each player starts with seven cards. While a game is not playing, card-placement rules do not apply.

## Special cards and scores

| Card | Effect | Score |
| --- | --- | ---: |
| 2 | Makes the next player draw two; compatible draw cards may defend or stack the penalty. | 20 |
| 8 | Skips the next player. | 8 |
| Jack | Reverses direction with at least three players; skips with two players. | 11 |
| Ace, except spades | Allows the player to declare the active suit. | 14 |
| Ace of spades | Wild card and special draw defense. | 40 |
| Joker | Wild card that makes the next player draw four. | 50 |
| 7 of hearts | Ends the game immediately. | 27 |

Other standard cards use their natural rank as their score.

## Project structure

```text
public/
  html-templates/       Reusable browser component templates
  images/               Card artwork
  scripts/
    controllers/        View and overlay controllers
    utils/              Shared UI, validation, sorting, and component utilities
    ConnectionService.js WebSocket connection and browser-session state
    Constants.js         Shared actions, statuses, rules, scores, and limits
  styles/               Tokens, layout, cards, tables, and overlays
  index.html             Application page and initialized UI state
server/
  Server.js              HTTP/WebSocket transport, sessions, routing, and cleanup
  Room.js                Membership, lifecycle, turn flow, and game rules
  Player.js              Player state and automated-player decisions
  PlayerCircle.js        Circular turn ordering
  Card.js                Card identity and rule behavior
  Deck.js / Hand.js      Card collections
  StateMapper.js         Stable client-facing response shapes
  Serializable.js        Domain-model serialization
test/                    Node test suite
docs/
  software-documentation.md Detailed design and maintenance reference
```

## Documentation

See [Software documentation](docs/software-documentation.md) for the architecture, runtime flows, data contracts, action protocol, shared sources of truth, error policy, and extension guidelines.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the application server. |
| `npm run dev` | Start the server in Node watch mode. |
| `npm test` | Run all automated tests. |
| `npm run test:coverage` | Run tests with a coverage report. |

## Technology

- JavaScript ES modules
- Node.js and Express 5
- WebSockets through `ws`
- Semantic HTML and mobile-first CSS
- Node's built-in test runner

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No permission is granted to copy, modify, distribute, sublicense, or use it outside the terms provided by its owner.
