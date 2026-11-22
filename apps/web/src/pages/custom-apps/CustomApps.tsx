import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotMcpServer, DeclaredMcp, McpServer } from "@tangow/contracts";
import { deriveMcpApp } from "@tangow/core";
import {
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@tangow/ui-web";
import { Check, Ellipsis } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { AppEditor } from "./AppEditor";

export type DeclaredAppContext = { botId: string; serverId: string; onAdded: () => void };
type PendingApp = { server: McpServer; created: boolean; error: string; failed: boolean };

export function CustomApps({ declared }: { declared?: DeclaredAppContext }) {
  const { t } = useLingui();
  const tokenId = useId();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [assignments, setAssignments] = useState<BotMcpServer[]>([]);
  const [stdioEnabled, setStdioEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<PendingApp | null>(null);
  const [ready, setReady] = useState(false);
  const [declaredComplete, setDeclaredComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<McpServer | "stdio" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [need, setNeed] = useState<DeclaredMcp | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  async function refresh() {
    const [rows, agents, links] = await Promise.all([
      rpc.mcp.servers.list(),
      rpc.bots.list(),
      rpc.mcp.assignments.all(),
    ]);
    setServers(rows);
    setBots(agents.filter((bot) => !bot.archivedAt && bot.isOwner));
    setAssignments(links);
    setReady(true);
  }
  function report(err: unknown) {
    setError(err instanceof Error ? err.message : t`Could not connect`);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh().catch(report);
    void rpc.integrationSetup
      .get()
      .then((state) => setStdioEnabled(state.mcpStdioEnabled))
      .catch(report);
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = () => {
      void refresh().catch(report);
    };
    return () => channel.close();
  }, []);
  useEffect(() => {
    if (!declared) return;
    let active = true;
    void rpc.bots
      .declaredMcp({ botId: declared.botId, serverId: declared.serverId })
      .then((value) => {
        if (active) setNeed(value);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [declared?.botId, declared?.serverId]);

  async function connect(server: McpServer, created: boolean, withToken = false) {
    const ask = (error: string, failed = true) => {
      setEndpoint(server.endpoint ?? "");
      setPending({ server, created, error, failed });
    };
    try {
      const result = await connectMcpOauth(server.id);
      if (result === "token_required") {
        if (withToken) ask(t`This access token was refused.`);
        else ask(t`This app needs an access token.`, false);
      } else {
        if (result === "cancelled" && created) await rpc.mcp.servers.remove({ id: server.id });
        setPending(null);
        setEndpoint("");
        setSecret("");
      }
    } catch (err) {
      ask(err instanceof Error ? err.message : t`Could not connect`);
    }
    await refresh();
  }
  async function add() {
    if (pending) {
      await rpc.mcp.servers.update({ id: pending.server.id, secret });
      await connect(pending.server, pending.created, true);
      return;
    }
    const url = new URL(endpoint.trim());
    const existing = servers.find(
      (server) => server.endpoint && new URL(server.endpoint).href === url.href,
    );
    const server =
      existing ??
      (await rpc.mcp.servers.create({
        ...deriveMcpApp(url.href),
        botIds: bots.map((bot) => bot.id),
      }));
    await connect(server, !existing);
  }
  async function addDeclared() {
    if (!need || !declared) return;
    const values = (keys: string[]) =>
      Object.fromEntries(
        keys.flatMap((key) => (credentials[key] ? [[key, credentials[key]]] : [])),
      );
    await rpc.bots.addDeclaredMcp({
      botId: declared.botId,
      serverId: need.serverId,
      headers: values(need.headerKeys),
      env: values(need.envKeys),
      secret: secret || undefined,
    });
    declared.onAdded();
    setDeclaredComplete(true);
    setNeed(null);
    setSecret("");
    setCredentials({});
    await refresh();
  }
  async function toggle(server: McpServer, botId: string) {
    const current = assignments.filter((entry) => entry.botId === botId);
    const next = current.some((entry) => entry.serverId === server.id)
      ? current.filter((entry) => entry.serverId !== server.id)
      : [...current, { serverId: server.id, allowAllTools: true, allowedTools: [] }];
    await rpc.mcp.assignments.replace({ botId, assignments: next });
    await refresh();
  }
  return (
    <div className="rk-scroll flex-1 space-y-4 overflow-y-auto px-8 py-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Card>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(need ? addDeclared : add);
            }}
          >
            {need ? (
              <>
                <Input aria-label={t`Server name`} value={need.name} readOnly />
                <Input
                  aria-label={need.transport === "stdio" ? t`Command` : t`App URL`}
                  value={need.endpoint ?? [need.command, ...need.args].join(" ")}
                  readOnly
                />
                {need.headerKeys.concat(need.envKeys).map((key) => (
                  <Input
                    key={key}
                    aria-label={key}
                    type="password"
                    placeholder={key}
                    value={credentials[key] ?? ""}
                    onChange={(event) =>
                      setCredentials({ ...credentials, [key]: event.target.value })
                    }
                  />
                ))}
              </>
            ) : (
              <Input
                aria-label={t`App URL`}
                type="url"
                required
                placeholder="https://example.com/mcp"
                value={endpoint}
                disabled={busy || Boolean(pending) || Boolean(declared && !declaredComplete)}
                onChange={(event) => setEndpoint(event.target.value)}
              />
            )}
            {pending || need ? (
              <>
                {pending ? (
                  <p
                    role="alert"
                    className={`text-sm ${pending.failed ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {pending.error}
                  </p>
                ) : null}
                <label htmlFor={tokenId} className="block space-y-2 text-sm">
                  <span>
                    <Trans>Access token</Trans>
                  </span>
                  <Input
                    id={tokenId}
                    type="password"
                    autoComplete="new-password"
                    placeholder={t`Stored encrypted`}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    required={Boolean(pending)}
                  />
                </label>
              </>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={busy || !ready || Boolean(declared && !declaredComplete && !need)}
              >
                <Trans>Add</Trans>
              </Button>
              {pending ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (pending.created) await rpc.mcp.servers.remove({ id: pending.server.id });
                      setPending(null);
                      setSecret("");
                      setEndpoint("");
                      await refresh();
                    })
                  }
                >
                  <Trans>Cancel</Trans>
                </Button>
              ) : null}
            </div>
          </form>
          {stdioEnabled && !declared && !pending ? (
            <Button
              variant="link"
              size="xs"
              className="mt-2 px-0"
              disabled={busy}
              onClick={() => setEditor("stdio")}
            >
              <Trans>stdio command</Trans>
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {editor ? (
        <AppEditor
          key={typeof editor === "string" ? editor : editor.id}
          server={editor === "stdio" ? undefined : editor}
          stdioEnabled={stdioEnabled}
          botIds={bots.map((bot) => bot.id)}
          onCancel={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await refresh();
          }}
        />
      ) : null}
      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Paste an app's MCP URL to give it to your agents.</Trans>
        </p>
      ) : null}
      {servers.map((server) => (
        <Card key={server.id} size="sm">
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{server.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {server.endpoint ? new URL(server.endpoint).host : server.command}
                </p>
              </div>
              <DropdownMenu onOpenChange={() => setConfirmDelete(null)}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Actions for ${server.name}`}
                    />
                  }
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditor(server)}>
                    <Trans>Edit</Trans>
                  </DropdownMenuItem>
                  {server.oauthStatus !== "none" ? (
                    <DropdownMenuItem
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await rpc.mcp.oauth.disconnect({ serverId: server.id });
                          await refresh();
                        })
                      }
                    >
                      <Trans>Disconnect</Trans>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    closeOnClick={confirmDelete === server.id}
                    disabled={busy}
                    onClick={() => {
                      if (confirmDelete !== server.id) {
                        setConfirmDelete(server.id);
                        return;
                      }
                      void run(async () => {
                        await rpc.mcp.servers.remove({ id: server.id });
                        await refresh();
                      });
                    }}
                  >
                    {confirmDelete === server.id ? (
                      <Trans>Confirm delete</Trans>
                    ) : (
                      <Trans>Delete</Trans>
                    )}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {server.oauthStatus === "reconnect" ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-warning">
                  <Trans>Reconnect needed</Trans>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => connect(server, false))}
                >
                  <Trans>Reconnect</Trans>
                </Button>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {bots.map((bot) => {
                const assigned = assignments.some(
                  (entry) => entry.botId === bot.id && entry.serverId === server.id,
                );
                return (
                  <Button
                    key={bot.id}
                    size="xs"
                    variant={assigned ? "default" : "outline"}
                    className="rounded-full"
                    aria-pressed={assigned}
                    disabled={busy}
                    onClick={() => void run(() => toggle(server, bot.id))}
                  >
                    {assigned ? <Check aria-hidden /> : null}
                    {bot.name}
                  </Button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
