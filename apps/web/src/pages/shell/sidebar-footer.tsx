import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@tangow/contracts";
import {
  BotAvatar,
  Button,
  GroupAvatar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  UserAvatar,
} from "@tangow/ui-web";
import { Gauge, LogOut, Settings, SlidersHorizontal } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { authClient } from "../../lib/auth";
import { clearSpaceSelection, rpc } from "../../lib/rpc";
import type { SettingsSection } from "../settings-sections";

export type SidebarArchivedProps = {
  archivedBots: Bot[];
  archivedGroups: Group[];
  archivedOpen: boolean;
  setArchivedOpen: Dispatch<SetStateAction<boolean>>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  setDeleteTarget: Dispatch<SetStateAction<Bot | null>>;
  /** Opens an archived bot's page, read-only. */
  onOpenArchivedBot: (botId: string) => void;
  onRestoreBot: (botId: string) => void;
  setDeleteGroupTarget: Dispatch<SetStateAction<Group | null>>;
  setLeaveGroupTarget: Dispatch<SetStateAction<Group | null>>;
  initials: string;
  userImage: string | null;
};

export function SidebarArchived({
  archivedBots,
  archivedGroups,
  archivedOpen,
  setArchivedOpen,
  refreshBots,
  setDeleteTarget,
  onOpenArchivedBot,
  onRestoreBot,
  setDeleteGroupTarget,
  setLeaveGroupTarget,
  initials,
  userImage,
}: SidebarArchivedProps) {
  const { t } = useLingui();
  if (archivedBots.length + archivedGroups.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={archivedOpen}
        onClick={() => setArchivedOpen((open) => !open)}
        className="flex w-full items-center justify-between rounded-row px-2.5 py-2 text-reasoning text-muted-foreground hover:bg-sidebar-accent"
      >
        <span>
          <Trans>Archived</Trans>
        </span>
        <span>{archivedBots.length + archivedGroups.length}</span>
      </button>
      {archivedOpen ? (
        <>
          {archivedBots.map((bot) => (
            <div key={bot.id} className="flex items-center gap-2 rounded-row px-2.5 py-2">
              <button
                type="button"
                data-testid="archived-bot-open"
                onClick={() => {
                  onOpenArchivedBot(bot.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-chip text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <BotAvatar character={bot.avatarCharacter} size={28} status={bot.status} />
                <span
                  className="min-w-0 flex-1 truncate text-capsule text-foreground/75 hover:text-foreground"
                  dir="auto"
                >
                  {bot.name}
                </span>
              </button>
              <Button variant="ghost" size="xs" onClick={() => onRestoreBot(bot.id)}>
                <Trans>Restore</Trans>
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive hover:text-destructive"
                aria-label={t`Delete ${bot.name}`}
                onClick={() => setDeleteTarget(bot)}
              >
                <Trans>Delete</Trans>
              </Button>
            </div>
          ))}
          {archivedGroups.map((group) => (
            <div key={group.id} className="flex items-center gap-2 rounded-row px-2.5 py-2">
              <GroupAvatar
                members={group.members}
                size={28}
                userInitials={initials}
                userImage={userImage}
              />
              <span className="min-w-0 flex-1 truncate text-capsule text-foreground/75" dir="auto">
                {group.name}
              </span>
              {group.canManage ? (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void rpc.groups.restore({ groupId: group.id }).then(() => refreshBots(true))
                    }
                  >
                    <Trans>Restore</Trans>
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:text-destructive"
                    aria-label={t`Delete ${group.name}`}
                    onClick={() => setDeleteGroupTarget(group)}
                  >
                    <Trans>Delete</Trans>
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-destructive hover:text-destructive"
                  aria-label={t`Leave ${group.name}`}
                  onClick={() => setLeaveGroupTarget(group)}
                >
                  <Trans>Leave</Trans>
                </Button>
              )}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

export type SidebarFooterProps = {
  setCustomizeOpen: Dispatch<SetStateAction<boolean>>;
  menuOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  initials: string;
  userImage: string | null;
  userName: string;
  openSettings: (section?: SettingsSection) => void;
  navigate: (path: string) => void;
};

export function SidebarFooter({
  setCustomizeOpen,
  menuOpen,
  setMenuOpen,
  initials,
  userImage,
  userName,
  openSettings,
  navigate,
}: SidebarFooterProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-0.5 px-2.5 pb-2.5">
      <button
        type="button"
        data-testid="open-customize"
        onClick={() => setCustomizeOpen(true)}
        className="flex min-w-0 items-center gap-2.75 rounded-row px-2.5 py-2.25 hover:bg-sidebar-accent"
      >
        <SlidersHorizontal
          size={16}
          strokeWidth={1.7}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate text-meta text-foreground">
          <Trans>Customize</Trans>
        </span>
      </button>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          className="flex min-w-0 items-center gap-2.75 rounded-row px-2.5 py-2.25 hover:bg-sidebar-accent"
        >
          <UserAvatar initials={initials} image={userImage} className="size-6 text-label" />
          <span className="truncate text-meta text-foreground">{userName}</span>
        </PopoverTrigger>
        {menuOpen ? (
          <PopoverContent
            side="top"
            align="start"
            className="w-56 gap-0 p-1 data-closed:animate-none"
          >
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              aria-label={t`Settings`}
              onClick={() => {
                setMenuOpen(false);
                openSettings();
              }}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              aria-label={t`Usage`}
              onClick={() => {
                setMenuOpen(false);
                openSettings("usage");
              }}
            >
              <Gauge className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Usage</Trans>
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              onClick={() =>
                void authClient.signOut().then(() => {
                  clearSpaceSelection();
                  navigate("/");
                })
              }
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
          </PopoverContent>
        ) : null}
      </Popover>
    </div>
  );
}
