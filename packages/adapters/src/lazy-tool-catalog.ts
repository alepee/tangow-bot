import type {
  ConnectorCall,
  ConnectorEvent,
  ConnectorRoute,
  ConnectorTool,
} from "@tangow/adapter-kit";
import { TANGOW_TOOL_PREFIX } from "@tangow/adapter-kit";
import { z } from "zod";
import { ConnectorError } from "./connector-error.js";

export const DIRECT_TOOL_LIMIT = 20;
export const TOOL_SEARCH_LIMIT = 10;
export const SELECTED_SCHEMA_MAX_BYTES = 100_000;
const INDEX_GROUP_NAME_LIMIT = 100;
const CATALOG_INDEX_MAX_BYTES = 16_384;
const MAX_QUERY_LENGTH = 200;
const MAX_GROUP_LENGTH = 200;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_TOOL_ID_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 500;
export const CATALOG_SEARCH = "__catalog_search";
export const CATALOG_LOAD = "__catalog_load";
export const CATALOG_EXECUTE = "__catalog_execute";

/** Only for a `native-loop` worker harness, whose tool_search loads exact names. */
export const EXACT_TOOL_SEARCH_TEXT = `tool_search loads a deferred tool when given its exact name, with or without the ${TANGOW_TOOL_PREFIX} prefix, and searches by keyword otherwise; a catalog it cannot reach offers its own search, load and execute tools.`;

type CatalogEntry = { id: string; tool: ConnectorTool; group: string };

export type CatalogSearchHit = {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
};

export type CatalogSearchResult =
  | { tools: CatalogSearchHit[] }
  | { index: Array<{ group: string; names: string[] }> }
  | { groups: Array<{ group: string; count: number }>; hint: string }
  | { group: string; names: string[]; error?: string }
  | { group: string; count: number; hint: string };

