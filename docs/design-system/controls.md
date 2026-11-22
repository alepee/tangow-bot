# Design system: Controls

Part of the [design system](../design-system.md).

Floating actions, sheets, the composer and settings controls. The shared rules are in [Primitives](primitives.md).

## HoverPill

Message actions, absent until the row is hovered or focused from the
keyboard: the `control` material, `rounded-full`, 36 high with 2 px padding,
`opacity-0 pointer-events-none` at rest — `group-hover` and a `:focus-visible`
inside the row reveal it over `--duration-hover` (a click that leaves focus on a button
does not pin it). It is for a bot's message only:
your own message gets bare Edit and resend / Copy icons under its bubble on
hover instead (`UserMessageActions`), and a routine's message or failure line,
whose name opens its run, gets none. It sits next to the bubble it acts on, on the side facing the
thread's centre, when the bubble leaves room; otherwise at the row's top
`end` corner. The row measures this on enter and focus
(`hover-pill-placement.ts`) and hands it over as `data-pill="beside"` with
`--pill-x` / `--pill-y`. A bubble's time rides in the pill, ahead of the
actions. A touch pointer never hovers, so the
pill never appears there at all: touch reaches a message's actions through
`ActionSheet` instead (long press on the bubble, see below), not through a
coarse-pointer variant of this primitive.

Props: `children` — the message's time (`text-time`, muted) then 32 px round
buttons, each with its own `aria-label`: Reply, React, Copy, Speak/Stop
(`message-hover-actions.tsx`).

Do: put it in `MessageRow`'s `trailing` slot. Don't: reveal it on click, or
anchor it to `right`.

Used by: Reply, React, Copy, Speak, Edit and resend, and More on a message.

## ActionSheet

A bottom-anchored action sheet, touch's own way into a message's actions —
opened by a 450 ms long press on a bubble (`transcript.tsx`), never by a tap.
Built on the same Base UI `Dialog` as the centered `Dialog` primitive, so
Escape, a backdrop click, and focus trapping come for free; this primitive
adds the bottom anchoring, the slide-up entrance and the drag-to-dismiss
gesture. Anatomy: full width, `max-w-thread` on larger screens, `rounded-t-block`,
a grab handle, a screen-reader-only `Dialog.Title` (the sheet shows no visible
heading). Dragging the handle down past 80 px (or a fast flick short of it)
closes it; short of that it snaps back. Entrance slides up over
`--duration-arrive`; under reduced motion it only fades in, never slides.

Props: `open`, `onOpenChange`, `title` (screen-reader only), `children`.

While held, the bubble itself settles to `scale(0.96)` after 150 ms
(`data-long-pressing="true"` on the row, a CSS rule scoped to
`[data-slot="message-row-bubble"]`/`[data-slot="user-bubble"]`, no transform
under reduced motion), and `-webkit-touch-callout: none` on both bubble slots
keeps iOS's own long-press callout from competing with the sheet opening
under it.

Used by: `message-actions-sheet.tsx` — the same quick reactions and action
handlers as `HoverPill`'s, reused rather than duplicated
(`message-actions.ts`), so touch and pointer never drift on what a message
allows.

## ComposerShell

The capsule floating at the bottom of the thread, the thread running under it:
the `control` material in `rounded-composer`, its edge `shadow-composer-rest`
lifting to `shadow-composer-focus` on `:focus-within`, never a separate focus
ring layered on top. Bottom-aligned (`items-end`) so its buttons stay on the last line
while the field grows; at least `min-h-12` (48 px) even empty.

