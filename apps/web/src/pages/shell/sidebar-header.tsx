import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@tangow/contracts";
import {
  Button,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@tangow/ui-web";
import { Bell, PanelLeftClose, Plus, Search } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { desktopBridge } from "../../lib/desktop";
import { WindowChrome } from "../WindowChrome";
import { BotCreatePicker } from "./bot-picker";
import { commandModifierKey } from "./command-palette-hotkey";
import type { Panel, SidebarGroup } from "./layout";

export type SidebarHeaderProps = {
  activityMode: boolean;
  toggleActivityMode: () => void;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  createMenuOpen: boolean;
  setCreateMenuOpen: Dispatch<SetStateAction<boolean>>;
  bots: Bot[];
  setPanel: Dispatch<SetStateAction<Panel>>;
  navigate: (path: string) => void;
  setNewSpaceOpen: Dispatch<SetStateAction<boolean>>;
  setPickerInfoTopic: Dispatch<SetStateAction<"group" | "space" | null>>;
  sidebarGroups: SidebarGroup[];
  openSearch: () => void;
};

export function SidebarHeader({
  activityMode,
  toggleActivityMode,
  setBotsSidebarCollapsedPref,
  createMenuOpen,
  setCreateMenuOpen,
  bots,
  setPanel,
  navigate,
  setNewSpaceOpen,
  setPickerInfoTopic,
  sidebarGroups,
  openSearch,
}: SidebarHeaderProps) {
  const { t } = useLingui();
  const modKey = commandModifierKey();
  const hasUnread = sidebarGroups.some((group) => group.bots.some((item) => item.chat.unread));
  return (
    <div className="app-drag flex h-11.5 shrink-0 items-center justify-between gap-2 px-4 ps-4.5">
      <div className="flex min-w-0 items-center gap-1">
        {desktopBridge() ? <WindowChrome /> : null}
        <Button
          variant="roundIcon"
          size="roundIconSm"
          className="app-no-drag hidden md:inline-flex"
          aria-label={t`Minimize bots`}
          title={t`Minimize bots`}
          data-testid="minimize-bots-sidebar"
          onClick={() => setBotsSidebarCollapsedPref(true)}
        >
          <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden="true" />
        </Button>
      </div>
      <div className="relative flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="roundIcon"
                size="roundIconSm"
                className="app-no-drag"
                aria-label={t`Search`}
                aria-keyshortcuts={modKey === "⌘" ? "Meta+K" : "Control+K"}
                data-testid="sidebar-search"
                onClick={openSearch}
              />
            }
          >
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t`Search`}
            <Kbd>{modKey}K</Kbd>
          </TooltipContent>
        </Tooltip>
        <Button
          variant="roundIcon"
          size="roundIconSm"
          className="app-no-drag relative"
          aria-label={t`Activity`}
          aria-pressed={activityMode}
          title={t`Activity`}
          data-activity-mode={activityMode ? "on" : "off"}
          onClick={toggleActivityMode}
        >
          <Bell size={16} strokeWidth={1.8} aria-hidden="true" />
          {hasUnread ? (
            <span
              aria-hidden="true"
              className="absolute end-1 top-1 size-1.25 rounded-full bg-foreground ring-2 ring-sidebar"
            />
          ) : null}
        </Button>
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <PopoverTrigger
            className="app-no-drag grid size-hover-icon place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t`Create`}
            data-testid="create-menu-trigger"
          >
            <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
          </PopoverTrigger>
          {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
          {createMenuOpen ? (
            <PopoverContent
              align="end"
              className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
            >
              <BotCreatePicker
                bots={bots}
                onCreateBot={() => {
                  setCreateMenuOpen(false);
                  setPanel("create");
                }}
                onOpenBot={(id) => {
                  setCreateMenuOpen(false);
                  navigate(`/app/${id}`);
                }}
                onCreateGroup={() => {
                  setCreateMenuOpen(false);
                  setPanel("create-group");
                }}
                onCreateSpace={() => {
                  setCreateMenuOpen(false);
                  setNewSpaceOpen(true);
                }}
                onShowGroupInfo={() => {
                  setCreateMenuOpen(false);
                  setPickerInfoTopic("group");
                }}
                onShowSpaceInfo={() => {
                  setCreateMenuOpen(false);
                  setPickerInfoTopic("space");
                }}
              />
            </PopoverContent>
          ) : null}
        </Popover>
      </div>
    </div>
  );
}
