---
name: product-film
description: Make an Apple-style product film of a Tangow feature, skin or release - one 3D studio, an anonymised phone, the app's iOS screens playing live on its glass, hard cuts on the music's beats, benefit lines and an end card - rendered to MP4 with the HyperFrames CLI. Use when someone asks for a product video, a launch or reveal trailer, a feature film, "une vidéo façon pub Apple" or "un trailer". Not for explaining code, plans or architecture (technical-video-explainer, pr-motion-explainer).
---

# Product film

A 30–35 s film that sells one promise: the phone alone in a grey studio, the app's real screens playing on its glass,
object shots and screen close-ups joined by hard cuts on the beats of a licensed track, two or three benefit lines, an
end card. Start from [template/](template/): the engine renders everything; you write the film in
`template/assets/film.js` (screens, UI beats, shots) and the words in `template/index.html`.

Read before the first film: [references/craft.md](references/craft.md) (the rules, each one paid for with a rejected
cut), [references/pitfalls.md](references/pitfalls.md) (technical traps) and the reference build
[references/tangow-gris-attenue.md](references/tangow-gris-attenue.md) (the shot list and numbers of a shipped film).

## 1. Set up the project

The film never lives in this repository: work in `.tmp/product-films/<slug>/` (git-ignored) or a private folder.

```bash
cp -R .agents/skills/product-film/template .tmp/product-films/<slug>
cd .tmp/product-films/<slug> && npm install
npx --yes hyperframes@0.8.181 snapshot --at 1.5,5.5,9.8,12.5 --no-end -o snaps .
```

The example film (14.5 s) must snapshot cleanly before you change anything. The CLI renders in its own Chromium, with
the HTML-in-canvas support the screens need.

Films show bots with the clay character images from `packages/avatars/characters`: copy the `.webp` files into
the film's `assets/` like any other asset and draw them in the working line's mark.

## 2. Brief, script, words

1. Pin the promise (one sentence) and the beats the film must show, named by the user. Scenarios are plausible,
   fictional and each carries a customer benefit.
2. A **director** agent writes the shot list: for each shot object or UI, camera (yaw, elev, distance, lens), where
   the phone sits in the frame, its turn, the cut frame. Give it [craft.md](references/craft.md) as fixed rules.
3. A **copywriter** agent writes the words, in the film's language, never translated: the opening line, 2–3 benefit
   lines of 2–5 words, the end line, the availability line. The opening and the end line answer each other.

## 3. Screens

Build the product's screens with [template/assets/screen-kit.js](template/assets/screen-kit.js) on the app's tokens
(`screen-kit.css`, the "gris atténué" skin; refresh it from `@tangow/ui-tokens` when the skin changes). Use the app's
real strings. Everything the timeline animates carries a `data-part`; items that appear later start collapsed
(`height: 0; overflow: hidden; opacity: 0`) and open to `measure(el)`.

## 4. The film (`film.js`)

`runEngine({ duration, screens, screenAt, drawUI, preload, build })`. In `build(api)`, first the UI beats, then
`positions()`, then the shots:

| API | Use |
|---|---|
| `tl` | The paused GSAP timeline (seconds). UI beats are tweens on screen parts. |
| `measure(el)` / `show(name)` | Natural height of a collapsed element / lay a screen out before measuring. |
| `positions({ key: [t, el] })` | Where elements sit on the glass at time t, in cm, after the beats: frame shots on them. |
| `cut(at, shot)` | A hard cut: the whole camera state at once. Shots join on cuts. |
| `cam` | `yaw`, `elev` (deg), `dist` (cm), target `tx ty tz`, focus `fx fy fz`, `fov` (`LENS[100|85|65]`), `fstop`, `blur`, `expo`, `ui` |
| `scr.bright` | Screen brightness: 0 asleep, 1.05 on. |
| `P.yaw` | The phone's turn (a few degrees toward the lens on the last look). |
| `benefit(id, at, out)` | A benefit line beside the phone (`.b-2` lands the second half a beat later). |
| `endCard(at)` | The flat end card: mark, name, line, availability. |

Two shot types, nothing in between:

- **Object** (`ui: 0`): the phone in the room, base and shadow in frame. `elev −8…−10`, yaw ≤ 35°, 85 mm, 44–90 cm.
  Phone framed left (`tx` 3–6) when a benefit line sits on the right.
- **UI** (`ui: 1`): square to the glass, `elev 0`, yaw 3–6, 100 mm at `UI_FILL` (20.5 cm); target `ty` from `positions`.
  A tight row in shallow focus: `UI_TIGHT`, `elev −14`, `fstop 0.35`.

Light stays constant (the engine's defaults). Time passes on the screen only: sleep it (`scr.bright` → 0), switch
`screenAt`, wake it on the same frame.

## 5. Review loop

```bash
npx --yes hyperframes@0.8.181 render --quality draft --fps 30 --output out/draft.mp4 > out/render.log 2>&1
ffmpeg -i out/draft.mp4 -vf "fps=1,scale=384:-1,tile=9x4:padding=4" -frames:v 1 out/sheet.png
```

Give the sheet and 10–15 key frames to the director and a creative-director agent (criteria scored /5), with the
user's decisions as fixed constraints; apply, re-render, repeat. Then show the user the draft. The user's eye
overrides the agents. Snapshot a single frame instead of re-rendering when checking one fix
(`scripts/snapshot.sh <dir> <composition.html> <out> <t,...>` works on any composition).

## 6. Music

1. Shortlist licensed tracks (Pixabay music: free use, no attribution, no standalone redistribution) whose arc fits
   the cut: a quiet open, a build, a full section for the payoff, a clean ending. Name file, source and size and get
   the user's go before downloading. Keep it in the film project with a `CREDITS.txt`.
2. `ffmpeg -i track.mp3 -ac 2 -ar 48000 track.wav` then `python3 scripts/beats.py track.wav`: tempo, first beat, bar
   levels.
3. Pick the source offset that puts the payoff shot on the downbeat of the full section, snap every cut to the
   nearest beat (≤ 0.2 s), and take the track's last phrase under the last look and the end card.
4. `python3 scripts/music_edit.py track.wav assets/audio/film-music.wav <from-to> <from-to>`, then uncomment the
   `<audio>` in `index.html`.

## 7. Deliver

```bash
npx --yes hyperframes@0.8.181 render --quality delivery --fps 60 --output renders/<slug>-1080p60.mp4 > out/render.log 2>&1
npx --yes hyperframes@0.8.181 render --quality delivery --fps 60 --resolution 4k --output renders/<slug>-4k60.mp4 > out/render.log 2>&1
```

1080p60 takes about 20 min for 33 s, 4K60 about an hour. Check the file (`ffprobe`) and a contact sheet, send a light
copy in chat (`ffmpeg -i in.mp4 -c:v libx264 -crf 21 -preset slow -c:a aac -b:a 192k out.mp4`), keep the original in
the project. Never commit renders or licensed media.

## Checklist

- [ ] the example film snapshots before your edits
- [ ] every cut is hard; no move longer than its shot needs; ≤ 8 s of UI in a row
- [ ] one light; only the screen changes; no painted reflection
- [ ] object shots level with the floor, UI close-ups level with the screen; the phone leans back, base in frame
- [ ] words by the copywriter; benefit lines only on object shots
- [ ] cuts on beats, payoff on the downbeat; music licence noted in `CREDITS.txt`
- [ ] user approved the draft before the delivery render