export function lazyCatalogTools(
  prefix: string,
  connectorId: string,
  label: string,
  entries: CatalogEntry[] = [],
): ConnectorTool[] {
  return [
    {
      name: `${prefix}_search_tools`,
      description: `Search connected ${label} tools. Empty query lists sources. Pass group to list names in one source, or query to search.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: MAX_QUERY_LENGTH,
            description: "Words describing the tool to find. Omit to list names by source.",
          },
          group: {
            type: "string",
            maxLength: MAX_GROUP_LENGTH,
            description: "Source name to list or search within",
          },
          limit: { type: "integer", minimum: 1, maximum: TOOL_SEARCH_LIMIT },
        },
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_SEARCH },
    },
    {
      name: `${prefix}_load_tool`,
      description: `Load one ${label} tool's parameters by id.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description: "Exact tool ID returned by search",
          },
        },
        required: ["id"],
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_LOAD },
    },
    {
      name: `${prefix}_execute_tool`,
      description: `Run an ${label} tool by id.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description: "Exact tool ID returned by search",
          },
          arguments: { type: "object", description: "Arguments matching the loaded schema" },
        },
        required: ["id", "arguments"],
      },
      route: { connectorId, toolName: CATALOG_EXECUTE },
      catalog: entries,
    },
  ];
}

export function isLazyCatalogControlRoute(route: ConnectorRoute | undefined): boolean {
  return Boolean(
    route &&
      !route.resourceId &&
      (route.toolName === CATALOG_SEARCH ||
        route.toolName === CATALOG_LOAD ||
        route.toolName === CATALOG_EXECUTE),
  );
}

export function catalogEntries(tools: ConnectorTool[]): CatalogEntry[] {
  return tools
    .map((tool) => ({ id: catalogEntryId(tool), tool, group: catalogGroupOf(tool) }))
    .filter(
      ({ id, tool }) =>
        id.length <= MAX_TOOL_ID_LENGTH &&
        tool.name.length > 0 &&
        tool.name.length <= MAX_TOOL_NAME_LENGTH,
    );
}

export function searchCatalog(
  entries: CatalogEntry[],
  args: Record<string, unknown>,
): CatalogSearchResult {
  const query = String(args.query ?? "")
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
  const groupFilter = String(args.group ?? "")
    .slice(0, MAX_GROUP_LENGTH)
    .trim();
  const scoped = groupFilter ? entries.filter((entry) => entry.group === groupFilter) : entries;

  if (!query) {
    if (groupFilter) {
      if (scoped.length === 0) {
        return {
          group: groupFilter,
          names: [],
          error: "Unknown or empty group",
        };
      }
      const group = scoped[0]!.group;
      const names = listNames(scoped);
      if (Buffer.byteLength(JSON.stringify(names), "utf8") > CATALOG_INDEX_MAX_BYTES) {
        return {
          group,
          count: names.length,
          hint: "Pass query to search within this source.",
        };
      }
      return { group, names };
    }
    const grouped = groupedNames(scoped);
    if (Buffer.byteLength(JSON.stringify(grouped), "utf8") > CATALOG_INDEX_MAX_BYTES) {
      return {
        groups: grouped.map(({ group, names }) => ({ group, count: names.length })),
        hint: "Pass group to list names in one source.",
      };
    }
    return { index: grouped };
  }

  const requested = Number(args.limit ?? TOOL_SEARCH_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.trunc(requested)))
    : TOOL_SEARCH_LIMIT;
  return {
    tools: new Bm25Ranker().rank(query, scoped, limit).map(({ entry }) => ({
      id: entry.id,
      name: entry.tool.name,
      description: entry.tool.description.slice(0, MAX_DESCRIPTION_LENGTH),
      readOnly: entry.tool.readOnly === true,
    })),
  };
}

export function loadCatalogEntry<Entry extends Pick<CatalogEntry, "id" | "tool">>(
  entries: readonly Entry[],
  args: Record<string, unknown>,
): Entry {
  const id = String(args.id ?? "");
  const byId = entries.find((candidate) => candidate.id === id);
  if (byId) {
    assertSchemaSize(byId);
    return byId;
  }
  const byName = entries.filter((candidate) => candidate.tool.name === id);
  if (byName.length === 1) {
    assertSchemaSize(byName[0]!);
    return byName[0]!;
  }
  const byShort = entries.filter((candidate) => catalogShortName(candidate) === id);
  if (byShort.length === 1) {
    assertSchemaSize(byShort[0]!);
    return byShort[0]!;
  }
  throw new Error("Tool is unknown or not authorized for this bot");
}

function assertSchemaSize(entry: Pick<CatalogEntry, "tool">): void {
  const schemaBytes = Buffer.byteLength(JSON.stringify(entry.tool.inputSchema), "utf8");
  if (schemaBytes > SELECTED_SCHEMA_MAX_BYTES) throw new Error("Tool schema is too large");
}

export function resolveCatalogCall(
  call: ConnectorCall,
  entries: CatalogEntry[],
): { call: ConnectorCall; tool: ConnectorTool } {
  const entry = loadCatalogEntry(entries, call.args);
  const args = call.args.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ConnectorError("invalid_arguments", "Tool arguments must be an object");
  }
  const parsed = parseConnectorToolArgs(entry.tool.inputSchema, args as Record<string, unknown>);
  return {
    tool: entry.tool,
    call: {
      ...call,
      tool: entry.tool.name,
      args: parsed,
      route: entry.tool.route,
    },
  };
}

export function parseConnectorToolArgs(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // Zod's fromJSONSchema currently builds loose records for patternProperties and
  // skips additionalProperties: false, so reject that combination instead of
  // letting non-matching keys reach connector execution.
  if (inputSchema.patternProperties != null && inputSchema.additionalProperties === false) {
    throw new Error(
      "Tool schema is unsupported: patternProperties with additionalProperties false",
    );
  }
  const schema = z.fromJSONSchema(inputSchema as never);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new ConnectorError(
      "invalid_arguments",
      `Tool arguments are invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data as Record<string, unknown>;
}

export function assertConnectorToolArgs(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  parseConnectorToolArgs(inputSchema, args);
}

export async function* executeLazyCatalogControl(
  call: ConnectorCall,
  entries: CatalogEntry[],
  executeResolved: (resolved: ConnectorCall) => AsyncIterable<ConnectorEvent>,
): AsyncIterable<ConnectorEvent> {
  if (call.route?.toolName === CATALOG_SEARCH) {
    yield { type: "result", data: searchCatalog(entries, call.args) };
    return;
  }
  if (call.route?.toolName === CATALOG_LOAD) {
    const entry = loadCatalogEntry(entries, call.args);
    yield {
      type: "result",
      data: {
        id: call.args.id,
        name: entry.tool.name,
        description: entry.tool.description.slice(0, MAX_DESCRIPTION_LENGTH),
        inputSchema: entry.tool.inputSchema,
        readOnly: entry.tool.readOnly === true,
      },
    };
    return;
  }
  const resolved = resolveCatalogCall(call, entries);
  yield* executeResolved(resolved.call);
}