Props: `attach?` (the attach button — the capsule's **leading edge**, before
the field: `+ · text · [mic] · action(s)`; picked mentions and skills sit
inline in the text, see [EntityMention](primitives.md#entitymention)), `leading?`
(the speaking bot's avatar), `children` (the field),
`trailing?` (round-icon buttons: dictate, then send / stop), `attachments?` (a
row of `ComposerAttachment`, rendered **above** the input line, inside the
capsule — pending attachments and rewind artifacts both land here, wrapping on
web), `state?: idle | typing | dictating | speaking`.

**Dictation mode** (`state="dictating"`): the capsule swaps its ambient
`shadow-composer-rest`/`-focus` for a 1.5 px `foreground` ring (`+` stays in
place, just inactive — the caller disables them). Two new props
draw a row **under** the field: `dictationCancel?` (×, start) and
`dictationConfirm?` (✓ — plus Stop when a reply is running — end), with this
component's own four bars in between as the waveform (`data-slot="composer-
dictating"`, `aria-hidden`, 3 × 14, reused unchanged from before dictation
existed). Only drawn together with the row when `state="dictating"`. The
field itself is the caller's job: `apps/web/src/pages/shell/composer.tsx`
swaps its `<textarea>` for a read-only preview `<div>` while dictating (a
textarea can't style a range), showing the pre-dictation draft plus each
dictated word fading/blurring in over 260 ms (`rk-word-in`, off under reduced
motion) and the not-yet-final tail in `mutedForeground`. The `speaking` beat
is composed from the slots, so its label stays translatable.

**Removed**: the `working` state and its three dots — a run in
progress is now carried by the Stop button's own contour (`StopContour`), not
by chrome inside the capsule.

Do: show Send only when the draft is non-empty; put the attach
button in `attach`, never in `trailing`; dictation and the call never fight
over the composer — the call moved to the thread header (a phone icon labelled `Voice`, 1:1
only; the mic always means dictation) and cancels a dictation in progress before it opens. Don't: put a second
shadow inside the capsule, reach for `state="working"` (removed), or let
dictation send anything itself — ✓ only inserts into the draft.

Used by: the thread composer (`apps/web/src/pages/shell/composer.tsx`); the
call button lives in `apps/web/src/pages/shell/thread-header.tsx` instead.

## ComposerAttachment

A pending attachment, or a rewind artifact, inside the composer's
`attachments` slot: an image thumbnail, or a file tile with a paperclip and a
truncated name, each carrying a × disc.

Props: `name` (alt text, or the file tile's truncated label), `previewUrl?`
(present → thumbnail; absent → file tile), `removeLabel` (the caller's
translated "Remove {name}"), `onRemove?`, `disabled?` (× inert while
dictating — the attachment itself stays visible and unchanged). Anatomy: `size-composer-attachment-thumb`
(64 px) `rounded-card` thumbnail, or a `bg-secondary` `rounded-card` tile
capped at `max-w-composer-attachment-tile` (200 px) with a truncated name; the
× is a `size-composer-remove` (22 px) `bg-primary` disc with a `border-surface`
ring, absolutely positioned at the top end corner.

Do: use it for both `pendingAttachments` and `rewindArtifacts` — never a plain
pill above the composer. Don't: let a long file name widen the tile; it
truncates instead.

Used by: the thread composer's `attachments` slot.

## StopContour

The Stop button's own edge: the contour **is** the rim
of the disc, not a ring drawn outside it — two glows of the responding bot's
colour chase each other around a 2 px ring, one lap per `--duration-flow`
(2.6 s), while the disc (`bg-primary`) sits at `inset-0.5` and a small
`bg-primary-foreground` square marks the button underneath. No head, no
accessible name — it fills a `roundIcon` button that already has one.

Props: `color?` — the bot's colour (`botDisplayColor`) as a plain CSS colour string
(data, not a token; carried as the inline custom property `--contour`). Omit it in a group, or when no bot is
known: the contour falls back to `color-mix(in srgb, var(--foreground) 45%,
transparent)`. Reduced motion: the ring holds still, fully lit, no rotation.

Do: pass the room's single bot's colour when there is one. Don't: give it an
`aria-label` — the wrapping button owns "Stop".

Used by: the thread composer's Stop button, while a run is going.

## ReasoningDisclosure

What the bot thought, folded away until someone asks.

Props: `summary` ("Thought for 41s · 4 steps", translated by the caller),
`open`, `onToggle`, `children` (one node per step), `live?`, `toggleProps?`. The
toggle is a `button` with `aria-expanded` and, once open, an `aria-controls`
pointing at the panel; the open panel rails the steps behind a logical
`border-s` and shimmers the **last** step while `live`. `toggleProps` lands on
the toggle, which is where a screen puts its testid. A summary reads a finished
total through `formatShortDuration` (`41s`, `2m 04s`), not the running
`formatElapsed` clock of `WorkingLine`.

Do: keep the existing "Display agent steps" setting in charge of whether it
renders at all. Don't: animate the steps while they arrive — the shimmer is the
only live signal.

Used by: the `steps` block of a message.

## Shimmer

A light sweep across a label that is still being written, as the `rk-shimmer`
class. Ported from beautifului.dev
(github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).

## BotAvatar

A bot's clay character in a round disc: the catalogue image (`characterById`,
neutral Scout when the character is missing or unknown) cropped by size, on the
`bg-muted` disc on web and the `avatarDisc` veil on iPhone. Sizes up to 20 px
use the mini image. Above 20 px, the face comes alive over the faceless body
(`ClayFace`) while the bot works and for two seconds after a run it saw
complete or fail; `live` keeps it alive at rest too, on the bot page hero and
in the conversation header. It is the still image otherwise, and until the body
is loaded. `data-working` marks a working bot on web; on iPhone the avatar of a
working bot reads "Working" to VoiceOver. The iPhone face moves on the native
driver: its paths are drawn again only when the expression changes, and gaze,
blinks and mouth motions are transforms of round clipped layers.

Props: `character?`, `size?`, `status?`, `live?`. It carries no accessible
name: the name beside it does.

## SettingRow

One line of a settings list: `text-row-name` label, an optional `text-row-status`
sub-line, then on the trailing side a `meta` slot (a `SaveMeta`), a control or a
value, and an optional chevron. It is sized and inset for a settings group (at
least 50px tall, its label in line with the group's hairlines), so a caller passes
no row classes. Static by default; `onClick` makes it a button
with a hover fill and a focus ring, which carries a sub-line and a chevron, never a
control or a `SaveMeta`, which would nest an interactive element inside another.

Props: `label`, `leading?` (an avatar or a dot ahead of the label), `subline?`,
`value?` (a read-only figure on the trailing side, right-aligned in tabular
numbers, which a pressable row may carry), `meta?`, `children?` (the trailing
control; neither on a pressable row, which the type refuses), `chevron?`.

## ShareBar

A thin full-capsule bar split in proportion to its segments, over a `muted`
track: `h-share-bar` (8 px), segments a hairline apart. A segment takes a bot's
colour when given one; otherwise segments take the ink ramp in order
(`foreground`, `mutedForeground`, `foregroundSubtle`, `input`) and every
segment after the third merges into one `input` segment. Decorative
(`aria-hidden`): the list beside it carries the numbers, and `shareBarInk(index)`
gives a row's dot the class of its segment.

Props: `segments` (`{ key, value, color? }`, heaviest first).

Used by: the usage settings.

## SegmentedControl

A choice of one value among a few, side by side in a full capsule: a `muted`
track with 3 px padding, the chosen segment a raised capsule (`surface` in
light, `optionRing` in dark) on a `0 1px 2px` drop. Choosing the current value
again does nothing. Segmented tabs use the same look through
`<TabsList variant="segmented">`, so a tab bar and a setting choice never draw
the pill by hand.

Props: `value`, `options` (`{ value, label }`), `onValueChange`, `disabled?`,
`aria-label?`.

## Switch

An on/off setting in ink, on web and iPhone: the on-track is `foreground` in
light and `mutedForeground` in dark, the knob white. Don't: a green track.

## SaveMeta

The only proof an automatic save happened: "Saving…" while the call runs,
"Saved 14:02" for the three seconds the save store keeps that state (the time
through `Intl.DateTimeFormat`, hour and minute in the device locale), and
"Could not save · Retry" until a save succeeds. At rest it is empty, never
permanent chrome. The root is always mounted as an `aria-live="polite"` region
so each change is announced.

Props: `state` (a `FieldSaveState` from `@tangow/core`), `labels` (`saving`,
`saved`, `failed`, `retry`, already translated), `onRetry?`, `locale?`.

## TextSettingField

A text setting that saves itself, over `useFieldSave` and the `SaveStore` that
`SaveStoreProvider` hands down (created once at the composition root, in
memory only: nothing here reaches `localStorage`, `sessionStorage` or
IndexedDB). Typing is local. Leaving the field commits the trimmed text
through the hook when it changed; Escape drops the edit and keeps focus (and
reaches the panel only when there was no edit to drop); Enter leaves a
single-line field. An emptied `required` field puts its old value back, and an
emptied field with an `onConfirmClear` callback asks first. `keepDraft` keeps
unsaved text in the store for the session; when the server value moved under
it, the field shows the server value and offers `labels.restore`. A failed save
keeps the typed text and shows "Could not save · Retry".

Props: `label`, `field` (from `useFieldSave`), `labels` (the `SaveMetaLabels`
plus `restore?`), `multiline?`, `rows?`, `required?`, `onConfirmClear?`,
`keepDraft?`, `locale?`, `counter?` ("n / max" beside the meta; needs
`maxLength`), `meta?` (false when the caller shows the `SaveMeta` elsewhere).
`className` styles the wrapper, `controlClassName` the input or textarea and
`labelClassName` the row that holds the label and the meta; the other native
props land on the input or textarea.
