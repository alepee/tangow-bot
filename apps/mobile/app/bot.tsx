import { routineFailing } from "@tangow/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Keyboard, ScrollView, StyleSheet, View } from "react-native";
import { AmbientBackground } from "../components/ambient-background";
import { ActivityTab, useOpenRun } from "../components/bot-page/activity-tab";
import { BotHero, BotTabs } from "../components/bot-page/hero";
import { LoadFailed } from "../components/bot-page/kit";
import { KnowledgeTab } from "../components/bot-page/knowledge-tab";
import { RoutinesTab, useRoutines } from "../components/bot-page/routines-tab";
import { SettingsTab } from "../components/bot-page/settings-tab";
import { useHeaderMenu } from "../components/native-menu";
import {
  archiveBot,
  clearConversation,
  confirmClearConversation,
  confirmDeleteBot,
} from "../lib/bot-lifecycle";
import { readBotPage, readViewer, useBotPageContext } from "../lib/bot-page";
import { botRunEpoch, subscribeBotRunEnds } from "../lib/bot-page-state";
import type { BotTab } from "../lib/bot-tab";
import { useI18n } from "../lib/i18n";

/**
 * The bot's page, pushed from its thread: who it is at the top, then Activity, Routines, Knowledge
 * and Settings. Every field saves itself. Opened as its settings (`tab`), it lands on Settings.
 */
export default function BotPageScreen() {
  const { botId = "", tab } = useLocalSearchParams<{ botId: string; tab?: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const openRun = useOpenRun();
  const page = useBotPageContext(botId);
  const [readFailed, setReadFailed] = useState(false);
  const [view, setView] = useState<BotTab>(tab === "settings" ? "settings" : "activity");
  const scroll = useRef<ScrollView>(null);
  /** Open work's add field is the page's last row: bring it above the keyboard it opens. */
  const revealEnd = useCallback(() => {
    if (Keyboard.isVisible()) {
      scroll.current?.scrollToEnd();
      return;
    }
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      shown.remove();
      scroll.current?.scrollToEnd();
    });
    setTimeout(() => shown.remove(), 1000);
  }, []);
  const epoch = useSyncExternalStore(
    subscribeBotRunEnds,
    () => botRunEpoch(botId),
    () => botRunEpoch(botId),
  );

  // Freshness: the bot may change its own settings mid-run. A new `epoch` (a run ended) makes a
  // new callback, which the focused page runs again and a covered page runs when it comes back.
  const refresh = useCallback(() => {
    if (!botId) return;
    void Promise.all([readBotPage(botId), readViewer()]).then(
      () => setReadFailed(false),
      () => setReadFailed(true),
    );
  }, [botId, epoch]);
  useFocusEffect(refresh);
  // The bot's status, read again every 5 s while the page shows, as on Home: its face shows a run
  // that starts. A failed read here keeps what was shown.
  useFocusEffect(
    useCallback(() => {
      if (!botId) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        if (AppState.currentState === "active") await readBotPage(botId).catch(() => undefined);
        if (!cancelled) timer = setTimeout(() => void tick(), 5_000);
      };
      timer = setTimeout(() => void tick(), 5_000);
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [botId]),
  );
  const routineList = useRoutines(botId, epoch);
  const routineFailed = routineList.routines?.some(routineFailing) ?? false;

  const leave = () => {
    router.dismissAll();
    router.replace("/");
  };
  const menu = useHeaderMenu(
    t("Actions for {name}", { name: page?.bot.name ?? "" }),
    page
      ? [
          {
            label: t("Share"),
            onPress: () => router.push({ pathname: "/bot-share", params: { botId } }),
          },
          {
            label: t("Clear conversation"),
            destructive: true,
            onPress: () => confirmClearConversation(() => clearConversation(botId)),
          },
          { label: t("Archive"), onPress: () => archiveBot(botId, leave) },
          {
            label: t("Delete…"),
            destructive: true,
            onPress: () => confirmDeleteBot({ id: botId, name: page.bot.name }, leave),
          },
        ]
      : [],
  );
  const showMenu = page && !page.readOnly;

  return (
    <>
      <Stack.Screen
        options={{
          // The page runs under the bar on the ambient light; iOS 26 blurs it at the edge.
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          unstable_headerRightItems: showMenu ? menu.unstable_headerRightItems : undefined,
          headerRight: showMenu ? menu.headerRight : () => null,
        }}
      />
      <AmbientBackground />
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        {page ? (
          <>
            <BotHero
              page={page}
              onAppearance={() =>
                router.push({ pathname: "/bot-appearance", params: { botId: page.bot.id } })
              }
            />
            <View style={styles.body}>
              <BotTabs value={view} onChange={setView} routineFailed={routineFailed} />
              {view === "activity" ? (
                <ActivityTab
                  botId={page.bot.id}
                  epoch={epoch}
                  // An archived bot's chat cannot be opened, nor its routines or instructions.
                  onOpenRun={page.readOnly ? undefined : openRun}
                  onOpenRoutine={
                    page.readOnly
                      ? undefined
                      : (routineId) =>
                          router.push({
                            pathname: "/bot-routine",
                            params: { botId: page.bot.id, routineId },
                          })
                  }
                  onWriteInstructions={
                    page.readOnly || page.bot.instructions
                      ? undefined
                      : () =>
                          router.push({
                            pathname: "/bot-text",
                            params: { botId: page.bot.id, field: "instructions" },
                          })
                  }
                />
              ) : view === "routines" ? (
                <RoutinesTab
                  page={page}
                  list={routineList}
                  onOpen={(routine) =>
                    router.push({
                      pathname: "/bot-routine",
                      params: { botId, routineId: routine.id },
                    })
                  }
                  onCreate={() => router.push({ pathname: "/bot-routine-new", params: { botId } })}
                />
              ) : view === "knowledge" ? (
                <KnowledgeTab page={page} epoch={epoch} onAddFocus={revealEnd} />
              ) : (
                <SettingsTab page={page} />
              )}
            </View>
          </>
        ) : readFailed ? (
          <LoadFailed onRetry={refresh} />
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 20, gap: 28 },
});
