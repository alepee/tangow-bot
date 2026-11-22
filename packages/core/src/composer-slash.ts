import { skillInDraft } from "./composer-tokens.js";

export const SLASH_ACTIONS = [
  { id: "chat-settings" as const, label: "Chat Settings" },
  { id: "settings-general" as const, label: "Settings: General" },
  { id: "settings-usage" as const, label: "Settings: Usage" },
] as const;

export type SlashActionId = (typeof SLASH_ACTIONS)[number]["id"];

/**
 * The prompt a draft sends: the person's sentence with every `@Name` where it was typed. A picked
 * skill only takes effect leading the prompt on a line of its own (`extractForcedSkillName`), so
 * its inline `/skill` token moves to that line.
 */
export function serializeComposerPrompt(draft: string, skill: { name: string } | null): string {
  const body = draft.replace(/^\s+/, "");
  if (!skill) return body.trimEnd();
  const token = `/${skill.name}`;
  const rest = (skillInDraft(body, skill) ? body.slice(token.length) : body).trim();
  return rest ? `${token}\n${rest}` : token;
}

export function truncateSlashDescription(value: string, max = 72): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
