import type {
  AgentHistoryTurn,
  AskQuestion,
  ConnectionCatalogItem,
  ModelCategory,
  RunModelDecision,
  SandboxKind,
} from "@tangow/contracts";
import type { HelperProfile } from "@tangow/core";
import type { RunPersistence, RunResumeEvent } from "./run-snapshot.js";
import type { SkillCollision, WorkerSkill } from "./worker-protocol.js";

export interface AdapterContext {
  operationId: string;
  traceId: string;
  spaceId: string;
  userId: string;
  botId?: string;
  /** Someone the bot is shared with, whose run this is; unset for the owner's own runs. */
  memberId?: string;
  runId?: string;
  /** Opaque fence for releasing a graphical screen without tearing down its replacement. */
  screenLeaseId?: string;
  /** When releasing a screen after cancel, also stop orphaned browser work on that screen. */
  cancelRunWork?: boolean;
  signal: AbortSignal;
  /** Connected external accounts available to this run, including their owning connector. */
  connectedConnections?: ConnectedConnector[];
  /** @deprecated Prefer connectedConnections so providers with the same app slug cannot collide. */
  connectedProviders?: string[];
}

export interface ConnectedConnector {
  id: string;
  connectorId: string;
  externalId: string;
  displayName: string;
  providerRef?: string;
}

export interface AdapterDescriptor<TCapabilities> {
  id: string;
  contractVersion: string;
  adapterVersion: string;
  capabilities: TCapabilities;
}

/**
 * In-process OAuth material for a single agent run. Not part of any RPC or
 * persisted contract. Extra provider fields such as `accountId` are copied
 * through at runtime.
 */
export interface AgentModelOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface PortableFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
  /** Permission bits (`0o777`), when the source knows them. */
  mode?: number;
}

export interface ComputerRef {
  id: string;
  botId: string;
  kind: SandboxKind;
  providerRef: string;
  /** Immutable environment release, preserved when reconnecting. */
  releaseRef?: string | null;
  /** True when the provider created an empty replacement rather than reconnecting existing state. */
  fresh?: boolean;
  /**
   * On a machine whose home is on volumes, the workspace directories on a volume ("" for all of
   * it). Files written anywhere else would be lost with the machine, so writes there are refused.
   */
  writableRoots?: string[];
}

export interface CommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  /** Maximum wall-clock runtime before the command and its descendants are terminated. */
  timeoutMs?: number;
}

export type ProcessEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

export interface ScreenRequest {
  view: "stream" | "snapshot";
  /** Request a separately authorized control stream instead of the read-only viewer. */
  interactive?: boolean;
  /** Fences an interactive stream so an older lease cannot revoke its replacement. */
  controlToken?: string;
}

export interface ScreenSession {
  url: string | null;
  /** Host header for a `url` that points at a gateway routing screens by host name. */
  host?: string;
  mimeType: string;
  close(): Promise<void>;
}

export type ComputerInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | {
      kind: "pointer";
      x: number;
      y: number;
      button?: "left" | "right";
      type: "move" | "down" | "up" | "click";
    }
  | { kind: "clipboard"; text: string };

export type ComputerAction =
  | ComputerInput
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "wait"; ms: number }
  | { kind: "open"; path: string }
  | { kind: "launch"; application: string; uri?: string };

export interface ComputerObservation {
  frameId: string;
  capturedAt: string;
  mimeType: "image/png" | "image/jpeg";
  image: Uint8Array;
  width: number;
  height: number;
  cursor?: { x: number; y: number };
  activeWindow?: { id: string; title?: string };
}

export interface ComputerActionRequest {
  actions: ComputerAction[];
  observe?: boolean;
  settleMs?: number;
}

export interface ComputerActionResult {
  completed: number;
  observation?: ComputerObservation;
}

export interface ComputerFileEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  executable?: boolean;
}

export type AgentToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

/** A provider-neutral tool result an agent runtime can forward without flattening images. */
export interface AgentToolExecutionResult {
  kind: "agent_tool_result";
  content: AgentToolResultContent[];
  details: unknown;
}

/** Ephemeral completion data for audit hooks; result contents must be redacted before persistence. */
export interface AgentToolCompletion {
  name: string;
  executionId: string;
  durationMs: number;
  result?: unknown;
  error?: unknown;
  paused?: boolean;
}

