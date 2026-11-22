import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a centred peer event with both bots and its full label", () => {
    const html = renderToString(
      <CollaborationMarker
        ariaLabel="Message from Research"
        bots={[{ identity: "chief" }, { identity: "research" }]}
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('data-slot="interstitial"');
    expect(html).toContain("self-center");
    expect(html).toContain('data-slot="stacked-avatars"');
    expect(html).toContain('data-size="17"');
    // The button already carries the name; the stack stays decoration.
    expect(html).toContain('data-slot="stacked-avatars" data-size="17" aria-hidden="true"');
    expect(html.match(/tangow-clay-avatar/g)?.length).toBeGreaterThan(1);
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", status: "running" }]}
        label="Research is working"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Research is working");
    expect(html).not.toContain("sr-only");
    expect(html).toContain('data-working="true"');
    expect(html).toContain('data-working="true"');
  });
});
