import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioEmulator,
  EncryptedSecretStore,
  ThirdPartyConnectorEmulator,
} from "@tangow/adapters";
import type { Space } from "@tangow/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { moveMcpSources } from "../../../apps/api/src/move-mcp-sources.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Actor = { spaceId: string; userId: string };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
const TEST_ENCRYPTION_KEY = "offline-connector-test-encryption-key";

describeWithDatabase("Composio catalog reconciliation", () => {
  let handles: AppHandles;
  let app: App;
  let composio: ComposioEmulator;
  let thirdParties: ThirdPartyConnectorEmulator;
  let connectionOrdinal = 0;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "tangow-connections-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    composio = new ComposioEmulator();
    thirdParties = new ThirdPartyConnectorEmulator();
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      encryptionKey: TEST_ENCRYPTION_KEY,
      signupsEnabled: "true",
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconciles one scoped row per provider under concurrent catalog fetches", async () => {
    const ownerCookie = await signup(app, `owner-connections-${stamp}@tangow.test`, "Owner");
    const otherCookie = await signup(app, `other-connections-${stamp}@tangow.test`, "Other");
    const owner = await rpc<Actor>(app, ownerCookie, "me");
    const otherActor = await rpc<Actor>(app, otherCookie, "me");
    const other = { spaceId: otherActor.spaceId, userId: otherActor.userId };
    await connectRemote(composio, owner, "GMAIL");

    const first = await createConnection(owner, "GMAIL");
    const duplicate = await createConnection(owner, "GMAIL");
    const otherProvider = await createConnection(owner, "SLACK");
    const otherUser = await createConnection(
      { spaceId: owner.spaceId, userId: other.userId },
      "GMAIL",
    );
    const otherWorkspace = await createConnection(
      { spaceId: other.spaceId, userId: owner.userId },
      "GMAIL",
    );

    const catalogs = await Promise.all(
      Array.from({ length: 4 }, () =>
        rpc<Array<{ slug: string; connected: boolean }>>(app, ownerCookie, "connections/catalog"),
      ),
    );
    for (const catalog of catalogs) {
      expect(catalog).toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: true }));
    }

    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
    await expect(statuses([otherProvider.id, otherUser.id, otherWorkspace.id])).resolves.toEqual([
      { id: otherProvider.id, status: "pending" },
      { id: otherUser.id, status: "pending" },
      { id: otherWorkspace.id, status: "pending" },
    ]);

    await rpc(app, ownerCookie, "connections/catalog");
    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
  });

  it("keeps a Composio connection out of the same user's other space", async () => {
    const cookie = await signup(app, `cross-space-connections-${stamp}@tangow.test`, "Cross Space");
    const actor = await rpc<Actor>(app, cookie, "me");
    const other = await rpc<Space>(app, cookie, "spaces/create", { name: `Second ${stamp}` });
    await connectRemote(composio, actor, "GMAIL");

    const current = await rpc<Array<{ slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
    );
    const elsewhere = await rpc<Array<{ slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      {},
      other.id,
    );

    expect(current).toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: true }));
    expect(elsewhere).toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: false }));
    await expect(
      handles.prisma.connection.findMany({
        where: { spaceId: other.id, userId: actor.userId, status: "connected" },
        select: { provider: true },
      }),
    ).resolves.toEqual([]);
  });

  it("keeps a second connected account for the same provider and renames it", async () => {
    const cookie = await signup(app, `multi-account-${stamp}@tangow.test`, "Multi Account");
    const first = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Personal",
    });
    const second = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Work",
    });
    await expect(
      rpc<Array<{ id: string; displayName: string; status: string }>>(
        app,
        cookie,
        "connections/list",
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.connectionId,
          displayName: "Personal",
          status: "connected",
        }),
        expect.objectContaining({
          id: second.connectionId,
          displayName: "Work",
          status: "connected",
        }),
      ]),
    );

    await expect(
      rpc<{ displayName: string }>(app, cookie, "connections/rename", {
        connectionId: second.connectionId,
        displayName: "Work inbox",
      }),
    ).resolves.toMatchObject({ displayName: "Work inbox" });

    await rpc(app, cookie, "connections/catalog");
    await expect(statuses([first.connectionId, second.connectionId])).resolves.toEqual([
      { id: first.connectionId, status: "connected" },
      { id: second.connectionId, status: "connected" },
    ]);

    await rpc(app, cookie, "connections/revoke", { connectionId: first.connectionId });
    await expect(
      rpc<Array<{ id: string; status: string }>>(app, cookie, "connections/list"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.connectionId, status: "revoked" }),
        expect.objectContaining({ id: second.connectionId, status: "connected" }),
      ]),
    );

    // Uninstall the remaining account: catalog must flip off Added (slug-only
    // emulator refs used to skip remote revoke and leave Gmail stuck connected).
    await rpc(app, cookie, "connections/revoke", { connectionId: second.connectionId });
    await expect(
      rpc<Array<{ slug: string; connected: boolean }>>(app, cookie, "connections/catalog", {
        connectorId: "composio",
      }),
    ).resolves.toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: false }));
  });

  it("returns the remote catalog when local reconciliation fails", async () => {
    const cookie = await signup(app, `db-failure-connections-${stamp}@tangow.test`, "DB Failure");
    const actor = await rpc<Actor>(app, cookie, "me");
    await connectRemote(composio, actor, "SLACK");
    const pending = await createConnection(actor, "SLACK");
    // Keep the rejection sticky: catalog reconciliation may call findMany more
    // than once, and a one-shot mock lets a later call mark the row connected.
    const failure = vi
      .spyOn(handles.prisma.connection, "findMany")
      .mockRejectedValue(new Error("simulated reconciliation failure"));

    // Scope to composio so a parallel managed provider cannot consume the one-shot findMany reject.
    const catalog = await rpc<Array<{ slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      { connectorId: "composio" },
    );

    expect(catalog).toContainEqual(expect.objectContaining({ slug: "SLACK", connected: true }));
    failure.mockRestore();
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
  });

  it("does not mutate local state when the provider catalog fails", async () => {
    const cookie = await signup(
      app,
      `provider-failure-connections-${stamp}@tangow.test`,
      "Provider Failure",
    );
    const actor = await rpc<Actor>(app, cookie, "me");
    const pending = await createConnection(actor, "GITHUB");
    const failure = vi
      .spyOn(composio, "catalog")
      .mockRejectedValueOnce(new Error("simulated provider failure"));

    await expect(
      rpc(app, cookie, "connections/catalog", { connectorId: "composio" }),
    ).resolves.toEqual([]);
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
    failure.mockRestore();
  });

  it("routes an emulated Composio app tool with user-scoped connection context", async () => {
    const cookie = await signup(app, `composio-tool-${stamp}@tangow.test`, "Composio Tool");
    const actor = await rpc<Actor>(app, cookie, "me");
    const started = await rpc<{ connectionId: string; authorizationUrl: null }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "composio", provider: "GMAIL", displayName: "Gmail" },
    );
    expect(started.authorizationUrl).toBeNull();
    const context = {
      operationId: "composio-product-test",
      traceId: "composio-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Gmail",
        },
      ],
    };
    const tools = (await handles.connectors.discoverTools(context)).filter(
      (candidate) => candidate.route?.connectorId === "composio",
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_SEND_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_LIST_LABELS",
    ]);
    const fetchTool = tools.find((tool) => tool.name === "GMAIL_FETCH_EMAILS");
    expect(fetchTool).toBeDefined();
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: fetchTool!.name,
        args: { query: "from:teammate", max_results: 5 },
        executionId: "composio-product-execution",
        route: fetchTool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          successful: true,
          data: expect.objectContaining({
            messages: [
              expect.objectContaining({
                messageId: "18c5f5d1a2b3c4d6",
                subject: "Quarterly planning notes",
              }),
            ],
            resultSizeEstimate: 1,
          }),
        }),
      }),
    );
    expect(composio.executions).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        tool: "GMAIL_FETCH_EMAILS",
        args: { query: "from:teammate", max_results: 5 },
      }),
    );
  });

  it("moves legacy MCP credentials and active owned-bot assignments once, preserving existing servers", async () => {
    const cookie = await signup(app, `mcp-move-${stamp}@tangow.test`, "MCP migration");
    const { spaceId, userId } = await rpc<Actor>(app, cookie, "me");
    const owner = { spaceId, userId };
    const otherCookie = await signup(app, `mcp-other-${stamp}@tangow.test`, "Other owner");
    const otherActor = await rpc<Actor>(app, otherCookie, "me");
    const other = { spaceId: otherActor.spaceId, userId: otherActor.userId };
    const secrets = new EncryptedSecretStore(TEST_ENCRYPTION_KEY);
    const active = await handles.prisma.bot.create({
      data: { ...owner, name: "Active", color: "#123456" },
    });
    const archived = await handles.prisma.bot.create({
      data: { ...owner, name: "Archived", color: "#123456", archivedAt: new Date() },
    });
    const otherBot = await handles.prisma.bot.create({
      data: { ...other, name: "Other", color: "#123456" },
    });
    const existing = await handles.prisma.mcpServer.create({
      data: {
        ...owner,
        name: "Existing",
        slug: "legacy",
        endpoint: "https://existing.example.test/mcp",
        transport: "sse",
      },
    });
    await handles.prisma.botMcpServer.create({
      data: {
        ...owner,
        botId: active.id,
        serverId: existing.id,
        allowAllTools: false,
        allowedTools: ["read"],
      },
    });
    const takenSecret = await secrets.put(JSON.stringify({ secret: "fake-oauth-token" }), {
      ...owner,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    });
    await handles.prisma.secret.create({ data: { ...owner, ...takenSecret, kind: "mcp" } });
    const taken = await handles.prisma.mcpServer.create({
      data: {
        ...owner,
        name: "Taken",
        slug: "taken",
        endpoint: "https://taken.example.test/mcp",
        transport: "streamable_http",
        secretId: takenSecret.id,
      },
    });
    const oldSecrets: string[] = [];
    for (const type of ["bearer", "header", "none", "existing", "taken", "broken"] as const) {
      const stored =
        type === "none"
          ? null
          : await secrets.put(`fake-${type}-token`, {
              ...owner,
              operationId: "test",
              traceId: "test",
              signal: new AbortController().signal,
            });
      if (stored) {
        oldSecrets.push(stored.id);
        await handles.prisma.secret.create({
          data: {
            ...owner,
            ...stored,
            ciphertext: type === "broken" ? "v2:invalid" : stored.ciphertext,
            kind: "connector",
          },
        });
      }
      await handles.prisma.capabilityInstall.create({
        data: {
          ...owner,
          kind: "mcp",
          name: "Legacy",
          source: `https://${type}.example.test/mcp`,
          secretId: stored?.id,
          config: {
            auth: {
              type: type === "existing" || type === "taken" || type === "broken" ? "bearer" : type,
              name: "X-Api-Key",
            },
            ...(type === "header" ? { headers: { "X-Region": "test" } } : {}),
          },
        },
      });
    }
    const warn = vi.fn();
    await moveMcpSources(handles.prisma, secrets, warn);
    const servers = await handles.prisma.mcpServer.findMany({
      where: owner,
      include: { secret: true, assignments: true },
    });
    expect(servers).toHaveLength(6);
    expect(new Set(servers.map((row) => row.slug)).size).toBe(6);
    const byHost = (host: string) =>
      servers.find(
        (row) => row.endpoint === `https://${host}.example.test/mcp` && row.id !== taken.id,
      )!;
    const credential = (row: (typeof servers)[number]) =>
      JSON.parse(secrets.load(row.secret!.ciphertext, row.secret!.id));
    expect(
      JSON.parse(secrets.load(byHost("bearer").secret!.ciphertext, byHost("bearer").secret!.id)),
    ).toEqual({ secret: "fake-bearer-token", env: {}, headers: {} });
    expect(
      JSON.parse(secrets.load(byHost("header").secret!.ciphertext, byHost("header").secret!.id)),
    ).toEqual({ env: {}, headers: { "X-Api-Key": "fake-header-token", "X-Region": "test" } });
    expect(byHost("none").secretId).toBeNull();
    expect(byHost("existing").id).toBe(existing.id);
    expect(byHost("existing").transport).toBe("sse");
    expect(credential(byHost("existing"))).toEqual({
      secret: "fake-existing-token",
      env: {},
      headers: {},
    });
    expect(credential(servers.find((row) => row.id === taken.id)!)).toEqual({
      secret: "fake-oauth-token",
    });
    expect(credential(byHost("taken"))).toMatchObject({ secret: "fake-taken-token" });
    expect(byHost("existing").assignments).toContainEqual(
      expect.objectContaining({ botId: active.id, allowAllTools: false, allowedTools: ["read"] }),
    );
    for (const row of servers.filter((row) => row.id !== existing.id && row.id !== taken.id)) {
      expect(row.assignments).toContainEqual(
        expect.objectContaining({ botId: active.id, allowAllTools: true }),
      );
      expect(
        row.assignments.some((link) => link.botId === archived.id || link.botId === otherBot.id),
      ).toBe(false);
    }
    expect(await handles.prisma.secret.count({ where: { id: { in: oldSecrets } } })).toBe(1);
    expect(await handles.prisma.capabilityInstall.count({ where: { ...owner, kind: "mcp" } })).toBe(
      1,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("token");
    await moveMcpSources(handles.prisma, secrets, warn);
    expect(
      await handles.prisma.mcpServer.findMany({
        where: owner,
        include: { secret: true, assignments: true },
      }),
    ).toEqual(servers);
  });

  async function createConnection(owner: Actor, provider: string) {
    return handles.prisma.connection.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        provider,
        displayName: provider,
        status: "pending",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, connectionOrdinal++)),
      },
    });
  }

  async function statuses(ids: string[]) {
    return handles.prisma.connection.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
  }
});

async function connectRemote(composio: ComposioEmulator, actor: Actor, provider: string) {
  await composio.begin(
    { provider, redirectUrl: "http://127.0.0.1.invalid/callback" },
    {
      operationId: "connections-test",
      traceId: "connections-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
  );
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (!response.ok) throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  return sessionCookieHeader(response);
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...(spaceId ? { "x-tangow-space-id": spaceId } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