export interface ControlLeaseRef {
  leaseId: string;
  holder: "user" | "bot";
  fence: number;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
}

export interface SandboxCapabilities {
  graphical: boolean;
  pty: boolean;
  snapshots: boolean;
  takeover: boolean;
  persistentHome: boolean;
  /** Distinct graphical screens for concurrent Team bots on one computer. */
  multiScreen?: boolean;
}

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  /** In-process routing metadata. It is never exposed to the model. */
  route?: ConnectorRoute;
  /** Display name of the connected app, for the live activity line only. Never exposed to the model. */
  appName?: string;
  /** Highlight this tool in large catalog indexes. Metadata only, never exposed to the model. */
  featured?: boolean;
  /** On a lazy catalog's execute tool: the tools it runs by id. Never exposed to the model. */
  catalog?: ReadonlyArray<{ id: string; tool: ConnectorTool }>;
}

export interface ConnectorRoute {
  connectorId: string;
  toolName: string;
  resourceId?: string;
  resourceRevision?: string | number;
  /** Source label for lazy catalog name indexes. Never exposed as a model schema field. */
  catalogGroup?: string;
}

export interface ConnectorCall {
  tool: string;
  args: Record<string, unknown>;
  connectionId?: string;
  executionId: string;
  route?: ConnectorRoute;
}

export type ConnectorFailureKind =
  | "invalid_arguments"
  | "auth_required"
  | "permission_denied"
  | "unsupported"
  | "transient"
  | "unknown";

export type ConnectorEvent =
  | { type: "log"; message: string }
  | { type: "result"; data: unknown }
  | {
      type: "error";
      message: string;
      /** Omitted by older adapters; consumers treat it as unknown. */
      kind?: ConnectorFailureKind;
      /** Provider response, with credentials redacted by the adapter. */
      details?: unknown;
    };

export interface ConnectorCapabilities {
  discover: boolean;
  oauth: boolean;
  secretsBrokered: boolean;
}

export type ConnectorCatalogItem = ConnectionCatalogItem;

/**
 * "bot" is the context person's own memory of the bot. "team" is a shared bot's memory common to
 * everyone it is shared with, stored under the bot owner: read and write it as the owner.
 */
export type MarkdownMemoryScope = "bot" | "user" | "team";

export interface MemoryReadRequest {
  scope: MarkdownMemoryScope;
  botId?: string;
  path?: string;
}

export interface MemorySnapshot {
  documents: Array<{
    id: string;
    path: string;
    content: string;
    revision: number;
    updatedAt?: string;
  }>;
}

export interface MemorySearchRequest {
  query: string;
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  score: number;
}

export interface MemoryCommitRequest {
  scope: MarkdownMemoryScope;
  botId?: string;
  path: string;
  content: string;
  /**
   * "replace" (default) swaps the whole document, which is what the Knowledge screen and
   * the Markdown import express. "append" adds `content` to the end of the existing
   * document inside the same transaction, so concurrent writers cannot lose a fact.
   */
  mode?: "replace" | "append";
  sourceRunId?: string;
  sourceThreadId?: string;
}

export interface MemoryRevision {
  id: string;
  path: string;
  revision: number;
  content: string;
}

export interface MemoryExportRequest {
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemoryCapabilities {
  search: boolean;
  revisions: boolean;
  markdownPortable: boolean;
}

export type DurableMemoryScope = "isolated" | "shared";

export interface SemanticMemoryCapabilities {
  recall: true;
  save: true;
  purgeHistory: true;
  sharedScope: true;
}

export interface SemanticMemoryResult {
  memory: string;
  score: number;
  updatedAt?: string;
  /** Stable provider id when the backend supports citation / forget. */
  id?: string;
  /** Attribution string preserved from the memory backend. */
  provenance?: string;
  /** Provider entity/namespace the fact was recalled from, when scoped. */
  entity?: string;
}

export interface SemanticMemoryForgetRequest {
  id: string;
  reason?: string;
  /** Entity/namespace from a prior recall citation, when the backend scopes deletes. */
  entity?: string;
}

export type SemanticMemoryResponse<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SemanticMemoryRecallRequest {
  query: string;
  scope: DurableMemoryScope;
  botId: string;
  /** Omit until a thread has compacted history; the provider can then skip that namespace. */
  historyGeneration?: number;
  limit: number;
}

export interface SemanticMemorySaveRequest {
  content: string;
  scope: DurableMemoryScope;
  botId: string;
  source: { kind: "durable" } | { kind: "history"; generation: number };
}

export interface SemanticMemoryPurgeHistoryRequest {
  botId: string;
  generations: number[];
}

export type SemanticMemoryForgetResponse = SemanticMemoryResponse<{
  id: string;
  expired: boolean;
  reason: string | null;
}>;

export interface AgentInputImage {
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: Uint8Array;
}

export interface AgentSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  /** Persisted history text before attachment paths are appended. */
  historyText?: string;
  images?: AgentInputImage[];
}

