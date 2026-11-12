# Pick 2

A browser shedding-card game with local bot opponents and shared rooms with WebSocket admission, gameplay, and pushed updates.
The same rules, pages, and command protocol support both connection modes.

## Run

Use Node.js 22 and npm:

```sh
npm ci
npm start
```

Open [http://localhost:8080](http://localhost:8080). Use `npm run dev` for watch mode.

| Mode | Behavior |
| --- | --- |
| Local (Direct) | A Host runs in the browser; custom rooms fill open seats with bots. |
| Live (Hosted) | A Node Host shares rooms between connected players and viewers. |

The public `config.js` module selects the default Hosted endpoint; its shipped value
is `http://localhost:8080`. For Node deployments, override it without editing source:

```sh
GAME_SERVER_ORIGIN=https://live.example.com WS_ALLOWED_ORIGINS=https://game.example.com npm start
```

Use `GAME_SERVER_ORIGIN='' npm start` to default to Local mode. For a separately
hosted static frontend, deploy a replacement `config.js` containing
`export const configuration = { hostedOrigin: "https://live.example.com" };`.
An empty `hostedOrigin` selects Local mode. This module is public: never put secrets
in it. The frontend does not infer the API endpoint from its page address.

Exhausted Live retries open connection recovery with Retry Live and Local options.
Static hosting supports Local play without Node; Live play requires a reachable
Hosted server and its allowed frontend origin. The Node server exposes only browser
assets and required Local-play modules, not repository documentation, tests, or
server source.

Hosted mode uses `/live` for all commands. HTTP serves browser assets, deployment
config, and `/health` only. Deploy the version-2 browser/server protocol together;
former `API_*` environment settings must be renamed to `WS_*` as documented in the
operations guide (command budget: `WS_MAX_COMMANDS_PER_WINDOW`).

## Play

Create a room, join an available seat, or watch as a viewer. With at least two
players, Start offers one match or Knockout. Each player receives seven cards;
legal discards, draws, special cards, and suit declarations advance play.
The lowest remaining hand penalty wins. Knockout eliminates the highest-penalty
players across matches before a final two-player match.

Home's **About Pick 2 & rooms** guide explains admission and connection modes.
The Room FAQ explains play, special cards, scoring, and Knockout.
Rooms are held in memory: Local rooms end with the page runtime, and Live rooms
end with the server process. There is no database or account system.

## Documentation

- [Documentation index](docs/README.md)
- [Software requirements specification](docs/software-requirements-specification.md)
- [Software design description](docs/software-design-description.md)
- [Interface control document](docs/interface-control-document.md)
- [Verification and validation plan](docs/verification-and-validation-plan.md)
- [Operations and maintenance](docs/operations-and-maintenance.md)
- [User manual](docs/user-manual.md)

## Verify

```sh
npm test
npm run test:coverage
```

The full suite includes temporary localhost servers and requires local socket
permission. See the verification and validation plan for focused commands and browser acceptance.

GitHub Actions runs `npm ci` and `npm test` on pushes and pull requests using
Node.js 22. Keep `package-lock.json` alongside intentional dependency changes.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No permission
is granted to copy, modify, distribute, sublicense, or use it outside the terms
provided by its owner.
