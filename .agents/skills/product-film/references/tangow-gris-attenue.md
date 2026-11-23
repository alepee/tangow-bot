# Reference build: tangow, "gris atténué" (October 2026)

The film this skill was extracted from: the reveal of the "gris atténué" skin on iOS, 33.5 s, 1080p60. Internal film,
fictional content. Read it before your first film for the numbers; reuse the method, not the scenes.

## Brief

- Promise: things get done proactively without ordering bots around; when you step in, the interface is a pleasure.
- Beats to show without naming them: stacked questions to the user, a routine created on request, a media link preview,
  the bot's working statuses, a proactive moment (it read the email, drafted a doc and a reply), avatars alive.

## The cut

Cuts sit on the music's beats (160 BPM, beats at −0.771 + 0.375·k film time). Camera values are the template's
(phone-local yaw/elev in degrees, distance in cm, 85 mm unless noted).

| Time | Shot | Type | Camera | What happens |
|---|---|---|---|---|
| 0–2.23 | S1 | object | yaw 40→34, elev −8→−9, 82→76, phone at 64% of the width | Dark screen with the working line; fade up by exposure; "Before you open it." |
| 2.23 | S2 | UI | 100 mm, yaw 6, elev 0, 19→17 | "Stepping into Gmail" → "Stepping into Google Calendar", counter from ~0 s |
| 4.85 | S3 | UI | same shot | The app opens: "Morning inbox", Ines's feedback sorted into a doc, reply drafted |
| 7.48 | S4 | object close | yaw −30→−24, elev −8, 44→37, phone left | The decision card, "Allow once" tapped at 10.0; "Done for you. / Sent by you." |
| 10.85 | S6 | object | 65 mm, yaw −28→−22, elev −4, 58→54, phone left | Evening, dark mode: the interface's five layers lift off the glass, a beat apart; "Calm, even at night." |
| 13.48 | S7 | UI | 100 mm, yaw 4 | Her request, "Writing a reply" |
| 15.0 | S8a | UI | same | Q1 "How long to cook?" |
| 16.10 | S8b | UI tight | elev −14, UI_TIGHT, f/0.35 | Q2, the "No nuts · Recommended · Theo's allergy" row in shallow focus |
| 18.35 | S8c | UI | elev 0, yaw 3 | Q3, the fold into "Time · Diet · Day", the "Weekly dinners" card |
| 21.35 | S9 | object, static | yaw 32, elev −10, 78, phone right of centre | The phone at rest in dark mode; the screen sleeps |
| 22.10 | S10a | same frame | — | Time cut: it wakes in light mode on Sunday 17:00, already "Searching the web"; "Ask once. / Every Sunday, handled." |
| 23.60 | S10b | UI | yaw 6, elev 0, 30→28 | The result lands on the track's downbeat: five dinners, the article preview with a photo |
| 25.85 | S11 | object | yaw −42→−38, elev −9, 88→80, phone turns 6° to the lens | The last look |
| 28.85 | Card | — | — | tangow / "Worth opening." / "For iPhone and Mac.", the ink avatar blinks once |

## Pieces worth reusing

- **The time cut** (S9 → S10a): same camera, same phone; only the screen sleeps and wakes on another day. It says
  "proactive" without a word and keeps the room constant.
- **The Rise** (S6): the screen cloned five times into extra layoutsubtree canvases, each clone showing one level of
  the UI (`data-part` groups: ambient + status + nav buttons, earlier messages, her request, nav title + composer,
  the header avatar), drawn on rounded-rect meshes just above the glass and lifted 0 / 0.4 / 0.8 / 1.0 / 1.6 cm, scaled
  `1 − 0.06 · lift` so nothing leaves the silhouette. The base screen is turned off while the layers are up.
- **The avatar**: the clay character images from `packages/avatars/characters`, copied into the film's assets. The end card's mark is ink.
- **The working line's label swap**: the new label takes the layout while both labels are invisible, so the counter
  moves past it instead of overlapping.

## Copy

Written by a copywriter agent, in English: "Before you open it." · "Done for you. Sent by you." · "Calm, even at night."
· "Ask once. Every Sunday, handled." · "Worth opening." · "For iPhone and Mac." The product strings on screen are the
app's real ones ("Allow once", "Writing a reply", "Stepping into Gmail").

## Music

"Abstract Percussion" by The_Mountain (Pixabay licence), chosen for its claps and a main-title arc (silence, build,
full section, decay). Edit: source 1.05–26.904 s under the film's 0–25.854 s, so the Sunday result (23.604) lands on
the full section's downbeat (24.654); then the track's last phrase from the bar at 38.154 under the last look and the
card. Not in this repository: fetch it per project.

## What was rejected, and why

| Tried | Verdict |
|---|---|
| 2D screens composited over a 3D phone, background colour changes between scenes | "Not Apple grade": no move on the object, no dive into the screen. Led to the single 3D room. |
| A day falling into night, a hard Sunday sun | Changing the background "adds nothing": one light, only the screen changes. |
| Painted glint bands sweeping the glass | Cheap. Replaced by the glass mirroring the room. |
| The avatar stepping out of the screen and becoming the logo | Cheap. Replaced by a last look and a hard cut to the card. |
| A phone floating and tilted toward the viewer; a camera locked to the phone's up | Unnatural: the phone now leans back, the camera is level with the floor (and with the screen on close-ups). |
| A working line counting 15–17 s at the opening | Not selling: counters start near zero. |
| Slow transitional moves, pull-outs to the whole phone between UI sequences | Too slow: hard cuts, a punchier 33 s edit. |
| A 9:16 cut and a 15 s teaser derived from the master's timeline | Not good enough; the master alone shipped. Shoot cutdowns as their own edits if you need them. |
