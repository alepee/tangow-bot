import { Trans, useLingui } from "@lingui/react/macro";
import type { IntegrationSetupState } from "@tangow/contracts";
import { Button, Input } from "@tangow/ui-web";
import { Check } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

type Choice = "direct" | "composio" | "executor";

export function IntegrationSetup({
  onDone,
  initialState,
  botId,
  onServerConnected,
}: {
  onDone?: () => void;
  initialState?: IntegrationSetupState | null;
  botId?: string;
  onServerConnected?: (id: string) => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [state, setState] = useState<IntegrationSetupState | null>(initialState ?? null);
  const [selectedChoice, setChoice] = useState<Choice>("direct");
  const choice = selectedChoice;
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices: { id: Choice; label: string }[] = [
    { id: "direct", label: t`Direct MCP` },
    { id: "composio", label: "Composio" },
    { id: "executor", label: "Executor" },
  ];
  const managed = choice === "composio";
  const hasCredentials = Boolean(apiKey.trim());
  const configured = state?.providers.find((provider) => provider.id === choice)?.configured;
  useEffect(() => {
    if (initialState) return;
    void rpc.integrationSetup
      .get()
      .then(setState)
      .catch(() => setError(t`Could not load integrations`));
  }, [initialState]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      setBusy(false);
    }
  }

  async function saveProvider() {
    await run(async () => {
      await rpc.integrationSetup.save({ provider: "composio", apiKey });
      setApiKey("");
      setState(await rpc.integrationSetup.get());
      onDone?.();
    });
  }

  async function connect(name: string, url: string) {
    await run(async () => {
      const existing = (await rpc.mcp.servers.list()).find((server) => server.endpoint === url);
      const server =
        existing ??
        (await rpc.mcp.servers.create({
          slug: `integration-${crypto.randomUUID().slice(0, 8)}`,
          name,
          transport: "streamable_http",
          endpoint: url,
          ...(apiKey.trim() ? { secret: apiKey.trim() } : {}),
        }));
      if (existing && apiKey.trim()) {
        await rpc.mcp.servers.update({ id: existing.id, secret: apiKey.trim() });
      }
      const result = await connectMcpOauth(server.id);
      if (result === "cancelled") return;
      if (botId) await rpc.mcp.assignments.approve({ botId, serverId: server.id });
      onServerConnected?.(server.id);
    });
  }

  if (!state?.canConfigure) return error ? <p role="alert">{error}</p> : null;

  return (
    <div className="space-y-6">
      <h1 className="text-[32px] font-medium text-foreground">{t`Server integrations`}</h1>
      <fieldset
        aria-label={t`Integration options`}
        className="overflow-hidden rounded-card bg-group shadow-group"
      >
        {choices.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={choice === id}
            disabled={busy}
            onClick={() => {
              setChoice(id);
              setApiKey("");
              setError(null);
            }}
            className={`flex min-h-11 w-full items-center justify-between border-b border-border px-3.5 py-2.5 text-left last:border-0 ${choice === id ? "bg-muted" : "hover:bg-accent"}`}
          >
            <span>{label}</span>
            {choice === id ? <Check className="size-4" aria-hidden /> : null}
          </button>
        ))}
      </fieldset>
      {managed ? (
        <>
          {configured ? (
            <p className="text-sm text-success">
              <Trans>Connected</Trans>
            </p>
          ) : null}
          {state?.canConfigure ? (
            <>
              <label htmlFor={`${fieldId}-key`} className="block text-sm">
                {t`API key`}
                <Input
                  id={`${fieldId}-key`}
                  className="mt-2"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <a
                className="text-sm text-muted-foreground underline"
                href="https://dashboard.composio.dev"
                target="_blank"
                rel="noreferrer"
              >
                <Trans>Get credentials</Trans>
              </a>
              {!onDone ? (
                <Button
                  className="ml-3"
                  disabled={busy || !hasCredentials}
                  onClick={() => void saveProvider()}
                >
                  {busy ? t`Connecting…` : t`Connect`}
                </Button>
              ) : null}
            </>
          ) : state && !configured ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Ask the server owner to configure this provider.</Trans>
            </p>
          ) : null}
        </>
      ) : null}
      {choice === "direct" ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">
            <Trans>Add server URL</Trans>
          </summary>
          <div className="mt-3 space-y-3">
            <Input
              aria-label={t`Server URL`}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://example.com/mcp"
            />
            <Button
              disabled={busy || !endpoint.trim()}
              onClick={() => void connect("MCP server", endpoint.trim())}
            >
              <Trans>Connect</Trans>
            </Button>
          </div>
        </details>
      ) : null}
      {choice === "executor" ? (
        <div className="space-y-3">
          <label htmlFor={`${fieldId}-endpoint`} className="block text-sm">
            <Trans>Server URL</Trans>
            <Input
              id={`${fieldId}-endpoint`}
              className="mt-2"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="http://localhost:8000/mcp"
            />
          </label>
          <label htmlFor={`${fieldId}-token`} className="block text-sm">
            <Trans>Access token</Trans>
            <Input
              id={`${fieldId}-token`}
              className="mt-2"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </label>
          <Button
            disabled={busy || !endpoint.trim()}
            onClick={() => void connect("Executor", endpoint.trim())}
          >
            <Trans>Connect</Trans>
          </Button>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">
              <Trans>Setup help</Trans>
            </summary>
            <a
              href="https://executor.sh/#get-started"
              target="_blank"
              rel="noreferrer"
              className="mt-2 block underline"
            >
              <Trans>Download Executor</Trans>
            </a>
          </details>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {onDone ? (
        <div className="flex gap-3">
          <Button
            disabled={
              busy ||
              (managed && state?.canConfigure && !hasCredentials && (!configured || hasCredentials))
            }
            onClick={() => {
              if (managed && hasCredentials) void saveProvider();
              else onDone();
            }}
          >
            {busy ? t`Connecting…` : t`Continue`}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onDone}>
            <Trans>Skip</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
