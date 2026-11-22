import type { LinkMentionResolver } from "@tangow/core";
import { wwwLinkHref } from "@tangow/core";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EntityMentionCatalog, EntityMentionKind } from "./entity-mention";
import { entityTokens } from "./entity-mention";
import { EntityMention, useEntityMentions } from "./entity-mention.web";
import { resolvedLinkMention } from "./link-mention.web";
import "./markdown.web.css";
import {
  type ChatMarkdownProps,
  closeUnterminatedFence,
  linkHref,
  linkifyText,
  repairMarkdownTables,
  sanitizeMarkdownUrl,
} from "./markdown";

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="9"
        y="9"
        width="12"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12.5 9.5 18 20 6"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CodeBlock(props: React.ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="rk-chat-markdown-pre-wrap">
      <pre {...props} ref={preRef} />
      <button
        type="button"
        className="rk-chat-markdown-copy"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

/** The mentions of the message being rendered, read by its links without rebuilding `components`. */
const LinkMentions = createContext<LinkMentionResolver<ReactNode> | undefined>(undefined);

type HastNode = { type: string; value?: string; children?: readonly HastNode[] };

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(textOf).join("") ?? "";
}

function MarkdownLink({ node, href, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const text = textOf(node);
  // GFM links a bare `www.` address as http; it stands for its https link, as the server keys it.
  const target = href === `http://${text}` ? (wwwLinkHref(text) ?? href) : href;
  const mention = resolvedLinkMention(useContext(LinkMentions), target, text);
  return mention ?? <a {...props} href={target} target="_blank" rel="noreferrer noopener" />;
}

/** A mention the rehype pass below marked in the text, drawn with the thread's bot faces. */
function MarkdownEntityMention({ node, ...props }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
  const entities = useEntityMentions();
  const kind = node?.properties.dataEntityMention as EntityMentionKind | undefined;
  if (!kind) return <span {...props} />;
  const character = node?.properties.dataEntityAvatar as string | undefined;
  return (
    <EntityMention
      kind={kind}
      name={textOf(node)}
      avatar={kind === "bot" ? entities?.avatar(character) : undefined}
    />
  );
}

type HastElement = HastNode & {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
};

/** Never inside code or a link: those keep their text as written. */
const NO_MENTIONS = new Set(["a", "code", "pre"]);

/** Marks every known `@Name` in the rendered text, so `span` draws it as a mention. */
function rehypeEntityMentions(catalog: EntityMentionCatalog) {
  function visit(parent: { children?: readonly HastNode[] }) {
    if (!parent.children) return;
    const next: HastNode[] = [];
    for (const child of parent.children) {
      if (child.type === "element") {
        if (!NO_MENTIONS.has((child as HastElement).tagName)) visit(child);
        next.push(child);
        continue;
      }
      if (child.type !== "text" || !child.value?.includes("@")) {
        next.push(child);
        continue;
      }
      for (const token of entityTokens(child.value, catalog, false)) {
        next.push(
          token.kind === "text"
            ? { type: "text", value: token.text }
            : ({
                type: "element",
                tagName: "span",
                properties: {
                  dataEntityMention: token.kind,
                  dataEntityAvatar: token.avatarCharacter ?? undefined,
                },
                children: [{ type: "text", value: token.name }],
              } as HastElement),
        );
      }
    }
    (parent as { children: HastNode[] }).children = next;
  }
  return () => (tree: HastNode) => visit(tree);
}

const components: Components = {
  a: MarkdownLink,
  span: MarkdownEntityMention,
  img({ node: _node, ...props }) {
    return <img {...props} alt={props.alt ?? ""} loading="lazy" />;
  },
  pre({ node: _node, ...props }) {
    return <CodeBlock {...props} />;
  },
  // react-markdown turns a column's alignment into an inline physical
  // `text-align`, which beats the stylesheet's logical mapping and breaks RTL.
  th({ node, style: _style, ...props }) {
    return <th {...props} align={cellAlign(node)} />;
  },
  td({ node, style: _style, ...props }) {
    return <td {...props} align={cellAlign(node)} />;
  },
};

function cellAlign(node: { properties?: Record<string, unknown> } | undefined) {
  const align = node?.properties?.align;
  return align === "left" || align === "center" || align === "right" ? align : undefined;
}

// Untrusted content: drop every image node so no remote request is made,
// whatever the URL scheme (threat model S-R1). Nothing is rendered in its place.
const componentsNoImages: Components = { ...components, img: () => null };

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  allowImages = true,
  mentions,
}: ChatMarkdownProps & {
  /** The message's link mentions; keep it referentially stable, this view is memoized. */
  mentions?: LinkMentionResolver<ReactNode>;
}) {
  const source = repairMarkdownTables(streaming ? closeUnterminatedFence(children) : children);
  const entities = useEntityMentions();
  const rehypePlugins = useMemo(
    () => (entities?.mentions.length ? [rehypeEntityMentions(entities)] : []),
    [entities],
  );

  return (
    <div className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}>
      <LinkMentions value={mentions}>
        <ReactMarkdown
          components={allowImages ? components : componentsNoImages}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehypePlugins}
          skipHtml
          urlTransform={(url, key) =>
            (key === "href" ? linkHref(url, true) : sanitizeMarkdownUrl(url, true)) ?? ""
          }
        >
          {source}
        </ReactMarkdown>
      </LinkMentions>
      {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
    </div>
  );
});

/**
 * Plain text (what the person typed) with every URL in it made clickable, as a mention when the
 * server resolved one for it, and every bot, group or skill the thread knows drawn in place.
 */
export function LinkifiedText({
  text,
  mentions,
}: {
  text: string;
  mentions?: LinkMentionResolver<ReactNode>;
}) {
  const entities = useEntityMentions();
  return linkifyText(text).map((segment, i) =>
    segment.href ? (
      <Fragment key={i}>
        {resolvedLinkMention(mentions, segment.href, segment.text, "rk-linkified") ?? (
          <a className="rk-linkified" href={segment.href} target="_blank" rel="noreferrer noopener">
            {segment.text}
          </a>
        )}
      </Fragment>
    ) : (
      <Fragment key={i}>
        {entityTokens(segment.text, entities, i === 0).map((token, j) =>
          token.kind === "text" ? (
            token.text
          ) : (
            <EntityMention
              key={j}
              kind={token.kind}
              name={token.name}
              avatar={token.kind === "bot" ? entities?.avatar(token.avatarCharacter) : undefined}
              ink
            />
          ),
        )}
      </Fragment>
    ),
  );
}

export type { EntityMentionTarget } from "./entity-mention";
export type { EntityMentions } from "./entity-mention.web";
export {
  EntityMention,
  EntityMentionField,
  EntityMentionsProvider,
} from "./entity-mention.web";
export { LinkMentionGlyph } from "./link-mention.web";
export type { ChatMarkdownProps } from "./markdown";
export { truncateMarkdownForRender } from "./markdown";
