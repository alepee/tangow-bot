import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GroupAvatar } from "./group-avatar.js";

describe("GroupAvatar", () => {
  it("renders fallback squad icon when no members provided", () => {
    const html = renderToString(<GroupAvatar members={[]} />);
    expect(html).toContain("<svg");
  });

  it("renders single BotAvatar when 1 member", () => {
    const html = renderToString(<GroupAvatar members={[{ botId: "harry" }]} />);
    expect(html).toContain("tangow-clay-avatar");
  });

  it("pairs a lone bot with the user's initials when provided", () => {
    const html = renderToString(<GroupAvatar members={[{ botId: "harry" }]} userInitials="RJ" />);
    expect((html.match(/data-working=/g) || []).length).toBe(1);
    expect(html).toContain(">RJ<");
  });

  it("renders the user's photo instead of the initials tile", () => {
    const html = renderToString(
      <GroupAvatar
        members={[{ botId: "harry" }]}
        userInitials="RJ"
        userImage="data:image/webp;base64,dGlueQ=="
      />,
    );
    expect(html).toContain('src="data:image/webp;base64,dGlueQ=="');
    expect(html).not.toContain(">RJ<");
  });

  it("shows the group's other people beside its bot instead of the user", () => {
    const html = renderToString(
      <GroupAvatar
        members={[{ botId: "harry" }]}
        people={[{ initials: "AL" }]}
        userInitials="RJ"
      />,
    );
    expect((html.match(/data-working=/g) || []).length).toBe(1);
    expect(html).toContain(">AL<");
    expect(html).not.toContain(">RJ<");
  });

  it("keeps a person visible when bots and people overflow", () => {
    const html = renderToString(
      <GroupAvatar
        members={[{ botId: "sherlock" }, { botId: "elon" }, { botId: "penny" }]}
        people={[{ initials: "AL" }, { initials: "BO" }]}
      />,
    );
    expect((html.match(/data-working=/g) || []).length).toBe(1);
    expect(html).toContain(">AL<");
    expect(html).toContain("+3");
  });

  it("renders 2 overlapping bot avatars for 2 members", () => {
    const html = renderToString(
      <GroupAvatar members={[{ botId: "sherlock" }, { botId: "elon" }]} />,
    );
    const count = (html.match(/data-working=/g) || []).length;
    expect(count).toBe(2);
    expect(html).toContain('data-working="false"');
  });

  it("renders a working member inside a group avatar", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { botId: "sherlock", status: "running" },
          { botId: "elon", status: "idle" },
        ]}
      />,
    );
    expect(html).toContain('data-working="true"');
    expect(html).toContain('data-working="true"');
  });

  it("renders 3 mini bot avatars for 3 members", () => {
    const html = renderToString(
      <GroupAvatar members={[{ botId: "sherlock" }, { botId: "elon" }, { botId: "penny" }]} />,
    );
    const count = (html.match(/data-working=/g) || []).length;
    expect(count).toBe(3);
  });

  it("renders 2 mini avatars + overflow count for 4+ members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[{ botId: "sherlock" }, { botId: "elon" }, { botId: "penny" }, { botId: "harry" }]}
      />,
    );
    expect(html).toContain("+2");
  });
});
