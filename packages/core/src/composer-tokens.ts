/**
 * Mentions and a skill stay where they were typed: `@Name` in the sentence and `/skill` leading
 * it. These split a draft or a sent message into its text and the tokens it names, for the
 * composer and the bubbles to draw them in place.
 */
export type MentionSegment<M, S> =
  | { kind: "text"; text: string; start: number }
  | { kind: "mention"; text: string; start: number; mention: M }
  | { kind: "skill"; text: string; start: number; skill: S };

type Named = { name: string };

/** The same boundary `hasMentionToken` reads: a name never starts or ends inside a word. */
const WORD_CHAR = /[\p{L}\p{N}_-]/u;

function namedAt(text: string, at: number, name: string): boolean {
  const candidate = text.slice(at, at + name.length);
  return candidate.length === name.length && candidate.toLowerCase() === name.toLowerCase();
}

function longestFirst<T extends Named>(items: readonly T[]): T[] {
  return items.filter((item) => item.name.trim()).sort((a, b) => b.name.length - a.name.length);
}

function segmentMentions<M extends Named, S>(
  text: string,
  from: number,
  mentions: readonly M[],
): MentionSegment<M, S>[] {
  const named = longestFirst(mentions);
  const segments: MentionSegment<M, S>[] = [];
  let textStart = from;
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && WORD_CHAR.test(text[i - 1] ?? ""))) continue;
    const mention = named.find(
      (item) =>
        namedAt(text, i + 1, item.name) && !WORD_CHAR.test(text[i + 1 + item.name.length] ?? ""),
    );
    if (!mention) continue;
    const end = i + 1 + mention.name.length;
    if (i > textStart)
      segments.push({ kind: "text", text: text.slice(textStart, i), start: textStart });
    segments.push({ kind: "mention", text: text.slice(i, end), start: i, mention });
    textStart = end;
    i = end - 1;
  }
  if (textStart < text.length) {
    segments.push({ kind: "text", text: text.slice(textStart), start: textStart });
  }
  return segments;
}

/** A leading `/skill` whose name ends where `ends` says (end of text, or a matching character). */
function leadingSkill<S extends Named>(
  text: string,
  skills: readonly S[],
  ends: RegExp,
): S | undefined {
  if (!text.startsWith("/")) return undefined;
  return longestFirst(skills).find((skill) => {
    if (!namedAt(text, 1, skill.name)) return false;
    const next = text[1 + skill.name.length];
    return next === undefined || ends.test(next);
  });
}

/**
 * The composer's draft: the picked mentions where they were typed and the picked skill when the
 * draft still leads with it. Only what was picked is a token; a typed `@Name` stays text.
 */
export function composerSegments<M extends Named, S extends Named>(
  draft: string,
  mentions: readonly M[],
  skill: S | null,
): MentionSegment<M, S>[] {
  const leading = skill ? leadingSkill(draft, [skill], /\s/) : undefined;
  if (!leading) return segmentMentions(draft, 0, mentions);
  const end = 1 + leading.name.length;
  return [
    { kind: "skill", text: draft.slice(0, end), start: 0, skill: leading },
    ...segmentMentions<M, S>(draft, end, mentions),
  ];
}

/**
 * A sent message, against what the client knows. A skill is a token only on the first line alone,
 * as the server forced it (`extractForcedSkillName`); its line break shows as a space so the
 * sentence reads on. Unknown or renamed names stay text.
 */
export function messageSegments<M extends Named, S extends Named>(
  text: string,
  mentions: readonly M[],
  skills: readonly S[],
): MentionSegment<M, S>[] {
  const skill = leadingSkill(text, skills, /\n/);
  if (!skill) return segmentMentions(text, 0, mentions);
  const end = 1 + skill.name.length;
  const rest = segmentMentions<M, S>(text, end, mentions);
  const first = rest[0];
  if (first?.kind === "text" && first.text.startsWith("\n")) {
    rest[0] = { ...first, text: ` ${first.text.slice(1)}` };
  }
  return [{ kind: "skill", text: text.slice(0, end), start: 0, skill }, ...rest];
}

/** The picked mentions the draft still holds as tokens: deleting a token's text drops it. */
export function mentionsInDraft<M extends Named>(draft: string, mentions: readonly M[]): M[] {
  const kept = new Set<M>();
  for (const segment of segmentMentions<M, never>(draft, 0, mentions)) {
    if (segment.kind === "mention") kept.add(segment.mention);
  }
  return mentions.filter((mention) => kept.has(mention));
}

/** The picked skill while the draft still leads with it. */
export function skillInDraft<S extends Named>(draft: string, skill: S | null): S | null {
  return skill && leadingSkill(draft, [skill], /\s/) ? skill : null;
}

/** The `@query` being typed right before the caret, unless it is a picked token already. */
export function mentionQueryAt(
  draft: string,
  caret: number,
  picked: readonly Named[] = [],
): { query: string; start: number } | null {
  const match = /(?:^|\s)@([\w-]*)$/.exec(draft.slice(0, caret));
  if (!match) return null;
  const start = caret - match[0].length + match[0].indexOf("@");
  const token = segmentMentions(draft, 0, picked).some(
    (segment) => segment.kind === "mention" && segment.start === start,
  );
  return token ? null : { query: match[1] ?? "", start };
}

/** Replaces `draft[start, caret)` (the `@query`) with the mention's token and a space. */
export function insertMentionToken(
  draft: string,
  start: number,
  caret: number,
  name: string,
): { draft: string; caret: number } {
  const token = `@${name} `;
  const after = draft.slice(caret).replace(/^ /, "");
  return { draft: `${draft.slice(0, start)}${token}${after}`, caret: start + token.length };
}

/** Where the caret sits after an edit turned `before` into `after`: the end of what changed. */
export function caretAfterEdit(before: string, after: string): number {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return after.length - suffix;
}
