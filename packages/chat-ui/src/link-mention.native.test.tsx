import type {
  ASTNode,
  MarkdownStyleMap,
  RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { linkMentionsOf } from "@tangow/core";
import { lightTokens } from "@tangow/ui-tokens";
import type { ReactElement, ReactNode } from "react";
import { createElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (actual) => ({
  ...(await actual<object>()),
  useMemo: <T,>(make: () => T) => make(),
  useContext: () => undefined,
}));
vi.mock("react-native", () => {
  const flatten = (style: unknown): object | undefined =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : (style as object | undefined) || undefined;
  return {
    Text: "Text",
    View: "View",
    Linking: { openURL: () => Promise.resolve() },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten,
      hairlineWidth: 0.5,
      absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
    },
  };
});
vi.mock("@ronradtke/react-native-markdown-display", () => {
  const chain = { set: () => chain, add: () => chain, linkify: {} as unknown };
  chain.linkify = chain;
  return { default: () => null, MarkdownStream: () => null, createMarkdownIt: () => chain };
});
vi.mock("./table-grid.native", () => ({}));

import type { NativeLinkMentions } from "./link-mention.native";
import { botLinkMentionTone, nativeLinkMention } from "./link-mention.native";
import { ChatMarkdown, LinkifiedText } from "./markdown.native";

const NOTION = "https://www.notion.so/acme/Roadmap-Q4-3f9a2c7e81d04b5f";

/** What a reader gets from the rendered tree: its text, with each icon drawn as `[icon tint]`. */
function shown(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(shown).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return shown(node.props.children);
  return "";
}

const lookup = linkMentionsOf({
  role: "user",
  blocks: [
    { kind: "text", text: "the message" },
    { kind: "link_mention", url: NOTION, title: "Roadmap Q4", icon: { artifactId: "icon-1" } },
    { kind: "link_mention", url: "https://docs.example.test/d/abc" },
  ] as Parameters<typeof linkMentionsOf>[0]["blocks"],
});
const mentions: NativeLinkMentions | undefined = lookup && {
  ...lookup,
  icon: (artifactId, tint) => `[${artifactId ?? "glyph"} ${tint}]`,
};

function mention(href: string, authorText = href) {
  return nativeLinkMention({
    mentions,
    href,
    authorText,
    tone: botLinkMentionTone(lightTokens),
    onPress: () => {},
  });
}

describe("a link mention on a phone (CA 15, 29)", () => {
  it("draws the site icon, a word joiner, then the label isolated", () => {
    expect(shown(mention(NOTION))).toBe("[icon-1 #6E6E73]\u2060\u2068Roadmap Q4\u2069");
  });

  it("asks the host for the glyph in the muted ink when the site gave no icon", () => {
    expect(shown(mention("https://docs.example.test/d/abc"))).toBe(
      "[glyph #6E6E73]\u2060\u2068docs.example.test\u2069",
    );
  });

  it("keeps the author's markdown label over the server's title", () => {
    expect(shown(mention(NOTION, "le plan"))).toBe("[icon-1 #6E6E73]\u2060\u2068le plan\u2069");
  });

  it("leaves a link without a mention, or a message without a resolver, plain", () => {
    expect(mention("https://other.example.test/")).toBeUndefined();
    expect(
      nativeLinkMention({
        mentions: undefined,
        href: NOTION,
        authorText: NOTION,
        tone: botLinkMentionTone(lightTokens),
        onPress: () => {},
      }),
    ).toBeUndefined();
  });
});

describe("the person's text with mentions", () => {
  it("turns a resolved link into its mention in the person's ink and keeps the others", () => {
    const segments = LinkifiedText({
      children: "voir www.notion.so/acme/Roadmap-Q4-3f9a2c7e81d04b5f et https://b.test/x",
      ink: "#FBFBF9",
      mentions,
    });
    expect(shown(segments)).toBe(
      "voir [icon-1 #FBFBF9]\u2060\u2068Roadmap Q4\u2069 et https://b.test/x",
    );
  });
});

function textOf(node: ASTNode): string {
  return node.content + node.children.map(textOf).join("");
}

function astNode(type: string, children: ASTNode[] = [], content = "", href?: string): ASTNode {
  return {
    type,
    sourceType: type,
    sourceInfo: null,
    sourceMeta: null,
    block: false,
    key: type,
    content,
    markup: "",
    tokenIndex: 0,
    index: 0,
    attributes: href ? { href } : {},
    children,
  };
}

describe("a mention in the bot's markdown", () => {
  // What the library is handed: the bubble's style map and the link rule it calls per link.
  const markdown = (
    ChatMarkdown.type({
      children: "",
      mentions,
      palette: lightTokens,
      inBubble: true,
    }) as ReactElement<{
      children: ReactElement<{ rules: RenderRules; style: MarkdownStyleMap }>;
    }>
  ).props.children.props;
  const paragraph = astNode("paragraph");
  const body = astNode("body");

  function drawLink(label: ASTNode[], parents: ASTNode[]) {
    // Each label run as the library draws it: a Text in its own node's style.
    const runs = label.map((run) =>
      createElement("Text", { key: run.key, style: markdown.style[run.type] }, textOf(run)),
    );
    const link = astNode("link", label, "", NOTION);
    return markdown.rules.link?.(link, runs, parents, markdown.style) as ReactElement<{
      style?: unknown;
    }>;
  }

  it("takes the sentence's type, bold inside bold, never the code chip of a code label", () => {
    const view = drawLink(
      [astNode("code_inline", [], "x.ts")],
      [astNode("strong"), paragraph, body],
    );
    expect(shown(view)).toBe("[icon-1 #6E6E73]\u2060\u2068x.ts\u2069");
    expect(view.props.style).toEqual({
      color: lightTokens.foreground,
      fontSize: 16,
      lineHeight: 23,
      fontWeight: "700",
    });
  });

  it("drops the emphasis inside its own label, as the web does, and names an empty link", () => {
    const strong = astNode("strong", [astNode("text", [], "x")]);
    expect(drawLink([strong], [paragraph, body]).props.style).toEqual({
      color: lightTokens.foreground,
      fontSize: 16,
      lineHeight: 23,
    });
    expect(shown(drawLink([], [paragraph, body]))).toBe(
      "[icon-1 #6E6E73]\u2060\u2068Roadmap Q4\u2069",
    );
  });
});
