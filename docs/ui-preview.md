# Preview Home and Room without JavaScript

Open `index.html` or `room.html` in a browser with JavaScript disabled, or temporarily remove the final module script tag in a local copy. CSS and card images work without a server. Make changes to the HTML attributes and reload the page.

Set `data-ui-preview="true"` on `<body>` to show sample rooms, opponents, cards, and results. These fixtures are marked with the `ui-fixture` class. The running application disables preview mode and removes fixtures before starting a session, so samples never become live game data.

| Element | Attribute | Values / effect |
| --- | --- | --- |
| Home / Room header connection aside; Connection page `#site-shell` | `data-connection-status` | `connecting`, `reconnecting`, `connected`, `disconnected`, `error`, `unconfigured`; colors, labels, and ripples |
| Room `#site-shell` | `data-connection-mode` | `direct` (Local), `hosted` (Live); Room connection label, Invite visibility (Live only), and idle warning (`direct` hides the warning) |
| Home radio inputs | `checked` | Move this native HTML attribute between Local / Live or Create / Join |
| `#list-panel` | `data-directory-state` | `populated` for sample rooms, `empty` for the empty message |
| Room table cells | `data-name`, `data-state`, count attributes | Names, waiting / active / finished states, and table values |
| `#room-view` | `data-membership` | `player` shows the hand and three-row game layout; `viewer` hides the hand and uses two rows. Join is available only to viewers. |
| `#player-commands` | `data-match-state` | `waiting`, `active`, `finished`; Start / Pass visibility |
| Player regions | `data-player-state` | `ready`, `active`, `won`, `lost`, `qualified`, `eliminated`; player accents and badges |
| Player outputs | `data-player-name`, `data-item-count`, `data-draw-allowance`, `data-idle-seconds` | Identity, counts, and warning text |
| `playing-card` | `data-value`, `data-suit`, `data-is-face-up` | Card faces and backs; keep the `.playing-card-center` child for static rendering |
| Dialogs except Play | `hidden` | Remove to preview the overlay; add to close it |
| `#play-dialog` | `data-state` | `open` / `closed` |
| Alert dialog | `data-status` | `info`, `warning`, `error`, `success`; accent colors |
| Result rows | `data-player-state`, `aria-selected` | `won` highlights the winner; `aria-selected="true"` highlights the selected row |

For a seated player preview, set `body[data-ui-preview="true"]` and `#room-view[data-membership="player"]`. Set the match to `active` and the local player to `active` for a turn preview. Remove `hidden` from `#results-dialog` to inspect sample results.

Keep one overlay open at a time. Static preview checks layout, colors, visibility, and CSS animation; network retries, game rules, clicks, drag behavior, and timers still require the running application.

Unique UI elements use IDs (such as `#alert-icon`, `#connection-local-label`, and `#suit-hearts`). Classes group repeated elements such as cards, player regions, dialog panels, and preview fixtures.
