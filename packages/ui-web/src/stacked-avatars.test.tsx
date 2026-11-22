import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StackedAvatars } from "./stacked-avatars.js";

const BOTS = Array.from({ length: 5 }, (_, index) => ({ identity: `bot-${index}` }));

describe("StackedAvatars", () => {
  it("overlaps the avatars of a group", () => {
    const html = renderToString(<StackedAvatars items={BOTS.slice(0, 2)} size={20} />);

    expect(html).toContain('data-slot="stacked-avatars"');
    expect(html).toContain('data-size="20"');
    expect(html).toContain("margin-inline-start:-5px");
    expect(html).not.toContain('data-slot="stacked-avatars-overflow"');
  });

  it("uses a tighter overlap at the smaller sizes", () => {
    expect(renderToString(<StackedAvatars items={BOTS.slice(0, 2)} size={14} />)).toContain(
      "margin-inline-start:-3px",
    );
    expect(renderToString(<StackedAvatars items={BOTS.slice(0, 2)} size={17} />)).toContain(
      "margin-inline-start:-4px",
    );
  });

  it("collapses the rest into +N", () => {
    const html = renderToString(<StackedAvatars items={BOTS} size={20} />);

    expect(html).toContain('data-slot="stacked-avatars-overflow"');
    expect(html).toContain("+2");
    expect(html).toContain("text-label");
  });

  it("marks a working bot on its avatar", () => {
    const html = renderToString(
      <StackedAvatars items={[{ identity: "bot-0", working: true }]} size={20} />,
    );
    expect(html).toContain('data-working="true"');
  });

  it("is decoration unless it is given a name", () => {
    // Only the wrapper's own attributes matter; the avatars inside carry their own.
    const rootTag = (html: string) =>
      html.match(/<span data-slot="stacked-avatars"[^>]*>/)?.[0] ?? "";

    const bare = rootTag(renderToString(<StackedAvatars items={BOTS.slice(0, 2)} size={20} />));
    expect(bare).toContain('aria-hidden="true"');
    expect(bare).not.toContain('role="img"');

    const named = rootTag(
      renderToString(<StackedAvatars items={BOTS.slice(0, 2)} size={20} label="Maya and Atlas" />),
    );
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Maya and Atlas"');
    expect(named).not.toContain("aria-hidden");
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(
      <StackedAvatars items={BOTS.slice(0, 2)} size={20} data-testid="group-avatars" />,
    );
    expect(html).toContain('data-testid="group-avatars"');
  });
});
