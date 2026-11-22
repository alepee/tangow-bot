import type { EncryptedSecretStore } from "@tangow/adapters";
import { buildMcpCredentialBlob } from "@tangow/adapters";
import { deriveMcpSlug } from "@tangow/core";
import type { CapabilityInstall, PrismaClient } from "@tangow/db";

// Remove after existing deployments have converted their legacy MCP installs.
export async function moveMcpSources(
  prisma: PrismaClient,
  secrets: EncryptedSecretStore,
  warn: (message: string) => void,
) {
  const installs = await prisma.capabilityInstall.findMany({ where: { kind: "mcp" } });
  for (const install of installs) {
    try {
      await moveOne(prisma, secrets, install, warn);
    } catch {
      // A failed install rolls back and stays for the next start, e.g. if another instance moved it.
      warn(`Could not move legacy MCP source ${install.id}; leaving it for the next start`);
    }
  }
}

async function moveOne(
  prisma: PrismaClient,
  secrets: EncryptedSecretStore,
  install: CapabilityInstall,
  warn: (message: string) => void,
) {
  await prisma.$transaction(async (tx) => {
    const owner = { spaceId: install.spaceId, userId: install.userId };
    const config = install.config as {
      auth?: { type: string; name?: string };
      headers?: Record<string, string>;
    };
    let token: string | undefined;
    if (install.secretId) {
      const row = await tx.secret.findFirst({ where: { id: install.secretId, ...owner } });
      try {
        if (!row) throw new Error("Missing secret");
        token = secrets.load(row.ciphertext, row.id);
      } catch {
        warn(`Could not decrypt legacy MCP source ${install.id}; leaving it unchanged`);
        return;
      }
    }
    const headers = { ...config.headers };
    if (config.auth?.type === "header" && config.auth.name && token) {
      headers[config.auth.name] = token;
    }
    const payload = buildMcpCredentialBlob({
      secret: config.auth?.type === "bearer" ? token : undefined,
      headers,
    });
    const existing = await tx.mcpServer.findFirst({
      where: { ...owner, endpoint: install.source },
    });
    // Reuse a server for the same endpoint unless both carry a credential: never drop one.
    let server = existing && !(payload && existing.secretId) ? existing : null;
    const stored =
      payload && !server?.secretId
        ? await secrets.put(payload, {
            ...owner,
            operationId: "mcp.move",
            traceId: "mcp.move",
            signal: new AbortController().signal,
          })
        : null;
    if (stored) {
      await tx.secret.create({ data: { ...owner, ...stored, kind: "mcp" } });
    }
    const headerKeys = Object.fromEntries(Object.keys(headers).map((key) => [key, true]));
    if (server && stored) {
      server = await tx.mcpServer.update({
        where: { id: server.id },
        data: { secretId: stored.id, headers: headerKeys, revision: { increment: 1 } },
      });
    }
    if (!server) {
      const base = deriveMcpSlug(install.name);
      const slugs = new Set(
        (await tx.mcpServer.findMany({ where: owner, select: { slug: true } })).map(
          (row) => row.slug,
        ),
      );
      let slug = base;
      for (let suffix = 2; slugs.has(slug); suffix++) {
        const tail = `-${suffix}`;
        slug = `${base.slice(0, 64 - tail.length)}${tail}`;
      }
      server = await tx.mcpServer.create({
        data: {
          ...owner,
          name: install.name,
          slug,
          endpoint: install.source,
          transport: "streamable_http",
          headers: headerKeys,
          secretId: stored?.id,
        },
      });
    }
    const target = server;
    const bots = await tx.bot.findMany({ where: { ...owner, archivedAt: null } });
    await tx.botMcpServer.createMany({
      data: bots.map((bot) => ({
        ...owner,
        botId: bot.id,
        serverId: target.id,
        allowAllTools: true,
      })),
      skipDuplicates: true,
    });
    await tx.capabilityInstall.delete({ where: { id: install.id } });
    if (install.secretId) await tx.secret.delete({ where: { id: install.secretId } });
  });
}