export interface AgentRunModel {
  provider: string;
  id: string;
  apiKey?: string;
  baseUrl?: string;
  /** Whether this custom connection accepts standard reasoning_effort. */
  reasoning?: boolean;
  /** Whether this custom connection accepts image input. */
  acceptsImages?: boolean;
  /** Maximum number of image inputs the model connection accepts in one request. */
  maxImagesPerPrompt?: number;
  /** Maximum completion tokens sent to the model endpoint. */
  maxTokens?: number;
  /** Context-window limit used when sizing prompts and completions. */
  contextWindow?: number;
  /** Preferred thinking effort for reasoning models; clamped to the model’s supported set. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** In-process OAuth credential from the encrypted store for this run. */
  oauth?: {
    credential: AgentModelOAuthCredential;
    persist?: (credential: AgentModelOAuthCredential) => Promise<void>;
  };
}

/** One typed result a model can answer a call with, named for the model to pick. */
export interface AgentRunAnswerSchema {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface AgentRunRequest {
  persistence?: RunPersistence;
  resumeEvent?: string;
  resumeEvents?: RunResumeEvent[];
  botId: string;
  threadId: string;
  runId: string;
  sourceMessageId?: string | null;
  prompt: string;
  instructions: string;
  /** For a harness that keeps its own system prompt: what Tangow appends to it instead. */
  harnessAddendum?: string;
  history: AgentHistoryTurn[];
  currentTurnImages?: AgentInputImage[];
  tools: ConnectorTool[];
  /** Tools of `tools` the run's own agent is never offered. A helper's profile can allow them. */
  blockedTools?: readonly string[];
  /** The profiles `run_subagent` can name as its `helper`. */
  helperProfiles?: readonly HelperProfile[];
  /**
   * Values the run must never disclose. Live list: it grows while the run
   * resolves credentials, and anything exported is redacted against it.
   */
  secrets?: readonly string[];
  model: AgentRunModel;
  /** Resolve a helper category within the active user and space scope. */
  resolveCategory?: (
    category: ModelCategory,
  ) => Promise<{ model: AgentRunModel; modelDecision: RunModelDecision }>;
  resumeFromCheckpoint?: string;
  script?: ScriptedTurn[];
  /**
   * Bot-message wakes may finish with no text and no tools (FYI silence).
   * When set, skip synthetic empty-turn fallbacks.
   */
  allowSilentEmpty?: boolean;
  /** Only message_user reaches the person; the run's own text is private scratch. */
  freeTextIsPrivate?: boolean;
  /** Request a factual structured closing in the existing final model turn. */
  runRecap?: boolean;
  /** Contextual fallback when a non-silent run produces no written response. */
  emptyResponseText?: string;
  /**
   * Typed results the model may answer with instead of text, each an object JSON Schema. The model
   * fills one in; nothing is executed. A runtime that cannot offer them answers with text only.
   */
  answer?: { schemas: AgentRunAnswerSchema[] };
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    executionId: string,
    route?: ConnectorRoute,
    /** Present only when the runtime traces this run. */
    trace?: ToolCallTrace,
  ) => Promise<unknown>;
  /** Fenced, untrusted guest observations; secrets are scanned by the controller. */
  onSkillIndex?: (
    skills: WorkerSkill[],
    sources: WorkerSkill["source"][],
    receivedAt: Date,
  ) => Promise<void>;
  onSkillCollision?: (collision: SkillCollision) => Promise<void>;
  onSkillUsed?: (name: string) => Promise<void>;
  /** The attempt this run belongs to, for a runtime that binds a remote guest to it. */
  attempt?: { id: string; fence: number };
  /** Called after a tool returns; implementations must not persist raw result contents. */
  onToolCompleted?: (completion: AgentToolCompletion) => Promise<void> | void;
  /** Atomically claim durable user steering at the runtime's next safe turn boundary. */
  claimSteering?: (seenIds: string[]) => Promise<AgentSteeringMessage[]>;
  /** Open the log of one `run_subagent` call: the helper runs in a session of its own. */
  startSubagent?: (call: SubagentCall) => Promise<SubagentLog>;
  /** Queue one background `run_subagent` call as a run of its own, which reports when it ends. */
  startHelper?: (call: SubagentCall) => Promise<{ helperId: string }>;
  /**
   * This run is a background helper: its call's brief and instructions and the profile it names
   * among `helperProfiles` replace the bot's.
   */
  helper?: { name: string; task: string; instructions: string; profile: string | null };
}

