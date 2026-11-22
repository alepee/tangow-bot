import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Interstitial } from "./interstitial.js";
import { StackedAvatars } from "./stacked-avatars.js";

describe("Interstitial", () => {
  it("centres a quiet handoff line", () => {
    const html = renderToString(
      <Interstitial avatars={<StackedAvatars items={[{ identity: "maya" }]} size={17} />}>
        Maya asked GitHub for the diff · 40s
      </Interstitial>,
    );

    expect(html).toContain('data-slot="interstitial"');
    expect(html).toContain("self-center");
    expect(html).toContain("text-meta");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain('data-slot="stacked-avatars"');
    expect(html).not.toContain("<button");
  });

  it("becomes a button when it leads somewhere", () => {
    const html = renderToString(
      <Interstitial avatars={null} onClick={() => undefined}>
        Maya asked GitHub
      </Interstitial>,
    );

    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("hover:opacity-60");
  });

  it("spreads the remaining props onto either root", () => {
    expect(
      renderToString(
        <Interstitial avatars={null} data-testid="handoff">
          Maya asked GitHub
        </Interstitial>,
      ),
    ).toContain('data-testid="handoff"');
    expect(
      renderToString(
        <Interstitial avatars={null} data-testid="handoff" onClick={() => undefined}>
          Maya asked GitHub
        </Interstitial>,
      ),
    ).toContain('data-testid="handoff"');
  });
});
