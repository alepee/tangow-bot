import { createHash } from "node:crypto";
import type { ArtifactStore } from "@tangow/adapter-kit";
import type { Actor, MessageBlock } from "@tangow/contracts";
import { ATTACHMENT_MAX_COUNT } from "@tangow/contracts";
import {
  AttachmentValidationError,
  decodeAttachmentBase64,
  messageBlockForArtifact,
  promptTextForAttachments,
  validateAttachmentMimeType,
} from "@tangow/core";
import { IsolationError, type PrismaClient } from "@tangow/db";
import { userFileArtifact } from "./user-file-artifact.js";

function adapterContext(actor: Actor, botId: string, operationId: string) {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

export async function createOwnedArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: {
    botId: string;
    groupId?: string;
    name: string;
    mimeType: string;
    contentBase64: string;
  },
) {
  validateAttachmentMimeType(input.mimeType);
  const bytes = decodeAttachmentBase64(input.contentBase64);
  const context = adapterContext(actor, input.botId, `artifact-create:${input.botId}`);
  const stored = await deps.artifacts.put(
    { name: input.name, mimeType: input.mimeType, bytes },
    context,
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const row = await deps.prisma.artifact
    .create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: input.botId,
        groupId: input.groupId,
        name: input.name,
        mimeType: input.mimeType,
        size: bytes.byteLength,
        hash,
        storageKey: stored.id,
      },
    })
    .catch(async (error) => {
      await deps.artifacts.remove(stored.id, context).catch(() => undefined);
      throw error;
    });
  return {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    runId: row.runId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOwnedArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: { botId: string; artifactId: string },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      botId: input.botId,
      groupId: null,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  if (!row) throw new IsolationError();
  return readArtifact(deps.artifacts, actor, row, input.botId);
}

export async function getSpaceArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: { artifactId: string; groupId: string; contextBotId: string },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      groupId: input.groupId,
      // A group's files are everyone's in it, whoever added them: the caller has checked the
      // actor is in the group.
      spaceId: actor.spaceId,
    },
  });
  if (!row) throw new IsolationError();
  return readArtifact(deps.artifacts, actor, row, input.contextBotId);
}

async function readArtifact(
  artifacts: ArtifactStore,
  actor: Actor,
  row: {
    id: string;
    botId: string | null;
    groupId: string | null;
    runId: string | null;
    storageKey: string;
    name: string;
    mimeType: string;
    size: number;
    createdAt: Date;
  },
  contextBotId: string,
) {
  const bytes = await artifacts.get(
    row.storageKey,
    adapterContext(actor, contextBotId, `artifact-get:${row.id}`),
  );
  return {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    runId: row.runId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    contentBase64: Buffer.from(bytes).toString("base64"),
  };
}

type SendAttachmentRow = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
};

function normalizeAttachmentIds(artifactIds: string[] | undefined) {
  const ids = [...new Set(artifactIds ?? [])];
  if (ids.length > ATTACHMENT_MAX_COUNT) {
    throw new AttachmentValidationError(`At most ${ATTACHMENT_MAX_COUNT} attachments per message`);
  }
  return ids;
}

function toAttachmentResolution<T extends SendAttachmentRow>(ids: string[], rows: T[]) {
  if (rows.length !== ids.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const artifacts = ids.map((id) => byId.get(id)!);
  const blocks = artifacts.map((row) =>
    messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  );
  return { blocks, artifacts };
}

export async function resolveSendAttachments(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  botId: string,
  artifactIds: string[] | undefined,
) {
  const ids = normalizeAttachmentIds(artifactIds);
  if (!ids.length) return toAttachmentResolution(ids, [] as SendAttachmentRow[]);

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      botId,
      groupId: null,
      spaceId: actor.spaceId,
      userId: actor.userId,
      // A card image is not a file the person can attach.
      ...userFileArtifact,
    },
  });
  return toAttachmentResolution(ids, rows);
}

export async function resolveGroupSendAttachments(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  groupId: string,
  memberBotIds: string[],
  artifactIds: string[] | undefined,
) {
  const ids = normalizeAttachmentIds(artifactIds);
  if (!ids.length) return toAttachmentResolution(ids, [] as SendAttachmentRow[]);

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...userFileArtifact,
      OR: [
        { groupId },
        // Accept artifacts uploaded by a current member before group ownership
        // was persisted. Removing that member revokes this legacy fallback.
        { groupId: null, botId: { in: memberBotIds } },
      ],
    },
  });
  return toAttachmentResolution(ids, rows);
}

/** The marker a message sent with its preview turned off carries from the start. */
function linkPreviewOptOutBlocks(options: { linkPreview?: false }): MessageBlock[] {
  // No preview is ever added to such a message, whatever its first link.
  return options.linkPreview === false ? [{ kind: "link_preview", removed: true }] : [];
}

export function buildUserMessageBlocks(
  text: string | undefined,
  attachmentBlocks: ReturnType<typeof messageBlockForArtifact>[],
  options: { linkPreview?: false } = {},
) {
  const blocks: MessageBlock[] = [];
  const caption = text?.trim();
  if (caption) blocks.push({ kind: "text" as const, text: caption });
  blocks.push(...attachmentBlocks, ...linkPreviewOptOutBlocks(options));
  return blocks;
}

/** A follow-up's blocks: its text exactly as sent (never trimmed away), plus the opt-out marker. */
export function buildFollowUpBlocks(text: string, options: { linkPreview?: false } = {}) {
  return [{ kind: "text" as const, text }, ...linkPreviewOptOutBlocks(options)];
}

export function buildSendPrompt(
  text: string | undefined,
  artifacts: Array<{ name: string; mimeType: string; size: number }>,
  connectorNames: string[] = [],
  groupNames: string[] = [],
) {
  const prompt = withConnectorLine(promptTextForAttachments(text, artifacts), connectorNames);
  if (groupNames.length === 0) return prompt;
  const line = `Mentioned groups: ${groupNames.join(", ")}.`;
  return prompt ? `${prompt}\n\n${line}` : line;
}

/** Merges the connector names into the line a client may already have written. */
function withConnectorLine(prompt: string, connectorNames: string[]) {
  if (connectorNames.length === 0) return prompt;
  const marker = "Use these connectors if relevant:";
  const existing = new RegExp(`^${marker} (.*)\\.$`, "m").exec(prompt);
  const names = [
    ...new Set([
      ...(existing?.[1]
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean) ?? []),
      ...connectorNames.map((name) => name.trim()).filter(Boolean),
    ]),
  ];
  const line = `${marker} ${names.join(", ")}.`;
  if (existing) return prompt.replace(existing[0], () => line);
  return prompt ? `${prompt}\n\n${line}` : line;
}