/** A runtime could not start or was lost. The executor retries within its setup budget. */
export class AgentRuntimeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeUnavailableError";
  }
}

/** Another attempt still owns resources the runtime needs. Waiting does not consume setup retries. */
export class AgentRuntimeBusyError extends AgentRuntimeUnavailableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeBusyError";
  }
}

export interface SubagentCall {
  callId: string;
  name: string;
  task: string;
  args: Record<string, unknown>;
  model: Pick<AgentRunModel, "provider" | "id" | "thinkingLevel">;
  modelDecision: RunModelDecision;
  /** The profile the helper runs; its `exclusive` resource is held for the helper's run. */
  profile?: Pick<HelperProfile, "name" | "exclusive">;
}

/** Where a helper writes what it does. Writes land in the order they are made. */
export interface SubagentLog {
  /** Run one of the helper's tool calls, writing the call and its result to the helper's log. */
  executeTool: NonNullable<AgentRunRequest["executeTool"]>;
  /** Write a finished block of the helper's own text. */
  text(text: string): Promise<void>;
  /** Close the helper's run and leave its one trace, the `result` it returned, in the parent's log. */
  finish(outcome: {
    status: "completed" | "failed";
    result: string;
    usage: { inputTokens: number; outputTokens: number };
  }): Promise<void>;
  /** Answer the parent's call with `result` as an error when `finish` cannot close the log. */
  abandon(result: string): Promise<void>;
  /**
   * Log what the helper's native session did, as the root run's `transcript` event does. Only
   * the controller's log has it: a guest's in-process helpers keep no native session.
   */
  transcript?(event: Extract<AgentRuntimeEvent, { type: "transcript" }>): Promise<void>;
}

/**
 * Handed to one tool call by a runtime that traces the run, so a model call the
 * tool makes itself is recorded nested under that call.
 */
export interface ToolCallTrace {
  /** Returns undefined when the tool call is not being traced. */
  generation(name: string, input: unknown): ToolCallGeneration | undefined;
}

export interface ToolCallGeneration {
  /** Settles the observation; later calls are ignored. */
  end(result: ToolCallGenerationResult): void;
}

export interface ToolCallGenerationResult {
  output: unknown;
  model?: string;
  usage?: { inputTokens?: number; cost?: number };
  metadata?: Record<string, string | number | boolean | undefined>;
  /** Short machine-readable reason; marks the observation as failed. */
  error?: string;
}

export interface ScriptedTurn {
  assistant?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  ask?: {
    text: string;
    detail?: string;
    actions?: Array<{ id: string; label: string }>;
    questions?: AskQuestion[];
  };
  takeover?: { reason: string };
  files?: Array<{ path: string; content: string }>;
  memory?: Array<{ scope: "bot" | "user"; path: string; content: string }>;
  complete?: boolean;
}

/**
 * One step of a harness with its own loop, in the order of the attempt's transcript. `turn` counts
 * the attempt's model responses from 0; a summary takes the index of the turn after it. A `call`
 * is one of the harness's own tools and its `result` the outcome the harness reported, which
 * arrives later or never. A `controller` call names a call of any other tool: its content is in
 * the controller's log, never taken from the transcript.
 */
