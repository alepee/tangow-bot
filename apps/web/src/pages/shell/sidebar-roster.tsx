import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotSection, Group, Me, Space, ThreadSnapshot } from "@tangow/contracts";
import { ACTIVE_RUN_STATUSES } from "@tangow/core";
import { BotAvatar, Button, GroupAvatar } from "@tangow/ui-web";
import { ChevronDown, Lock, MoreHorizontal } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useMediaQuery } from "../../lib/use-media-query";
import { userInitials } from "../../lib/user-initials";
import { runStatusLabel } from "../ActivityList";
import type { ContextMenuPosition } from "../BotContextMenu";
import type { SidebarGroup } from "./layout";
import { PHONE_MEDIA } from "./layout";
import { useLongPress } from "./use-long-press";

export type SidebarRosterProps = {
  sidebarGroups: SidebarGroup[];
  collapsedSidebarSections: Set<string>;
  openSpaceChat: (spaceId: string, path: string) => void;
  toggleSidebarSection: (key: string) => void;
  spaceMenuAnchor: RefObject<HTMLElement | null>;
  setSpaceMenu: Dispatch<SetStateAction<{ id: string; position: ContextMenuPosition } | null>>;
  sectionMenuAnchor: RefObject<HTMLElement | null>;
  setSectionMenu: Dispatch<
    SetStateAction<{
      section: BotSection;
      spaceId: string;
      position: ContextMenuPosition;
    } | null>
  >;
  botSections: BotSection[];
  spaces: Space[];
  draggedBotId: string | null;
  setDraggedBotId: Dispatch<SetStateAction<string | null>>;
  reorderRosterBot: (sourceId: string, targetId: string, groupBotIds: string[]) => void;
  bootstrapMe: Me | null | undefined;
  botMenuAnchor: RefObject<HTMLElement | null>;
  setBotMenu: Dispatch<
    SetStateAction<{ kind: "bot" | "group"; id: string; position: ContextMenuPosition } | null>
  >;
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: Pick<ThreadSnapshot, "groupId" | "groupName" | "members"> | null;
  initials: string;
  userImage: string | null;
};

