import { ChatMarkdown } from "@tangow/chat-ui/native";
import type { EntryId, MessageBlock, ThreadEntry, ThreadMessagePage } from "@tangow/contracts";
import {
  computeMessageGroups,
  peerConversations,
  showsTimeMarker,
  stripPeerAddressPrefix,
  threadTimeMarkerLabel,
} from "@tangow/core";
import { sizes } from "@tangow/ui-tokens";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { BotBubble } from "../components/bot-bubble";
import { MessageRow } from "../components/message-row";
import { StackedAvatars } from "../components/stacked-avatars";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

/** The shape `computeMessageGroups` needs from a peer message: both bots read
 * as bot narration (design contract §D), the direction standing in for
 * `botId` so rule R groups consecutive same-direction messages together. */
type PeerGroupable = {
  role: "bot";
  botId: string;
  blocks: MessageBlock[];
  createdAt: string;
};

const KEEP_VISIBLE_POSITION = { minIndexForVisible: 0 };

/**
 * View-only transcript of a bot-to-bot exchange, opened from a
 * Messaged / Message from chip in the human thread. Both bots render on the
 * left, grouped by author exactly like the multibot thread (design contract
 * §D, variant 4b) — never the `chatUser` bubble, which is reserved for the
 * human. Web counterpart: apps/web/src/pages/PeerMessagesOverlay.tsx.
 */
export default function PeerMessages() {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const { botId, botName, botCharacter, peerBotId, peerBotName, peerCharacter } =
    useLocalSearchParams<{
      botId?: string;
      botName?: string;
      botCharacter?: string;
      peerBotId?: string;
      peerBotName?: string;
      peerCharacter?: string;
    }>();
  const [entries, setEntries] = useState<readonly ThreadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const openedAtEnd = useRef(false);
  const olderCursor = useRef<EntryId | null>(null);
  const loadingOlder = useRef(false);

  useEffect(() => {
    if (!botId || !peerBotId) {
      setError(t("This chat link is incomplete"));
      setLoading(false);
      return;
    }
    let cancelled = false;
    void rpc<ThreadMessagePage>("threads/peerMessages", { botId, peerBotId })
      .then((page) => {
        if (cancelled) return;
        olderCursor.current = page.olderCursor;
        setEntries(page.entries);
        setLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : t("Could not load this chat"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, peerBotId]);

  async function loadOlder() {
    const before = olderCursor.current;
    if (!botId || !peerBotId || before === null || loadingOlder.current) return;
    loadingOlder.current = true;
    try {
      const page = await rpc<ThreadMessagePage>("threads/peerMessages", {
        botId,
        peerBotId,
        before,
      });
      olderCursor.current = page.olderCursor;
      setEntries((held) => [...page.entries, ...held]);
    } catch {
    } finally {
      loadingOlder.current = false;
    }
  }

  const conversation = useMemo(
    () => peerConversations(entries).find((entry) => entry.peerBotId === peerBotId) ?? null,
    [entries, peerBotId],
  );
  const peer = conversation?.peerBotName ?? peerBotName ?? t("Bot");
  const own = botName ?? t("Bot");

  const peerMessages = conversation?.messages ?? [];
  const groups = useMemo(() => {
    const groupable: PeerGroupable[] = peerMessages.map((message) => ({
      role: "bot",
      botId: message.direction === "sent" ? (botId ?? "own") : message.peerBotId,
      blocks: [{ kind: "text", text: message.text }],
      createdAt: message.createdAt,
    }));
    return computeMessageGroups(groupable);
  }, [peerMessages, botId]);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 240 }}>
              <StackedAvatars
                items={[
                  { identity: botId, character: botCharacter },
                  { identity: peerBotId, character: peerCharacter },
                ]}
                size={28}
              />
              <Text
                numberOfLines={1}
                style={{
                  ...nativeTextStyle("title", { size: 17, weight: 600 }),
                  color: tokens.foreground,
                }}
              >
                {`${own} · ${peer}`}
              </Text>
            </View>
          ),
        }}
      />
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 16 }}
        maintainVisibleContentPosition={KEEP_VISIBLE_POSITION}
        onContentSizeChange={() => {
          if (openedAtEnd.current || !entries.length) return;
          openedAtEnd.current = true;
          scroll.current?.scrollToEnd({ animated: false });
        }}
        scrollEventThrottle={100}
        onScroll={(event) => {
          if (openedAtEnd.current && event.nativeEvent.contentOffset.y < 400) void loadOlder();
        }}
      >
        {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
        {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
        {!loading && !error && !peerMessages.length ? (
          <Text
            style={{
              color: tokens.mutedForeground,
              fontSize: 13.5,
              textAlign: "center",
              padding: 24,
            }}
          >
            {t("No messages with {peer} yet.", { peer })}
          </Text>
        ) : null}
        {peerMessages.map((peerMessage, index) => {
          const group = groups[index]!;
          const previous = peerMessages[index - 1];
          const timeMarker = showsTimeMarker(previous?.createdAt, peerMessage.createdAt)
            ? threadTimeMarkerLabel(peerMessage.createdAt, {
                locale: dateLocaleForUi(),
                today: t("Today"),
                yesterday: t("Yesterday"),
              })
            : "";
          const sent = peerMessage.direction === "sent";
          const name = sent ? own : peer;
          const character = sent ? botCharacter : peerCharacter;
          return (
            <View
              key={peerMessage.messageId}
              style={{ marginTop: index === 0 ? 0 : group.isFirstOfGroup ? 14 : 3 }}
            >
              {timeMarker ? (
                <Text
                  style={{
                    alignSelf: "center",
                    marginBottom: 14,
                    color: tokens.mutedForeground,
                    ...nativeTextStyle("label"),
                  }}
                >
                  {timeMarker}
                </Text>
              ) : null}
              <MessageRow
                avatar={<BotAvatar character={character} size={sizes.message} />}
                author={name}
                showAuthor={group.isFirstOfGroup}
                showAvatar={group.isLastOfGroup}
              >
                <BotBubble accessible={false}>
                  <ChatMarkdown palette={tokens} colorScheme={colorScheme} inBubble>
                    {stripPeerAddressPrefix(peerMessage.text)}
                  </ChatMarkdown>
                </BotBubble>
              </MessageRow>
            </View>
          );
        })}
      </ScrollView>
      {peerMessages.length ? (
        <View
          style={{
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: tokens.border,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          <Text
            style={{
              color: tokens.mutedForeground,
              fontSize: 13,
              fontWeight: "500",
              textAlign: "center",
            }}
          >
            {t("This chat is view-only")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
