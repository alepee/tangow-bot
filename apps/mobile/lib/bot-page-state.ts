import type { Bot, Me, VoiceInfo } from "@tangow/contracts";
import { createSaveStore, type ModelCatalog } from "@tangow/core";
import { createBotRecords } from "./bot-records";
import { createRoutineRecords } from "./routine-records";
import { serverMessage } from "./server-error";
import { createSharedRead, type SharedRead } from "./shared-read";

/** One copy of the bot page's data and saves for the app session, outside React. */
export const botRecords = createBotRecords();

/** Each bot's routines, shared by the Routines tab and a routine's screen. */
export const routineRecords = createRoutineRecords();

/** Field saves and unsaved drafts: memory only, so a draft never reaches the disk. */
export const botSaves = createSaveStore({ reasonOf: serverMessage });

/** What a bot's voice is picked from, shared by the row and its list. */
export const voicesRead = createSharedRead<VoiceInfo[]>();

/** What a bot's model is picked from. The server answers it per space, so each space has its own read. */
const modelCatalogReads = new Map<string, SharedRead<ModelCatalog>>();

export function modelCatalogRead(spaceId: string): SharedRead<ModelCatalog> {
  const known = modelCatalogReads.get(spaceId);
  if (known) return known;
  const read = createSharedRead<ModelCatalog>();
  modelCatalogReads.set(spaceId, read);
  return read;
}

/** The signed-in person, read once a session by the bot page for whose saves these are. */
export const viewer: { current: Promise<Me> | null } = { current: null };

const runEnds = new Map<string, number>();
const runEndListeners = new Set<() => void>();

/** The thread tells the bot page a run ended: the bot may have changed its own settings. */
export function noteBotRunEnded(botId: string): void {
  runEnds.set(botId, (runEnds.get(botId) ?? 0) + 1);
  for (const listener of runEndListeners) listener();
}

export function botRunEpoch(botId: string): number {
  return runEnds.get(botId) ?? 0;
}

export function subscribeBotRunEnds(listener: () => void): () => void {
  runEndListeners.add(listener);
  return () => {
    runEndListeners.delete(listener);
  };
}

const savedBotListeners = new Set<(bot: Bot) => void>();

/** The bot page saved a bot: screens already open take its avatar now, not on their next read. */
export function noteBotSaved(bot: Bot): void {
  for (const listener of savedBotListeners) listener(bot);
}

export function subscribeBotSaved(listener: (bot: Bot) => void): () => void {
  savedBotListeners.add(listener);
  return () => {
    savedBotListeners.delete(listener);
  };
}

/** `bots` with the saved bot's character and colour, the same array when it is not among them. */
export function withSavedAvatar<T extends Pick<Bot, "id" | "avatarCharacter" | "color">>(
  bots: T[],
  saved: Bot,
): T[] {
  if (!bots.some((bot) => bot.id === saved.id)) return bots;
  return bots.map((bot) =>
    bot.id === saved.id
      ? { ...bot, avatarCharacter: saved.avatarCharacter, color: saved.color }
      : bot,
  );
}

/** Sign-out: nothing of the last person's bots, routines, saves or drafts stays in memory. */
export function resetBotPage(): void {
  botRecords.reset();
  routineRecords.reset();
  botSaves.reset();
  runEnds.clear();
  viewer.current = null;
  for (const read of modelCatalogReads.values()) read.reset();
  modelCatalogReads.clear();
  voicesRead.reset();
}