export type HarnessTranscriptEntry =
  | { kind: "text"; turn: number; text: string }
  | { kind: "call"; turn: number; callId: string; name: string; args: Record<string, unknown> }
  | { kind: "result"; callId: string; output: string; isError: boolean }
  | { kind: "controller"; turn: number; name: string }
  | { kind: "summary"; turn: number; summary: string; tokensBefore: number };

export type AgentRuntimeEvent =
  | { type: "text"; text: string }
  | {
      type: "progress";
      text: string;
      /** Provider-generated tool status rather than assistant-authored narration. */
      activity?: true;
    }
  | { type: "tool"; name: string; args: Record<string, unknown>; executionId: string }
  | {
      type: "ask";
      text: string;
      detail?: string;
      actions?: Array<{ id: string; label: string }>;
      questions?: AskQuestion[];
    }
  | { type: "takeover"; reason: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      provider: string;
      model: string;
      /** Provider cache counters; absent when the provider does not report them. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: "checkpoint"; blob: string }
  | {
      /** The steps an agent's transcript added since its previous one. */
      type: "transcript";
      entries: HarnessTranscriptEntry[];
      /** Results it claims for calls of controller tools that the controller never answered. */
      unverifiedCalls: number;
    }
  | {
      type: "done";
      text?: string;
      privateFinalText?: string;
      /** Recovery text authored by the runtime, never inferred from model prose. */
      runtimeNotice?: string;
      /** The one typed result of `request.answer` the model filled in, as it gave it. */
      answer?: { name: string; value: Record<string, unknown> };
    };

export interface AgentRuntimeCapabilities {
  streaming: boolean;
  compaction: boolean;
  tools: boolean;
  scripted: boolean;
  /** Tools the runtime's own loop runs next to the model, offered with the rest. */
  localTools?: readonly ConnectorTool[];
  /**
   * The model reads screens from the bot's home with its own file tool, so a screen tool saves the
   * image there and returns its path instead of the image.
   */
  screensByPath?: boolean;
}

export interface VoiceInfo {
  id: string;
  label: string;
  description?: string;
}

export interface SpeechClip {
  bytes: Uint8Array;
  mimeType: "audio/mpeg" | "audio/wav" | "audio/ogg";
}

export interface VoiceCapabilities {
  catalog: boolean;
  synthesize: boolean;
  transcribe: boolean;
}

export interface VoiceVerifyResult {
  ok: boolean;
  message?: string;
}

