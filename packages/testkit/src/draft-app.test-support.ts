import type { ConnectorProvider } from "@tangow/adapter-kit";
import { EncryptedSecretStore, McpConnector } from "@tangow/adapters";
import type { PrismaClient } from "@tangow/db";

const TOOLS = [
  {
    name: "acme_find_room",
    description: "Find a room by name",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "acme_deliver_message",
    description: "Deliver a message",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string" },
        copies: { type: "array", items: { type: "string" } },
        topic: { type: "string" },
        content: { type: "string" },
        urgent: { type: "boolean" },
      },
      required: ["recipient", "content"],
    },
  },
  {
    name: "acme_post_update",
    description: "Post an update to a room",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, text: { type: "string" } },
      required: ["room", "text"],
    },
  },
] as const;

export type AcmeTool = (typeof TOOLS)[number]["name"];

export type AcmeFault = { kind: "refuse"; error: string } | { kind: "delivered_unanswered" };

export function acmeApp() {
  const delivered: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let fault: AcmeFault | undefined;
  let installed: McpConnector | undefined;
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "acme_find_room") {
      return {
        content: [{ type: "text", text: JSON.stringify({ id: "R0TEAM", name: "#launch" }) }],
      };
    }
    const next = fault;
    fault = undefined;
    if (next?.kind === "refuse") {
      return {
        isError: true,
        content: [{ type: "text", text: next.error }],
        structuredContent: { successful: false, error: next.error },
      };
    }
    await app.beforeDeliver?.();
    delivered.push({ tool: `mcp__acme__${tool}`, args });
    if (next?.kind === "delivered_unanswered")
      return { isError: true, content: [{ type: "text", text: "Timeout" }] };
    return { content: [{ type: "text", text: "Delivered." }] };
  };
  const remote = {
    resolveHostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const body =
        init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : init?.body;
      const request = JSON.parse(typeof body === "string" ? body : "{}") as {
        id?: unknown;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
      };
      const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: request.id, result });
      if (request.method === "initialize") {
        return answer({
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "acme", version: "1" },
        });
      }
      if (request.method === "tools/list") return answer({ tools: TOOLS });
      if (request.method === "tools/call") {
        return answer(await call(request.params?.name ?? "", request.params?.arguments ?? {}));
      }
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch,
  };
  const app = {
    delivered,
    remote,
    beforeDeliver: undefined as (() => Promise<void>) | undefined,
    failNext(next: AcmeFault) {
      fault = next;
    },
    connector: {
      describe: () => ({
        id: "mcp",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { discover: true, oauth: false, secretsBrokered: true },
      }),
      discoverTools: (context) => installed?.discoverTools(context) ?? Promise.resolve([]),
      resolveCall: (call, context) => installed!.resolveCall(call, context),
      execute: (call, context) => installed!.execute(call, context),
    } satisfies ConnectorProvider,
    async install(
      prisma: PrismaClient,
      { spaceId, userId }: { spaceId: string; userId: string },
      asks: AcmeTool[] = ["acme_deliver_message", "acme_post_update"],
    ) {
      installed ??= new McpConnector(
        prisma,
        new EncryptedSecretStore("acme-fixture-encryption-key"),
        { network: remote },
      );
      const server = await prisma.mcpServer.create({
        data: {
          spaceId,
          userId,
          slug: "acme",
          transport: "streamable_http",
          name: "Acme",
          endpoint: "https://acme.example.test/mcp",
        },
      });
      const bots = await prisma.bot.findMany({ where: { spaceId, userId, archivedAt: null } });
      await prisma.botMcpServer.createMany({
        data: bots.map((bot) => ({ spaceId, userId, botId: bot.id, serverId: server.id })),
      });
      for (const tool of asks) {
        await prisma.actionApprovalRule.create({
          data: {
            spaceId,
            createdByUserId: userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: `mcp__acme__${tool}`,
          },
        });
      }
    },
  };
  return app;
}