export function SidebarRoster({
  sidebarGroups,
  collapsedSidebarSections,
  openSpaceChat,
  toggleSidebarSection,
  spaceMenuAnchor,
  setSpaceMenu,
  sectionMenuAnchor,
  setSectionMenu,
  botSections,
  spaces,
  draggedBotId,
  setDraggedBotId,
  reorderRosterBot,
  bootstrapMe,
  botMenuAnchor,
  setBotMenu,
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  initials,
  userImage,
}: SidebarRosterProps) {
  const { t } = useLingui();
  const phone = useMediaQuery(PHONE_MEDIA);
  const longPress = useLongPress();

  const openGroupMenu = (
    group: SidebarGroup,
    target: HTMLElement,
    position: ContextMenuPosition,
  ): boolean => {
    if (group.sectionId) {
      // Prefer section rename over delete-space when both apply;
      // the dedicated space-actions button still opens the space menu.
      const sections =
        group.spaceId === bootstrapMe?.spaceId
          ? botSections
          : (spaces.find((space) => space.id === group.spaceId)?.botSections ?? []);
      const section = sections.find((item) => item.id === group.sectionId);
      if (!section) return false;
      sectionMenuAnchor.current = target;
      setSectionMenu({ section, spaceId: group.spaceId, position });
      return true;
    }
    if (!group.canDeleteSpace) return false;
    spaceMenuAnchor.current = target;
    setSpaceMenu({ id: group.spaceId, position });
    return true;
  };

  const openChatMenu = (
    item: SidebarGroup["bots"][number],
    target: HTMLElement,
    position: ContextMenuPosition,
  ): boolean => {
    if (item.chat.spaceId !== bootstrapMe?.spaceId) return false;
    botMenuAnchor.current = target;
    setBotMenu({ kind: item.kind, id: item.chat.id, position });
    return true;
  };

  return (
    <>
      {sidebarGroups.map((group) => {
        const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
        const groupBotIds = group.bots.flatMap((item) =>
          item.kind === "bot" ? [item.chat.id] : [],
        );
        return (
          <div key={group.key} data-sidebar-group={group.key}>
            {group.title ? (
              <div className="flex items-center pt-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-row px-2.5 py-1.5 text-label max-md:touch-callout-none max-md:select-none text-muted-foreground hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                  onClick={() => {
                    if (group.emptySpaceId) {
                      openSpaceChat(group.emptySpaceId, "/onboarding");
                      return;
                    }
                    toggleSidebarSection(group.key);
                  }}
                  {...longPress((target, point) => openGroupMenu(group, target, point))}
                  aria-expanded={group.emptySpaceId ? undefined : !collapsed}
                  aria-label={
                    group.emptySpaceId
                      ? t`Open ${group.title}`
                      : collapsed
                        ? t`Expand ${group.title}`
                        : t`Collapse ${group.title}`
                  }
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                    {group.showLock ? <Lock size={11} strokeWidth={2} aria-hidden="true" /> : null}
                    <span className="truncate">{group.title}</span>
                  </span>
                  {group.emptySpaceId ? null : (
                    <ChevronDown
                      size={14}
                      strokeWidth={1.8}
                      className={
                        collapsed ? "-rotate-90 transition-transform" : "transition-transform"
                      }
                      aria-hidden="true"
                    />
                  )}
                </button>
                {group.canDeleteSpace ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Actions for ${group.spaceName}`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      spaceMenuAnchor.current = event.currentTarget;
                      setSpaceMenu({
                        id: group.spaceId,
                        position: { x: rect.left, y: rect.bottom },
                      });
                    }}
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!collapsed &&
              group.bots.map((item) => {
                const selected =
                  (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                  (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                const running =
                  item.kind === "bot" &&
                  ACTIVE_RUN_STATUSES.some((status) => status === item.chat.status);
                return (
                  <button
                    key={`${item.kind}:${item.chat.id}`}
                    type="button"
                    draggable={item.kind === "bot" && !phone}
                    data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                    aria-keyshortcuts={
                      item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                    }
                    onDragStart={(event) => {
                      if (item.kind !== "bot") return;
                      setDraggedBotId(item.chat.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.chat.id);
                    }}
                    onDragOver={(event) => {
                      if (
                        item.kind === "bot" &&
                        draggedBotId &&
                        groupBotIds.includes(draggedBotId)
                      ) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => {
                      if (item.kind !== "bot" || !draggedBotId) return;
                      event.preventDefault();
                      reorderRosterBot(draggedBotId, item.chat.id, groupBotIds);
                      setDraggedBotId(null);
                    }}
                    onDragEnd={() => setDraggedBotId(null)}
                    onKeyDown={(event) => {
                      if (
                        item.kind !== "bot" ||
                        !event.altKey ||
                        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                      )
                        return;
                      const index = groupBotIds.indexOf(item.chat.id);
                      const target = groupBotIds[index + (event.key === "ArrowUp" ? -1 : 1)];
                      if (!target) return;
                      event.preventDefault();
                      reorderRosterBot(item.chat.id, target, groupBotIds);
                    }}
                    onClick={() => {
                      openSpaceChat(
                        item.chat.spaceId,
                        item.kind === "bot" ? `/app/${item.chat.id}` : `/app/g/${item.chat.id}`,
                      );
                    }}
                    {...longPress((target, point) => openChatMenu(item, target, point))}
                    className={`flex w-full items-center gap-2.75 rounded-row px-2.5 py-2.25 text-start max-md:touch-callout-none max-md:select-none ${
                      item.kind === "bot" ? "md:cursor-grab md:active:cursor-grabbing" : ""
                    } ${selected ? "bg-sidebar-accent max-md:bg-transparent" : "hover:bg-sidebar-accent"}`}
                    style={{
                      opacity: item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                    }}
                  >
                    {item.kind === "bot" ? (
                      <BotAvatar
                        character={item.chat.avatarCharacter}
                        size={28}
                        status={item.chat.status}
                      />
                    ) : (
                      <GroupAvatar
                        members={
                          item.chat.id === activeSnapshot?.groupId
                            ? (activeSnapshot.members ?? item.chat.members)
                            : item.chat.members
                        }
                        people={item.chat.people
                          .filter((person) => person.userId !== bootstrapMe?.userId)
                          .map((person) => ({
                            initials: userInitials(person.name),
                            image: person.image,
                          }))}
                        size={28}
                        userInitials={initials}
                        userImage={userImage}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          dir="auto"
                          data-roster-bot-name={item.kind === "bot" ? "" : undefined}
                          // The type token sets a weight that does not inherit,
                          // so the selected bump belongs on the name itself.
                          className={`truncate text-row-name text-foreground ${
                            selected ? "font-medium" : ""
                          }`}
                        >
                          {item.chat.name}
                          {item.chat.unread ? (
                            <span className="sr-only">
                              <Trans> (unread)</Trans>
                            </span>
                          ) : null}
                        </span>
                        {item.chat.unread ? (
                          <span
                            aria-hidden="true"
                            className="size-1.25 shrink-0 rounded-full bg-foreground"
                          />
                        ) : null}
                      </div>
                      <div dir="auto" className="truncate text-row-status text-foreground-subtle">
                        {running
                          ? runStatusLabel(item.chat.status)
                          : item.kind === "bot"
                            ? item.chat.title || item.chat.preview
                            : item.chat.preview ||
                              item.chat.members.map((member) => member.name).join(", ")}
                      </div>
                    </div>
                  </button>
                );
              })}
          </div>
        );
      })}
    </>
  );
}
