import { Trans, useLingui } from "@lingui/react/macro";
import type { McpServer, McpServerConfigInput, McpTransport } from "@tangow/contracts";
import { deriveMcpSlug } from "@tangow/core";
import { Button, Card, CardContent, Input, NativeSelect, NativeSelectOption } from "@tangow/ui-web";
import { useId, useState } from "react";
import { rpc } from "../../lib/rpc";

export function AppEditor({
  server,
  stdioEnabled,
  botIds,
  onCancel,
  onSaved,
}: {
  server?: McpServer;
  stdioEnabled: boolean;
  botIds: string[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const tokenId = useId();
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [endpoint, setEndpoint] = useState(server?.endpoint ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState(server?.args.join(" ") ?? "");
  const [header, setHeader] = useState(server?.headerKeys[0] ?? "Authorization");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const base = {
        name,
        slug: server?.slug ?? deriveMcpSlug(name),
        description: server?.description ?? "",
        enabled: server?.enabled ?? true,
      };
      const config: McpServerConfigInput =
        transport === "stdio"
          ? {
              ...base,
              transport,
              command,
              args: args.split(/\s+/).filter(Boolean),
              env: {},
              ...(secret ? { secret } : {}),
            }
          : {
              ...base,
              transport,
              endpoint,
              headers: secret && header !== "Authorization" ? { [header]: secret } : {},
              ...(secret && header === "Authorization" ? { secret } : {}),
            };
      if (server) await rpc.mcp.servers.update({ id: server.id, config });
      else await rpc.mcp.servers.create({ ...config, botIds });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label={t`Server name`}
            placeholder={t`Server name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <NativeSelect
            aria-label={t`Transport`}
            value={transport}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "stdio" || value === "sse" || value === "streamable_http")
                setTransport(value);
            }}
          >
            <NativeSelectOption value="streamable_http">HTTP</NativeSelectOption>
            <NativeSelectOption value="sse">SSE</NativeSelectOption>
            {stdioEnabled || server?.transport === "stdio" ? (
              <NativeSelectOption value="stdio">STDIO</NativeSelectOption>
            ) : null}
          </NativeSelect>
          {transport === "stdio" ? (
            <>
              <Input
                aria-label={t`Command`}
                placeholder={t`Command`}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                required
              />
              <Input
                aria-label={t`Arguments`}
                placeholder={t`Arguments`}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </>
          ) : (
            <>
              <Input
                aria-label={t`App URL`}
                type="url"
                placeholder="https://example.com/mcp"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                required
              />
              <Input
                aria-label={t`Header name`}
                value={header}
                onChange={(event) => setHeader(event.target.value)}
                required
              />
            </>
          )}
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
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {server ? <Trans>Save</Trans> : <Trans>Add</Trans>}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
