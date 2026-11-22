import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@tangow/contracts";
import { isWorkingStatus } from "@tangow/core";
import { BotAvatar, Button, StackedAvatars } from "@tangow/ui-web";
import { ChevronLeft, Monitor, PanelLeftOpen, Phone, Settings } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { desktopBridge } from "../../lib/desktop";
import { WindowChrome } from "../WindowChrome";
import type { BotPageView, Panel } from "./layout";
import { botPageFor } from "./layout";

// 32 px buttons in the 36 px glass capsule; chrome icons are full ink.
const CAPSULE_BUTTON = "app-no-drag size-8 text-foreground aria-pressed:bg-accent";

export function ThreadHeader({
  botsSidebarCollapsed,
  setBotsSidebarCollapsedPref,
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  panel,
  setPanel,
  onOpenBotPage,
  refreshThread,
  onVoice,
  voiceButtonRef,
  disabled,
}: {
  botsSidebarCollapsed: boolean;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: Pick<ThreadSnapshot, "groupId" | "groupName" | "members"> | null;
  panel: Panel;
  setPanel: Dispatch<SetStateAction<Panel>>;
  onOpenBotPage: (view: BotPageView) => void;
  refreshThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
  /** 1:1 conversations only — a group has no call, only the composer's dictation. */
  onVoice?: () => void;
  voiceButtonRef?: RefObject<HTMLButtonElement | null>;
  /** Same readiness logic as the composer's own buttons (e.g. a skill is being taught). */
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const location = useLocation();
  const navigate = useNavigate();
  const members = activeSnapshot?.members ?? activeGroup?.members ?? [];
  // A bot shared with you: its page, screen, voice and settings stay its owner's.
  const shared = !inGroup && active?.isOwner === false;
  return (
    // No band: it overlays the thread, which fades out under the scroll edge;
    // `-mb-header` pulls the thread up under it. `pt-1.5` centres it on the
    // floating sidebar's header line.
    <div className="app-drag relative z-10 -mb-header flex h-header shrink-0 items-center justify-between gap-2 ps-3 pe-3 pt-1.5 md:ps-5.5">
      <div
        aria-hidden="true"
        className="rk-scroll-edge pointer-events-none absolute inset-x-0 top-0 -z-10 h-16"
      />
      <div className="flex min-w-0 items-center gap-2">
        {/* Collapsed bots sidebar: this header is the leading edge for window chrome. */}
        {botsSidebarCollapsed && desktopBridge() ? <WindowChrome /> : null}
        {/* At phone width the bot list is its own page: back to it, as in the iPhone app.
            A plain link: the `roundIcon` variant's `bg-transparent` would beat the glass. */}
        <Link
          to="/app"
          replace
          aria-label={t`Back`}
          // Opened from the list: pop back to it, so the history stays list, chat.
          onClick={(event) => {
            if (!(location.state as { fromList?: boolean } | null)?.fromList) return;
            event.preventDefault();
            navigate(-1);
          }}
          className="rk-glass-control rk-press-round app-no-drag grid size-capsule shrink-0 place-items-center rounded-full text-foreground md:hidden"
        >
          <ChevronLeft size={20} strokeWidth={1.8} aria-hidden className="rtl:-scale-x-100" />
        </Link>
        {botsSidebarCollapsed ? (
          <Button
            variant="roundIcon"
            size="roundIconSm"
            data-testid="restore-bots-sidebar"
            aria-label={t`Show bots`}
            title={t`Show bots`}
            onClick={() => setBotsSidebarCollapsedPref(false)}
            className="app-no-drag hidden shrink-0 text-foreground md:inline-flex"
          >
            <PanelLeftOpen size={16} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        ) : null}
        <button
          type="button"
          data-testid="bot-settings-trigger"
          disabled={shared}
          onClick={() =>
            inGroup ? setPanel("group-settings") : onOpenBotPage(botPageFor("header"))
          }
          className="app-no-drag -mx-2 flex min-w-0 items-center gap-3 rounded-lg px-2 py-1 transition-colors enabled:hover:bg-muted"
        >
          {/* D2-a: a mono (single-bot) thread carries the bot's identity here
              instead of on every message — no per-message avatar or name. */}
          {!inGroup && active ? (
            <BotAvatar character={active.avatarCharacter} status={active.status} size={32} live />
          ) : null}
          <span className="block min-w-0 truncate text-title text-foreground" dir="auto">
            {inGroup
              ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
              : (active?.name ?? t`Select a bot`)}
          </span>
          {inGroup ? (
            <StackedAvatars
              size={20}
              className="shrink-0"
              label={members.map((member) => member.name).join(", ")}
              items={members.map((member) => ({
                identity: member.botId,
                character: member.avatarCharacter,
                working: isWorkingStatus(member.status),
              }))}
            />
          ) : null}
        </button>
      </div>
      {!inGroup && active && !shared ? (
        <div className="rk-glass-control flex h-capsule shrink-0 items-center rounded-full p-0.5">
          {onVoice ? (
            <Button
              ref={voiceButtonRef}
              variant="roundIcon"
              size="roundIcon"
              data-testid="open-voice-call"
              aria-label={t`Voice`}
              title={t`Voice`}
              disabled={disabled}
              onClick={onVoice}
              className={CAPSULE_BUTTON}
            >
              <Phone size={16} strokeWidth={1.8} aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="roundIcon"
            size="roundIcon"
            data-testid="open-computer-panel"
            aria-label={t`Screen`}
            title={t`Screen`}
            onClick={() => {
              const next = panel === "computer" ? null : "computer";
              setPanel(next);
              if (next === "computer") {
                // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                void refreshThread(active.id).catch(() => undefined);
              }
            }}
            aria-pressed={panel === "computer"}
            className={CAPSULE_BUTTON}
          >
            <Monitor size={16} strokeWidth={1.8} aria-hidden="true" />
          </Button>
          <Button
            variant="roundIcon"
            size="roundIcon"
            data-testid="open-settings-panel"
            aria-label={t`Bot settings`}
            title={t`Bot settings`}
            onClick={() =>
              panel === "bot" ? setPanel(null) : onOpenBotPage(botPageFor("gear", active))
            }
            aria-pressed={panel === "bot"}
            className={CAPSULE_BUTTON}
          >
            <Settings size={16} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
