# Pick 2 — User Manual

| Document ID | Revision | Software baseline |
| --- | --- | --- |
| P2-UM | 2.0 | 2026-11-12; package version 1.0.0, working tree |

## 1. Introduction

This manual explains everyday Pick 2 play for human players and viewers. Its
procedure-oriented structure follows the user-information conventions of reference
[5] in [P2-DOC](README.md#5-references). Complete game rules belong to
[P2-SRS §4](software-requirements-specification.md#4-domain-rules); installation
belongs to [P2-OM](operations-and-maintenance.md#2-installation-and-deployment).

## 2. Open the game and choose a mode

Open the frontend in a browser with JavaScript enabled. Home's **About Pick 2 &
rooms** guide explains the directory and admission controls. Choose:

| Mode | Experience |
| --- | --- |
| Local | Play in this browser runtime; custom room seats fill with bots |
| Live | Share rooms with people and viewers connected to the configured server |

Local rooms are not shared between people/tabs. If Live connection recovery fails, use Retry
Live or select Local on Connection. A manual Local choice remains available; the
application does not silently turn a failed Live room into Local play.

## 3. Enter or leave a room

### 3.1 Create, join, and view

1. **Create:** choose Create, enter your player and room names, select available
   settings, and submit. Local mode fills open custom-room seats with bots.
2. **Join:** select a listed room, enter a unique player name, and request a seat.
   Capacity and match/Knockout state determine whether admission is available.
3. **View:** select a room to observe without taking a seat. Use Join when seating
   becomes eligible. Live Invite shares the room location with another person.

Names use letters/numbers and supported single spaces, apostrophes, or hyphens.
Players use 2–24 characters and rooms 2–48, without outside whitespace. Viewers see
public cards and hand counts, not private hands or player-only countdown/results overlays.

### 3.2 Leave

Use Leave to return Home and release membership. In Live mode, an eligible idle
human may instead become a viewer with a warning. Local mode has no automatic idle
demotion. A room that remains abandoned closes after its grace interval.

## 4. Play and read results

### 4.1 Start and take turns

1. Seat at least two players and press Start. Choose One match or Knockout.
2. Each player receives seven cards. Follow the active-player indication.
3. Drag a legal hand card onto the discard pile. Ordinary play matches suit/value,
   with special-card exceptions explained in the Room FAQ.
4. Use + to draw the allowed cards. After an ordinary draw you may still play;
   Pass ends the turn and draws any cards still owed.
5. When a legal suit-changing ace asks for a suit, select and submit it.

The authoritative game checks each action. The discard pile cannot be taken back
into your hand. Waiting-room draws/discards are preparation moves, without active
card effects. Sort changes the display order; the next Draw, Discard, or Pass
commits it. Drawing clears the temporary sort so new cards remain distinguishable.

### 4.2 Ordinary results

An empty hand or a legal seven of hearts ends play immediately. Lowest remaining
hand penalty wins, with ties sharing the result. For example, a two (20) and king
(13) leave penalty 33; an empty hand leaves zero. Use the Room FAQ or SRS scoring
reference for the full table. Other hands reveal for results and hide on continuation.
Dismissing results does not reopen them on every finished update. A later ordinary
match command resumes waiting, while Start deals a new match.

### 4.3 Knockout

Knockout runs a series. With three or more starting players, everyone tied for the
highest remaining penalty is eliminated. Qualified players continue automatically
after the wait, or a seated human can request Start sooner. Finished results remain
visible until continuation removes nonqualifiers. Eliminated humans become viewers;
sidelined bots return after the series. One survivor wins, none means a tie, and
the last two play an ordinary final that can also tie.

## 5. Connection recovery and limitations

Keep the page open during Live retry feedback. Recovery of a retained session
preserves the seat and missed updates; expiry requires normal admission again.
After retries are exhausted, Connection offers manual Retry Live or Local selection.

If a network failure makes an action's outcome uncertain, check the authoritative
room update before trying again. The application does not automatically repeat
mutations. A closed room cannot be restored by reconnecting. Closing the Local
runtime or restarting the Hosted server loses its rooms; there is no saved-game
recovery or account-backed progress.
