# Design system — Quiet

The living reference for the Quiet skin: seven token families in
`@tangow/ui-tokens`, the material layer reserved for navigation and controls,
and the named primitives in `@tangow/ui-web` that spend them. The design
contract that produced it is `docs/plans/2026-09-16-quiet-redesign.md`; this
file is what stays true afterwards.

The skin is a neutral grey ambient light behind the thread, glass on
navigation and controls, and opaque content. The light has no tint, so it
works with any bot colour.

**A screen never defines a colour, a size, a radius, a shadow or a duration by
hand. It composes tokens and primitives from `@tangow/ui-web`.** A hex, a
`text-[…]`, a `rounded-[…]`, a `shadow-[…]`, a `w-[…]` or a `duration-[…]` in a
screen is a bug: the value belongs in `packages/ui-tokens/src/index.ts`, and the
arrangement belongs in a primitive.

## Principles

- Two panes, no chrome in between: the sidebar floats over the same ambient
  background and the thread runs under it. A rounded edge never meets a
  straight one.
- Messages are bubbles, not cards. Bot prose sits on the `chatBot` paper, the
  person's words in the dark `chatUser` bubble; the thread elevates exactly one
  thing: a decision only a person can make.
- Ink everywhere. A bot's colour is its character's clay colour
  (`botDisplayColor`), used only where a surface borrows it, such as the call
  background and the Stop contour. Red is for failures only.
- Glass on navigation and controls, never on content: bubbles, cards and
  panels stay opaque.
- One elevation in the thread: the decision card. Glass is not an elevation.
  Everything else is a fill and a hairline.
- Nothing loops except the avatar of a bot that is working.
- Every visible word is UI: if it can be removed, remove it.

## Parts

Bot widgets use the shared [widget kit](../packages/core/src/widget/kit.ts) and the [widgets skill](../skills/agent/widgets).

- [Tokens](design-system/tokens.md): colour, typography, space, radii, elevation, motion, sizes and geometry.
- [Material and layout](design-system/materials.md): glass, the ambient light, the scroll edge, and where the sidebar, header, composer, panel and overlays sit.
- [Primitives](design-system/primitives.md): buttons, the framed block, option tiles, surfaces, link previews and link mentions.
- [The thread](design-system/thread.md): task cards, routine and skill lines, message rows and bubbles, grouping, interstitials, the working line.
- [Controls](design-system/controls.md): the hover pill, action sheets, the composer, settings rows, the segmented control and the switch.

## Motion rules

- One easing curve, `ease-quiet`, for every transition. A question card's movement
  is the one exception: it runs on `motion.spring` over `flight`, and everything
  in it (the answer, the card's height, the rows above, the list's scroll) starts
  and ends on the same frame. Where `linear()` easing is unknown it takes the
  reduced-motion fade.
- A thread at its end keeps to it while a card commits: a working line or reply
  that lands before the flight is carried by it, one that lands mid-flight glides
  in on the same spring, and after the landing the thread follows as for a sent
  message.
- A card never shows two copies of one answer at once: its bubble appears only
  once the old card has faded, and a newly folded line only once the question
  it answers has.
- `animate-arrive` for a message, block or capsule entering; capsules in one row
  stagger 60 ms apart.
- `rk-press` on anything pressable; `duration-(--duration-hover)` for hover.
- **Nothing loops continuously except a live clay face**: always on the bot
  page hero and in the conversation header, elsewhere only while its bot works
  and for its brief end-of-run reaction, never at 20 px and below. On web all
  live faces share one frame loop, which stops when none is left; on iPhone
  each face runs native animations that stop when it unmounts.
- `prefers-reduced-motion: reduce` stops `animate-arrive`, `rk-press`,
  `rk-press-round`, `rk-press-tile`, `rk-bar`, `rk-dot` and `rk-shimmer`, freezes every `useElapsed`
  duration and holds every live face still: no blink or glance, and an
  expression changes without a fade.
- `prefers-reduced-transparency: reduce` (Reduce Transparency on macOS and
  iOS, `AccessibilityInfo.isReduceTransparencyEnabled` on iPhone) turns every
  material opaque (see [Material](design-system/materials.md#material)). The ambient light and the layout stay.

## Accessibility

- Text that carries information is `foreground` or `mutedForeground` (≥ 4.5:1).
  `foregroundSubtle` is for the sidebar's second line and placeholders only, and
  never alone when the information matters.
- Every icon button has a translated accessible name. Primitives expose
  `aria-label` through props and never hold copy of their own.
- Logical properties everywhere (`ps-`, `pe-`, `start-`, `end-`, `border-s-`):
  the product is RTL-ready. The hover pill and the side panel sit at `end`.
- Touch targets are ≥ 44 pt on iPhone, and stacked actions 48 pt; 32 pt in
  flow is reserved for quick replies.
- Copy is English in the code, through lingui (`t` / `Trans`), then
  `pnpm --filter @tangow/web intl:extract`.

## Kitchen sink

`apps/web/e2e/fixtures/design-system.html` renders every primitive in every
state against the real compiled CSS. `apps/web/e2e/design-system.spec.ts`
asserts a few semantic facts — including that a caller's utility beats a
primitive's own class — and captures it light and dark; the screenshots are
documentary, never a pixel diff. Both need the Vite dev server, because the
fixture is served from source and is not a build entry.
`apps/web/e2e/tsconfig.json` type-checks the fixtures, and `pnpm check` in the
web app runs it as a second pass.
