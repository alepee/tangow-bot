import type { RunActivityRow, SearchHit, SpaceBot, SpaceGroup } from "@tangow/contracts";
import { sizes } from "@tangow/ui-tokens";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { activityStatusLabel, formatActivityRelativeTime } from "../../lib/activity";
import type { MobileBot, MobileGroup } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { botTag, formatThreadTime, userInitials as initialsOf } from "../../lib/inbox";
import { useThemedStyles } from "../../lib/native";
import { previewSnippet } from "../../lib/preview";
import { rosterMuted } from "../../lib/shared-bot";
import { BotAvatar } from "../bot-avatar";
import { GroupAvatar } from "../group-avatar";
import { createHomeStyles } from "./styles";

export function ActivitySection({
  activity,
  bots,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const openRun = (run: RunActivityRow) => {
    if (run.groupId) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t("Group") },
      });
      return;
    }
    router.push({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
  };

  return (
    <View style={styles.activitySection}>
      {activity.active.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>{t("Now")}</Text>
          {activity.active.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
      {activity.recent.length > 0 ? (
        <>
          <Text style={[styles.sectionHeading, activity.active.length > 0 && styles.activityGap]}>
            {t("Recent")}
          </Text>
          {activity.recent.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

function ActivityRow({
  run,
  bot,
  onPress,
}: {
  run: RunActivityRow;
  bot?: MobileBot;
  onPress: () => void;
}) {
  const title = run.groupName ? `${run.botName} · ${run.groupName}` : run.botName;
  const status = activityStatusLabel(run.status);
  const preview = run.promptSnippet ? `${run.promptSnippet} · ${status}` : status;
  const time = formatActivityRelativeTime(run.updatedAt);
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={time}
      accessibilityLabel={[title, status, time].filter(Boolean).join(", ")}
      onPress={onPress}
      avatar={
        <BotAvatar character={bot?.avatarCharacter} status={run.status} size={sizes.mobileStack} />
      }
    />
  );
}

function ConversationRow({
  title,
  preview,
  avatar,
  tag,
  time,
  unread,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  preview: string;
  avatar: ReactNode;
  tag?: string | null;
  time?: string | null;
  unread?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const styles = useThemedStyles(createHomeStyles);
  // No card and no tag chip, but the row is sized for a thumb: a 44 pt avatar,
  // a name at reading size, one status line, and the time in its own column.
  const status = [tag, preview].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {avatar}
      <View style={styles.rowBody}>
        <View style={styles.titleRow}>
          <Text
            style={[styles.name, unread && styles.nameUnread]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {title}
          </Text>
          {unread ? <View accessibilityElementsHidden style={styles.unreadDot} /> : null}
          {time ? (
            <Text accessibilityElementsHidden style={styles.time} numberOfLines={1}>
              {time}
            </Text>
          ) : null}
        </View>
        <Text style={styles.status} numberOfLines={1}>
          {status}
        </Text>
      </View>
    </Pressable>
  );
}

export function SearchRow({ hit, onPress }: { hit: SearchHit; onPress: () => void }) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowBody}>
        <View style={styles.searchRowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {hit.title}
          </Text>
          <Text style={styles.searchRowKind}>{hit.kind}</Text>
        </View>
        <Text style={styles.searchRowSnippet} numberOfLines={2}>
          {hit.groupName ?? hit.botName} · {hit.snippet}
        </Text>
      </View>
    </Pressable>
  );
}

export function BotRow({
  bot,
  onPress,
  onLongPress,
}: {
  bot: MobileBot | SpaceBot;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { t } = useI18n();
  const preview = previewSnippet(bot.preview, 40) || bot.title || t("No messages yet");
  const time = bot.updatedAt ? formatThreadTime(bot.updatedAt) : "";
  const tag = botTag(bot.title, bot.name);
  // Spelled out because an explicit label replaces the one built from the row's children.
  const label = [
    bot.name,
    tag,
    rosterMuted(bot) ? t("notifications silenced") : null,
    bot.unread ? t("unread") : null,
    time,
    preview,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <ConversationRow
      title={bot.name}
      preview={preview}
      tag={tag}
      time={time}
      unread={bot.unread}
      accessibilityLabel={label}
      accessibilityHint={
        onLongPress ? t("Long press to pin, move, or silence notifications") : undefined
      }
      onPress={onPress}
      onLongPress={onLongPress}
      avatar={
        <BotAvatar
          character={bot.avatarCharacter}
          status={bot.status}
          muted={rosterMuted(bot)}
          size={sizes.mobileStack}
        />
      }
    />
  );
}

export function GroupRow({
  group,
  userId,
  userInitials,
  userImage,
  onPress,
  onLongPress,
}: {
  group: MobileGroup | SpaceGroup;
  userId: string | undefined;
  userInitials: string;
  userImage: string | null;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { t } = useI18n();
  const preview =
    previewSnippet(group.preview, 40) || group.members.map((member) => member.name).join(", ");
  const time = group.updatedAt ? formatThreadTime(group.updatedAt) : "";
  return (
    <ConversationRow
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[group.name, group.unread ? t("unread") : null, time, preview]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={onLongPress ? t("Long press to pin or move to a section") : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      avatar={
        <GroupAvatar
          members={group.members}
          // A server from before space groups carried people sends none.
          people={(group.people ?? [])
            .filter((person) => person.userId !== userId)
            .map((person) => ({ initials: initialsOf(person.name), image: person.image }))}
          size={sizes.mobileStack}
          userInitials={userInitials}
          userImage={userImage}
        />
      }
    />
  );
}
