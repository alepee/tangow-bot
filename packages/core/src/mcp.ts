import { getDomainWithoutSuffix } from "tldts";

export function deriveMcpSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `mcp-${Date.now()}`
  );
}

export function deriveMcpApp(endpoint: string) {
  const url = new URL(endpoint.trim());
  const host = url.hostname.replace(/^(?:(?:mcp|api|www)\.)+/, "");
  const label = getDomainWithoutSuffix(host) ?? host.split(".")[0] ?? host;
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return {
    name,
    slug: deriveMcpSlug(name),
    endpoint: url.href,
    transport: url.pathname.endsWith("/sse") ? ("sse" as const) : ("streamable_http" as const),
  };
}