export function catalogIndexText(tools: ConnectorTool[]): string {
  const groups = tools
    .filter((tool) => tool.catalog?.length)
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((catalog) => {
      const prefix = catalog.name.replace(/_execute_tool$/, "");
      const byGroup = new Map<string, ConnectorTool[]>();
      for (const { tool } of catalog.catalog!) {
        const group = catalogGroupOf(tool);
        const members = byGroup.get(group) ?? [];
        members.push(tool);
        byGroup.set(group, members);
      }
      return [...byGroup.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([group, members]) => ({
          prefix,
          group,
          count: members.length,
          names: members
            .filter((tool) => members.length <= INDEX_GROUP_NAME_LIMIT || tool.featured)
            .map((tool) => tool.name)
            .sort((left, right) => left.localeCompare(right)),
        }));
    });
  if (groups.length === 0) return "";
  let omitted = false;
  const render = () => {
    const lines = ["## Connected tool catalog"];
    let previous: string | undefined;
    for (const { prefix, group, count, names } of groups) {
      if (prefix !== previous) {
        lines.push(
          `\n${prefix}: use the tool search of your harness, or ${prefix}_load_tool when offered, to discover parameters.`,
        );
        previous = prefix;
      }
      lines.push(`  ${group}: ${count} tools.${names.length ? `\n    ${names.join(", ")}` : ""}`);
    }
    if (omitted) lines.push("Additional groups omitted. Use tool search to discover them.");
    return lines.join("\n");
  };
  let text = render();
  // Trim the largest name lists first; all catalog entries remain available.
  for (const group of [...groups].sort(
    (left, right) =>
      Buffer.byteLength(right.names.join(", "), "utf8") -
      Buffer.byteLength(left.names.join(", "), "utf8"),
  )) {
    if (Buffer.byteLength(text, "utf8") <= CATALOG_INDEX_MAX_BYTES) return text;
    group.names = [];
    text = render();
  }
  while (Buffer.byteLength(text, "utf8") > CATALOG_INDEX_MAX_BYTES) {
    groups.pop();
    omitted = true;
    text = render();
  }
  return text;
}

function catalogEntryId(tool: ConnectorTool): string {
  const route = tool.route;
  if (!route?.resourceId) return tool.name;
  return `${route.resourceId}:${encodeURIComponent(route.toolName)}`;
}

function catalogGroupOf(tool: ConnectorTool): string {
  const labeled = tool.route?.catalogGroup?.trim();
  if (labeled) return labeled.slice(0, MAX_GROUP_LENGTH);
  return "other";
}

function catalogShortName(entry: Pick<CatalogEntry, "tool">): string {
  const routeName = entry.tool.route?.toolName?.trim();
  if (routeName) return routeName;
  return entry.tool.name;
}

function groupedNames(entries: CatalogEntry[]): Array<{ group: string; names: string[] }> {
  const byGroup = new Map<string, string[]>();
  for (const entry of entries) {
    const names = byGroup.get(entry.group) ?? [];
    names.push(catalogShortName(entry));
    byGroup.set(entry.group, names);
  }
  return [...byGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, names]) => ({
      group,
      names: [...new Set(names)].sort((left, right) => left.localeCompare(right)),
    }));
}

function listNames(entries: CatalogEntry[]): string[] {
  return [...new Set(entries.map(catalogShortName))].sort((left, right) =>
    left.localeCompare(right),
  );
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

/** Okapi BM25 over tool names and descriptions, excluding schema text. */
class Bm25Ranker {
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  rank(
    query: string,
    entries: CatalogEntry[],
    limit: number,
  ): Array<{ entry: CatalogEntry; score: number }> {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || entries.length === 0 || limit <= 0) return [];
    const nameScores = this.scores(
      queryTerms,
      entries.map(({ tool }) => `${tool.name} ${tool.name.replaceAll("_", " ")}`),
    );
    const descriptionScores = this.scores(
      queryTerms,
      entries.map(({ tool }) => tool.description),
    );
    // Weight name BM25 at 3x description BM25: plain BM25 buries named operations with long descriptions.
    return entries
      .map((entry, index) => ({
        entry,
        score: 3 * nameScores[index]! + descriptionScores[index]!,
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.tool.name.localeCompare(right.entry.tool.name) ||
          left.entry.id.localeCompare(right.entry.id),
      )
      .slice(0, limit);
  }

  private scores(queryTerms: string[], documents: string[]): number[] {
    const termCounts = documents.map((text) => {
      const counts = new Map<string, number>();
      for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
      return counts;
    });
    const lengths = termCounts.map((counts) =>
      [...counts.values()].reduce((sum, count) => sum + count, 0),
    );
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
    const idf = new Map(
      queryTerms.map((term) => {
        const frequency = termCounts.filter((counts) => counts.has(term)).length;
        return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
      }),
    );
    return documents.map((_document, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const count = termCounts[index]!.get(term);
        if (!count) continue;
        const norm = this.k1 * (1 - this.b + (this.b * lengths[index]!) / averageLength);
        score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
      }
      return score;
    });
  }
}