export interface VoiceSynthesizeRequest {
  text: string;
  voiceId: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface VoiceTranscribeRequest {
  audio: Uint8Array;
  mimeType: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface BackgroundJobPayloads {
  "run.continue": { runId: string };
  "routine.wakeup": { routineId: string; scheduledFor: string };
  "computer.sleep": { computerId: string };
  "computer.screen-sleep": { computerId: string; botId: string; screenLeaseId: string };
  "computer.update": { updateId: string };
  "computer.control-expire": { computerId: string; leaseId: string };
  "skill.teaching-expire": { skillId: string };
  /** `historyBudget` is the tokens the enqueuing run's history could fill, unset when unknown. */
  "history.compact": { threadId: string; historyBudget?: number };
  "messaging.deliver": { runId?: string };
  /** Identifiers only: the link, its eligibility and the run status are re-read from the database. */
  "link.preview": { messageId: string } | { runId: string };
}

export type BackgroundJobName = keyof BackgroundJobPayloads;

export type BackgroundJob = {
  [Name in BackgroundJobName]: {
    name: Name;
    payload: BackgroundJobPayloads[Name];
    availableAt?: Date;
    replaceKey?: string;
    /** Graphile priority: lower runs first (default 0). */
    priority?: number;
    /** Attempts before the job is given up on (the queue default is 25). */
    maxAttempts?: number;
  };
}[BackgroundJobName];

export type BackgroundJobHandlers = {
  [Name in BackgroundJobName]: (payload: BackgroundJobPayloads[Name]) => Promise<void>;
};

export interface SecretRecord {
  id: string;
  ciphertext: string;
}

export interface ArtifactPut {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface NotificationMessage {
  kind: "completion" | "failure" | "help" | "takeover";
  title: string;
  /** A line under the title, such as the routine a run belongs to. Platforms without one drop it. */
  subtitle?: string;
  body: string;
  botId: string;
  threadId: string;
  /** Set when the bot spoke in a group, so a tap opens the group rather than its chat. */
  groupId?: string;
  /** The user's total unread conversations after this notification's message landed. An
      absolute count, never a delta: iOS renders it as the app icon badge and a missed push
      must not leave the badge off by one. */
  badge?: number;
  /** `color` and `shape` describe the old drawn avatar, for apps that predate characters. */
  avatar?: { character: string; color: string; shape: number };
}

/** A product-authored transactional email, independent of its delivery vendor. */
export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MessagingCapabilities {
  direct: boolean;
  groups: boolean;
  typing: boolean;
}

/** One messaging platform behind the chat surface (sendblue, slack, …). */
export interface MessagingPlatformDescriptor {
  provider: string;
  capabilities: MessagingCapabilities;
}

/** Send into an existing conversation, addressed by its opaque thread id. */
export interface MessagingSendRequest {
  threadId: string;
  body: string;
  /** Stable key so retries of the same logical send can be deduped upstream. */
  idempotencyKey?: string;
}

export interface MessagingSendResult {
  handle: string;
}

/** Provider-neutral inbound message after platform webhook parsing. */
export type TeamChatMessageKind = "direct" | "mention" | "ambient";

export interface MessagingInboundMessage {
  type: "message";
  provider: string;
  /** Per-message transport when one provider spans multiple networks (for example SMS vs RCS). */
  transport?: string;
  /** Provider message id; drives replay-safe client nonces downstream. */
  handle: string;
  /** Opaque conversation id — pass back to sendToThread to reply. */
  threadId: string;
  /** True for a 1:1 conversation with the deployment's line/bot. */
  isDirect: boolean;
  /** Sender address within the provider (E.164, Slack user id, …). */
  from: string;
  /** Sender display name when the platform provides one. */
  fromLabel: string | null;
  /** Group/channel display name; null for DMs or when unknown. */
  channelName: string | null;
  /** Group roster addresses when the platform reports them; often empty. */
  participants: string[];
  content: string;
  mediaUrl: string | null;
  /** Team-room workspace/team id when the platform reports one (Slack team_id, …). */
  workspaceId?: string;
  /** Stable conversation key within the workspace (channel id, DM key, …). */
  conversationKey?: string;
  /** How this message should engage the team-chat bot. */
  kind?: TeamChatMessageKind;
  /** Provider thread id for in-channel replies (Slack thread_ts); null for channel root. */
  replyThreadId?: string | null;
  /** True when the sender is another bot/app. */
  senderIsBot?: boolean;
  /** Display names for room participants when the platform reports them. */
  participantNames?: string[];
}

/** Provider-neutral inbound team/external room message for TeamChatBridge. */
export interface TeamChatInboundMessage {
  eventId: string;
  workspaceId: string;
  kind: TeamChatMessageKind;
  conversationType?: "im" | "channel" | "group" | "mpim";
  conversationKey: string;
  /** Messaging threadId used with sendToThread. */
  conversationId: string;
  conversationName?: string;
  participantNames?: string[];
  replyThreadId: string | null;
  senderId: string;
  senderName: string;
  senderIsBot?: boolean;
  content: string;
}

export interface TeamChatSendRequest {
  conversationId: string;
  replyThreadId: string | null;
  content: string;
  idempotencyKey?: string;
}

export interface TeamChatSendResult {
  handle: string;
}

/** Provider-neutral outbound delivery status after platform webhook parsing. */
export interface MessagingOutboundStatus {
  type: "status";
  provider: string;
  handle: string;
  status: string;
}

export type MessagingInboundEvent = MessagingInboundMessage | MessagingOutboundStatus;

export interface WebSearchCapabilities {
  search: boolean;
  /** True when results come from the active model’s native search, not a third-party API. */
  native?: boolean;
  /** True when search works without a hosted search vendor or API key. */
  keyless?: boolean;
}

export interface WebFetchCapabilities {
  fetch: boolean;
  /** True when readable extraction runs without executing page JavaScript. */
  readability: boolean;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchRequest {
  url: string;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Page-level browser on the bot computer (DOM refs), not a hosted browser vendor. */
export interface BrowserCapabilities {
  page: boolean;
  /** True when element refs from snapshot can be clicked or filled. */
  refs: boolean;
  /** True when the adapter runs without a hosted browser vendor or API key. */
  keyless?: boolean;
}

export interface BrowserNavigateRequest {
  url: string;
  signal?: AbortSignal;
}

export interface BrowserNavigateResult {
  url: string;
  title: string;
  /** When set, the page tool could not operate; use computer_act instead. */
  fallback?: "computer_act";
  error?: string;
}

export interface BrowserSnapshotRequest {
  signal?: AbortSignal;
}

export interface BrowserSnapshotNode {
  /** Stable element ref for browser_act (e.g. e12). */
  ref: string;
  role: string;
  name: string;
  value?: string;
  tag?: string;
  /** A password input: its value is never reported. */
  password?: true;
  /**
   * A `<select>` only: the labels of its visible, enabled options in page order, trimmed and at
   * most 80 characters each, at most 30. Its `value` is then the selected option's label.
   */
  options?: string[];
  /** The select has more options than `options` lists. */
  optionsTruncated?: true;
  /** Matches `:disabled` or has `aria-disabled="true"`: listed, but no action reaches it. */
  disabled?: true;
}

export interface BrowserSnapshotResult {
  url: string;
  title: string;
  /** Compact accessibility-style tree for the model. */
  tree: string;
  elements: BrowserSnapshotNode[];
  fallback?: "computer_act";
  error?: string;
}

export type BrowserActKind = "click" | "fill" | "type";

export type BrowserActStep =
  | { kind: "click"; ref: string }
  | { kind: "fill" | "type"; ref: string; text: string };

export interface BrowserActRequest {
  actions: BrowserActStep[];
  signal?: AbortSignal;
}

export interface BrowserActResult {
  ok: boolean;
  completed: number;
  /** An action may have taken effect before its response was lost. Observe before continuing. */
  uncertain?: boolean;
  url: string;
  title: string;
  /** Snapshot after the actions when available. */
  tree?: string;
  elements?: BrowserSnapshotNode[];
  fallback?: "computer_act";
  error?: string;
}

/** A sandbox must route these commands through its owned screen, never generic host execution. */
export type PageBrowserCommand =
  | { command: "navigate"; url: string }
  | { command: "snapshot" }
  | { command: "act"; actions: BrowserActStep[] };

export type PageBrowserResult = Partial<BrowserSnapshotResult & BrowserActResult> & { ok: boolean };

/** Typed questions about a text state, answered with probabilities. Not a text generator. */
export interface DecisionCapabilities {
  noul: boolean;
  choice: boolean;
  score: boolean;
  /** Largest option map a `choice` accepts. Callers truncate or give up; they never exceed it. */
  maxOptions: number;
  /** True when the adapter never leaves the process (tests / keyless core). */
  offline?: boolean;
}

/**
 * `noul` asks yes/no; `choice` picks one caller-named option; `score` picks a level
 * on an ordered scale indexed from zero.
 */
export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; options: Record<string, string> }
  | { type: "score"; instructions: string; levels: string[] };

export interface DecisionRequest {
  /** Caller must already redact secrets. */
  state: string | Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | { type: "noul"; probability: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      /** Expected level; may fall between integer levels. */
      score: number;
      confidence: number;
      /** Keyed by level index. */
      probabilities: Record<string, number>;
    };

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  /** Model version that answered, when the provider reports one. */
  model?: string;
  /** Fields are absent when the provider does not report them; never an invented zero. */
  usage?: { inputTokens?: number; cost?: number };
}

export type DecisionUnavailableReason =
  | "no_provider"
  | "timeout"
  | "aborted"
  | "error"
  | "invalid_answer";

/** What callers see: an answer, or a reason to carry on exactly as without a provider. */
export type DecisionResult =
  | ({ ok: true } & DecisionResponse)
  | {
      ok: false;
      reason: DecisionUnavailableReason;
      /** Error class name only; never a raw message, which may carry URLs. */
      error?: string;
    };
