import { isIP } from "node:net";
import type { ResolveHostname } from "./remote-mcp.js";

type EmulatorRecord = {
  provider: "mcp";
  operation: string;
  host: string;
  authenticated?: boolean;
  args?: Record<string, unknown>;
};

/** Expected Executor test bearer. Compared at the boundary; never written into records. */
const EXPECTED_EXECUTOR_BEARER = "Bearer fake-executor-credential-value";

/** Deterministic HTTP/MCP boundary emulator used by integration and browser journeys. */
export class ThirdPartyConnectorEmulator {
  readonly records: EmulatorRecord[] = [];
  readonly resolveHostname: ResolveHostname = async () => [{ address: "8.8.8.8", family: 4 }];

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = urlFromPinnedFetch(input, init);
    if (url.hostname === "mcp.example.test" || url.hostname === "executor.example.test") {
      return this.mcp(url, init);
    }
    throw new Error(`Third-party connector emulator received unexpected URL ${url}`);
  };

  private async mcp(url: URL, init?: RequestInit): Promise<Response> {
    const request = parseBody(init?.body);
    const method = String(request.method ?? "");
    const id = request.id;
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    // Validate bearer at the boundary; persist only the boolean, never the secret.
    const authenticated =
      url.hostname === "executor.example.test"
        ? authorization === EXPECTED_EXECUTOR_BEARER
        : Boolean(authorization?.startsWith("Bearer ") && authorization.length > "Bearer ".length);
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "initialize") {
      return jsonRpc(id, {
        protocolVersion: String(
          (request.params as Record<string, unknown> | undefined)?.protocolVersion ?? "2025-06-18",
        ),
        capabilities: { tools: {} },
        serverInfo: { name: "tangow-third-party-emulator", version: "1.0.0" },
      });
    }
    if (method === "tools/list") {
      this.records.push({
        provider: "mcp",
        operation: "tools/list",
        host: url.hostname,
        authenticated,
      });
      return jsonRpc(id, {
        tools: [
          {
            name: "notes.write",
            description: "Write a deterministic emulated note",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
    }
    if (method === "tools/call") {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      this.records.push({
        provider: "mcp",
        operation: String(params.name ?? "unknown"),
        host: url.hostname,
        authenticated,
        args,
      });
      const result = { ok: true, text: args.text ?? null };
      return jsonRpc(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }
    return jsonRpcError(id, -32601, `Unhandled MCP method ${method}`);
  }
}

function urlFromPinnedFetch(input: string | URL | Request, init?: RequestInit): URL {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) === 0) return url;
  const host = new Headers(init?.headers).get("host");
  if (!host) return url;
  const routed = new URL(url);
  routed.host = host;
  return routed;
}

function parseBody(body: RequestInit["body"] | undefined): Record<string, unknown> {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  }
  return {};
}

function jsonRpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}
