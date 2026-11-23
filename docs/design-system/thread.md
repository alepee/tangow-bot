# Design system: The thread

Part of the [design system](../design-system.md).

The thread's own elements: work cards, routine and skill lines, messages and their grouping. The shared rules are in [Primitives](primitives.md).

## Task card

A delegated task's result on `Surface variant="outlined"`, full column width: a
`doc.text` glyph in ink, the title (announced as a header), the brief in `meta`
on two lines, a `border` hairline, then the result. The whole card is one
target and opens the brief and result whole in a sheet; a long result fades
out under the expand badge. A finished task shows no status word; running,
failed and cancelled show a status symbol (`circle.dotted`, `xmark.circle.fill`
in `destructive`, `stop.circle`) and word under the title.

Web and desktop share this exactly: `apps/web/src/components/TaskCard.tsx`
exports `TaskCardSurface` (the visual card alone, `lucide-react`'s `FileText`
glyph) and `TaskCard` (the whole card as a button that opens a `ui-web`
`Dialog` with the brief and result).

## Routine run line

A routine run shows only when it has something to say or failed. A run that
ended with words is the bot's message: a bot bubble whose markdown never loads
remote images, with the routine's name above it as the `OriginLabel` that
opens the run. A silent, queued, running or cancelled run draws nothing.

A failed run is a log line, not a card: no box, a 44 pt row with
`xmark.circle.fill` in `destructive`, the routine's name (`rowName` 500, never
truncated) and, muted, the reason in plain words ("No model connected",
"Computer unavailable", "Model error"). Consecutive failures of one routine
fold onto the newest, which adds "# failures since <time>" (`time`, tabular,
with the weekday when the first failed on another day) and opens the newest
failed run. Hidden runs do not break a fold; anything shown between two
failures does. Between two failure lines a time marker only says the day, when
it changes, and they stack with no gap; a message keeps the thread's spacing.

`packages/core/src/routine-roles.ts` is the one `routineRoles` both mobile and
web read from: a `message` or `failures` role per shown run and the runs it
hides, with the failure kind
classified by the core, never the raw error. Web renders the message in
`thread-row.tsx` and the line as `RoutineFailureLine` in
`apps/web/src/pages/shell/routine-run-line.tsx`, with `lucide-react`'s
`CircleX`.

## A skill in the conversation

A skill a bot learns, improves or deletes draws one line per skill under the
bot's message: `BookOpen` and "Skill learned · <name>", "Skill updated · <name>"
or "Skill deleted · <name>", the `meta` of `MessageBubble`. It opens the skill
in the bot page's Knowledge tab, or the list when the skill is gone or not the
reader's. A "Skill deleted" line names the skill without a link, on web and
iPhone, as does any line in a group on web, since a group has no bot page. A message with no text draws the line alone through `MessageMeta`.
A line that arrives live rises (`rk-arrive`) and its icon pops (`bui-pop-in`),
both over `--duration-arrive`, half of it late, as on iPhone; a line in loaded
history is still, and reduced motion stills both. The `skill_source` block
carries the skill; `skillSourcesOf` in `packages/core/src/skill-source.ts` reads
it.

## A skill on iPhone

On iPhone a skill line opens the skill's own screen: its SKILL.md, edited like a
memory document, and Delete under the header's `⋯`. The field holds a draft only
while it is edited, so it never shows a text the server no longer has. A refusal
reads as the server's sentence only for a conflict or a bad request, else as
what failed ("Could not delete skill").

## Clipped preview

Content cut to a height (a routine report at eight lines, a task result at
five) fades into its host over 56 pt, with a 28 pt round expand badge
(`arrow.up.left.and.arrow.down.right`, `secondary` fill, `outline` ring) on the
fade, bottom right. The badge only marks it: the whole preview is the target
and opens the rest in a sheet. Content that fits is never cut.

`packages/ui-web/src/clipped-preview.tsx` is the web primitive: `ClippedPreview`
estimates from the raw text whether it is worth cutting, fades to a caller-given
`fadeFrom` token and opens a `Dialog` on click. Its `onOpen` is optional — when
an ancestor already opens the whole card (a `TaskCard`), it stays decoration
only, since a native `<button>` cannot nest another one.

## MessageRow

The scaffold around a bot message: who is speaking, never a fill of its own.

Props: `avatar`, `author`, `children`, `trailing?`, `showAuthor?`,
`showAvatar?`, `hasAvatarColumn?`. Messages are grouped by `computeMessageGroups`
(`packages/core/src/message-grouping.ts`, see Grouping). In a group thread the
author (`text-author`, inset 16 so it lines up with the bubble text) heads the
first message of a group and the avatar (`w-message`, bottom-aligned) sits at
the foot of the last one; the other rows keep the avatar column empty so every
bubble shares one edge, 8 from the avatar. A single-bot thread passes
`hasAvatarColumn={false}`: no name, no avatar, no gutter — the header already
says who this is. No row carries a permanent time; web reveals it on hover or
focus. The root is `group relative`, which reveals a `HoverPill` passed as
`trailing`.

The native mirror (`apps/mobile/components/message-row.tsx`) has the same
props with a `mono` flag.

Used by: every bot message in the thread, cards included.

## MessageBubble

