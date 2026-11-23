import { groupBotsForSidebar } from "@tangow/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { readActivityMode, writeActivityMode } from "../../lib/activity-mode";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../../lib/bots-sidebar-pref";
import { selectedSpaceId, selectSpace } from "../../lib/rpc";
import type { Roster } from "./use-roster";

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `tangow:collapsed-sidebar-sections:${userId}`;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  const storageKey = collapsedSidebarSectionsStorageKey(userId);
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * The sidebar's own state: its sections across spaces, which are collapsed,
 * whether it is hidden, and the activity list toggle.
 */
export function useSidebarState({
  userId,
  roster,
  navigate,
}: {
  userId: string | undefined;
  roster: Roster;
  navigate: NavigateFunction;
}) {
  const { bootstrapMe, botSections, bots, groups, spaces, switchSpace } = roster;
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const botsSidebarEdgeDragRef = useRef<{ startX: number; mode: "expand" | "collapse" } | null>(
    null,
  );
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
  }, [userId]);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);

  const sidebarGroups = useMemo(() => {
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    const showSpaceNames = sidebarSpaces.length > 1;
    return sidebarSpaces.flatMap((space) => {
      const sections = groupBotsForSidebar(
        [
          ...space.bots.map((chat) => ({ kind: "bot" as const, chat })),
          ...space.groups.map((chat) => ({ kind: "group" as const, chat })),
        ].map((item) => ({ ...item, pinned: item.chat.pinned, sectionId: item.chat.sectionId })),
        space.botSections,
      ).map((group, index) => ({
        ...group,
        sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
        key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
        title: showSpaceNames
          ? group.title
            ? `${space.name} · ${group.title}`
            : space.name
          : group.title,
        showLock: showSpaceNames,
        emptySpaceId: undefined as string | undefined,
        spaceId: space.id,
        spaceName: space.name,
        canDeleteSpace: index === 0 && space.canDelete === true,
      }));
      if (sections.length > 0) return sections;
      // Keep empty spaces selectable; chat clicks are the only switch control.
      if (!showSpaceNames) return [];
      return [
        {
          key: `space:${space.id}:empty`,
          title: space.name,
          bots: [],
          sectionId: null,
          showLock: true,
          emptySpaceId: space.id,
          spaceId: space.id,
          spaceName: space.name,
          canDeleteSpace: space.canDelete === true,
        },
      ];
    });
  }, [bootstrapMe, botSections, bots, groups, spaces]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      const previousSpaceId = selectedSpaceId();
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      const selectionStored = selectSpace(spaceId);
      if (!selectionStored) return;
      const previousEffective = previousSpaceId ?? bootstrapMe?.spaceId;
      // Opened from the phone's bot list: the chat's Back returns to it by popping this entry.
      const open = (target: string) =>
        navigate(
          target,
          window.location.pathname === "/app" && target !== "/app"
            ? { state: { fromList: true } }
            : undefined,
        );
      if (previousEffective === spaceId) {
        open(path);
        return;
      }
      // The bare /app asks for the new space's home rather than a specific chat.
      void switchSpace().then(
        (home) => open(path === "/app" ? home : path),
        // Fall back to a reload so the requests' space header and the UI never disagree.
        () => window.location.assign(path),
      );
    },
    [bootstrapMe?.spaceId, navigate, switchSpace],
  );
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        const storageKey = collapsedSidebarSectionsStorageKey(userId);
        if (storageKey) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            // Keep the UI usable when storage is unavailable.
          }
        }
        return next;
      });
    },
    [userId],
  );
  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  return {
    archivedOpen,
    setArchivedOpen,
    collapsedSidebarSections,
    toggleSidebarSection,
    botsSidebarCollapsed,
    setBotsSidebarCollapsedPref,
    botsSidebarEdgeDragRef,
    draggedBotId,
    setDraggedBotId,
    activityMode,
    toggleActivityMode,
    sidebarGroups,
    openSpaceChat,
  };
}
