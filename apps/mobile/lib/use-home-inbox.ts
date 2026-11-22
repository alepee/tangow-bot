import type { RunActivityRow, SearchHit } from "@tangow/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { fetchSpaceActivity } from "./activity";
import { loadActivityMode, saveActivityMode } from "./activity-mode";
import type {
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSpace,
  MobileSpaceNavigation,
} from "./api";
import { fetchProfileImage, loadSessionToken, rpc, selectInitialSpace } from "./api";
import { subscribeBotSaved, withSavedAvatar } from "./bot-page-state";
import { useI18n } from "./i18n";
import { filterBots } from "./inbox";
import type { InboxSpace, InboxSpaceItem } from "./inbox-spaces";
import {
  canDeleteInboxSpace,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
  unreadConversationCount,
} from "./inbox-spaces";
import { syncAppBadge } from "./live-notifications";
import { setProfilePhoto } from "./profile-photo";
import { registerPushToken } from "./push";
import { querySpaceSearch } from "./search";

export type InboxItem = InboxSpaceItem | { type: "search"; hit: SearchHit };

export function useHomeInbox() {
  const { t, locale } = useI18n();
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [botSections, setBotSections] = useState<MobileBotSection[]>([]);
  const [spaces, setSpaces] = useState<MobileSpace[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activityMode, setActivityMode] = useState(false);
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const activityRequestId = useRef(0);
  const inboxRequestId = useRef(0);
  const spaceActionRef = useRef<{ busy: boolean; recoveryId: string | null }>({
    busy: false,
    recoveryId: null,
  });
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [spaceRecoveryId, setSpaceRecoveryId] = useState<string | null>(null);

  useEffect(() => {
    void loadActivityMode().then(setActivityMode);
  }, []);

  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      void saveActivityMode(next);
      return next;
    });
  }, []);

  const loadBots = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    const requestId = ++inboxRequestId.current;
    setError(null);
    try {
      const [navigation, nextMe] = await Promise.all([
        rpc<MobileSpaceNavigation>("spaces/list"),
        rpc<MobileMe>("me"),
      ]);
      if (requestId !== inboxRequestId.current) return;
      if (!(await selectInitialSpace(nextMe.spaceId))) {
        throw new Error(t("Could not save the default space"));
      }
      if (requestId !== inboxRequestId.current) return;
      setBots(navigation.current.bots);
      setBotSections(navigation.current.botSections);
      setGroups(navigation.current.groups);
      setSpaces(navigation.spaces);
      setMe(nextMe);
      void syncAppBadge(unreadConversationCount(navigation.spaces)).catch(() => undefined);
      // The photo lives on the session user, not on `me`.
      void fetchProfileImage()
        .then(setProfilePhoto)
        .catch(() => undefined);
    } catch (err) {
      if (requestId !== inboxRequestId.current) return;
      setError(err instanceof Error ? err.message : t("Could not load bots"));
    }
  }, []);

  const refreshBots = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadBots();
    } finally {
      setRefreshing(false);
    }
  }, [loadBots]);

  useEffect(
    () => subscribeBotSaved((saved) => setBots((list) => withSavedAvatar(list, saved))),
    [],
  );

  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    // Nothing to show the user here, but a silent failure means the device quietly
    // stops being paged — leave a breadcrumb in the device log instead.
    void registerPushToken().catch((cause) => console.warn("push registration", cause));
  }, [hasSession]);

  useFocusEffect(
    useCallback(() => {
      if (!hasSession) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        if (AppState.currentState === "active") await loadBots();
        if (!cancelled) timer = setTimeout(() => void tick(), 5_000);
      };
      void tick();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [hasSession, loadBots]),
  );

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode || searching || query.trim()) {
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
    } catch {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
    }
  }, [activityMode, hasSession, query, searching]);

  useFocusEffect(
    useCallback(() => {
      if (!hasSession || !activityMode || searching || query.trim()) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const tick = async () => {
        await loadActivity();
        if (!cancelled) {
          timer = setTimeout(() => void tick(), 15_000);
        }
      };

      void tick();
      return () => {
        cancelled = true;
        activityRequestId.current += 1;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [activityMode, hasSession, loadActivity, query, searching]),
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!searching || !trimmed) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setSearchLoading(true);
      void querySpaceSearch(trimmed)
        .then((hits) => {
          if (!abort.signal.aborted) setSearchHits(hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, searching]);

  const visible = useMemo(() => filterBots(bots, query), [bots, query]);
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) =>
      `${group.name} ${group.preview}`.toLowerCase().includes(needle),
    );
  }, [groups, query]);
  const listData = useMemo((): InboxItem[] => {
    if (query.trim() && searching) {
      return searchHits.map((hit) => ({ type: "search", hit }));
    }
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === me?.spaceId
              ? { ...space, bots: visible, groups: visibleGroups, botSections }
              : {
                  ...space,
                  bots: filterBots(space.bots, query),
                  groups: space.groups.filter((group) =>
                    `${group.name} ${group.preview}`
                      .toLowerCase()
                      .includes(query.trim().toLowerCase()),
                  ),
                },
          )
        : me
          ? [
              {
                id: me.spaceId,
                name: t("Personal"),
                isDefault: true,
                hasContent: true,
                bots: visible,
                groups: visibleGroups,
                botSections,
              },
            ]
          : [];
    return spaceInboxItems(sidebarSpaces);
  }, [botSections, locale, me, spaces, query, searching, searchHits, visible, visibleGroups]);

  async function chooseInboxSpace(spaceId: string) {
    if (spaceActionRef.current.busy) return;
    spaceActionRef.current.busy = true;
    setSpaceBusy(true);
    inboxRequestId.current += 1;
    activityRequestId.current += 1;
    setActivity({ active: [], recent: [] });
    try {
      const refresh = async () => {
        spaceActionRef.current.recoveryId = null;
        setSpaceRecoveryId(null);
        spaceActionRef.current.busy = false;
        await refreshBots();
        await loadActivity();
      };
      const selected =
        spaceActionRef.current.recoveryId === spaceId
          ? await retryInboxSpaceFallback(spaceId, refresh)
          : await selectInboxSpace(spaceId, refresh);
      if (!selected) throw new Error(t("Could not switch spaces"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Could not switch spaces");
      setError(message);
      Alert.alert(message, t("Try again."));
    } finally {
      spaceActionRef.current.busy = false;
      setSpaceBusy(false);
    }
  }

  async function deleteInboxSpace(space: InboxSpace) {
    if (
      !canDeleteInboxSpace(space) ||
      spaceActionRef.current.busy ||
      spaceActionRef.current.recoveryId
    )
      return;
    spaceActionRef.current.busy = true;
    setSpaceBusy(true);
    inboxRequestId.current += 1;
    activityRequestId.current += 1;
    try {
      const recoveryId = await removeInboxSpace(space.id, async () => {
        spaceActionRef.current.busy = false;
        setActivity({ active: [], recent: [] });
        await refreshBots();
        await loadActivity();
      });
      if (recoveryId) {
        spaceActionRef.current.recoveryId = recoveryId;
        setSpaceRecoveryId(recoveryId);
        setError(t("Could not switch spaces"));
      }
    } catch (err) {
      Alert.alert(
        t("Could not delete space"),
        err instanceof Error ? err.message : t("Try again."),
      );
    } finally {
      spaceActionRef.current.busy = false;
      setSpaceBusy(false);
    }
  }

  return {
    bots,
    groups,
    botSections,
    me,
    error,
    setError,
    ready,
    hasSession,
    refreshing,
    query,
    setQuery,
    searching,
    setSearching,
    setSearchHits,
    searchLoading,
    activityMode,
    toggleActivityMode,
    activity,
    spaceActionRef,
    spaceBusy,
    spaceRecoveryId,
    loadBots,
    refreshBots,
    loadActivity,
    listData,
    chooseInboxSpace,
    deleteInboxSpace,
  };
}