What a bot said: `bg-chat-bot rounded-bubble shadow-bubble`, 12 × 16 padding
(11 × 16 on iPhone), fitting its content up to 82% of the thread (single bot)
or 88% of the column (`inGroup`).
`meta?: Line | Line[]`, with `Line = { label, icon?, onClick?, className? }`,
draws the proof lines inside the bubble, under the text, stacked left, one per
line in `text-meta` `mutedForeground` with a 14 px leading `icon` and a chevron
when it opens something. A label truncates to one line. A line with an
`onClick` is a link (`role="link"`, as on iPhone) named by its label; the icon is
decorative. `MessageMeta`
draws the same lines on their own, at the bubble's 16 px inset with no bubble,
for a message that is only lines. A bot's own markdown never reaches this slot,
so text that looks like a line is not one. Its `data-slot="message-row-bubble"`
scopes the markdown rules for a bubble: code on `background`, tables without a
surface, their hairlines running edge to edge.

One message is one bubble: never split a message by paragraph. Agent steps sit
above the bubble, unfilled.

A link in a bubble, bot's or person's, is ink: the bubble's text colour, underlined 1 px at
0.2em, as a 35% veil of that ink in a bot bubble and 45% in the person's, solid on hover
(web). There is no link colour token.

The native mirror is `apps/mobile/components/bot-bubble.tsx`. It caps its width
with a number computed from the window: a bubble that fits its content has no
definite width, so a percentage (its own, or the markdown's `100%`) measures the
text wider than it draws and clips the last line.

Used by: bot narration (text and progress).

## UserBubble

What the person said: `bg-chat-user` (ink in light, tone on tone in dark),
`text-chat-user-foreground`, `rounded-bubble`, 12 × 16 padding (11 × 16 on
iPhone), `whitespace-pre-wrap`, at most 78% of the column, aligned to the end edge. The
dark fill is the person's alone: a bot never gets it, not even in a
conversation between bots.

Used by: user messages.

## UserAvatar

The person, wherever they appear without a photo: their initials on
`bg-chat-user` with `text-chat-user-foreground`, the colour of their own
bubbles, in a round disc. A photo, when set, fills the disc instead, and the
initials come back if it fails to load. Props: `initials`, `image?`; size it
through `className` (`size-6 text-label` in the sidebar, `size-14 text-title`
in account settings) or `style`. Mobile mirrors it in
`apps/mobile/components/user-avatar.tsx` with `size` and `fontSize?` props.

Don't: draw initials on `accent` or `muted` — in dark mode those sit a shade
from the sidebar and the disc disappears.

Used by: the sidebar account menu, account settings, the user half of a
one-bot `GroupAvatar`, the mobile home header and account screen.

## Grouping

Consecutive messages from one author form a group: 3 between their bubbles, 14
between groups, 0 between two consecutive asides. A group breaks on a new
author, a time marker, more than five minutes, a reply, an aside (handoff, bot
message markers) and any card, which is always a group of its own.
`computeMessageGroups` is the one source of truth for web and mobile; call it
once per list, on the chronological messages, and read its result by id.

## Interstitial

A handoff between two bots, centred between messages and quiet enough to skip.

Props: `avatars` (usually a `StackedAvatars` at 17), `children`, `onClick?`. It
is a `div` until `onClick` makes it a `button` that fades on hover.

A marker cuts the bubble group around it; consecutive markers stack with no
gap. A handoff reads as a centred line between two 28 × 1 hairlines.

Used by: `bot.message.sent`, `bot.message.received` and `handoff` entries.

## StackedAvatars

The bots behind a group, a delegation or a receipt, in one glance.

Props: `items: { identity?, working?, character? }[]`, `size: 14 | 16 |
17 | 20` (native adds 28 for a header, with a round `+n` pill), `max?` (default 3), `label?`. Composes `BotAvatar`; each avatar after
the first slides under the previous one by 5, 4 or 3 px depending on the size,
and the rest collapse into `+N` in `text-label`. With a `label` the stack is a
`role="img"` carrying that name; without one it is `aria-hidden`, which is right
whenever the sentence beside it already names the bots.

Do: keep `max` at 3 in a header. Don't: reach for it at 26 or above — that is a
single `BotAvatar`.

Used by: the thread header, interstitials, mobile headers.

## WorkingLine

The only thing that moves while a bot works: a working avatar, what it is doing
in `text-working`, and the elapsed time in `font-mono text-mono tabular-nums`.

Props: `avatar?`, `label`, `startedAt?`. The root is a `role="status"` region;
the duration is `aria-hidden` so a screen reader hears the sentence once
instead of every tenth of a second. The tick comes from `useElapsed`, exported
from the same package and shared with the loading states in
`apps/web/src/components/ai/`: under reduced motion it freezes at its first
reading, so nothing animates a number at someone who asked for stillness.
`avatar` is optional: omit it (as the reconnect and update-progress loading
states do — there is no bot) and the reserved avatar column disappears too,
instead of leaving a blank 26 px gap.

Used by: the bottom of the web thread during a run. Mobile shows a typing
bubble instead (`apps/mobile/components/typing-bubble.tsx`): three pulsing dots
in a `chatBot` bubble, or the live activity line in `Shimmer` when one bot is
working and its activity is known.
