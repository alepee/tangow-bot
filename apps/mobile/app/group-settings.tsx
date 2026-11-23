import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
} from "@tangow/contracts";
import { applyPicks, groupLeadBotId } from "@tangow/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { BotMemberPicker, PersonPicker, useSpacePeople } from "../components/bot-member-picker";
import { NativeMenu } from "../components/native-menu";
import { NativeSymbol } from "../components/native-symbol";
import { listGroups, type MobileBot, type MobileGroup, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { serverMessage } from "../lib/server-error";

/**
 * The lead the creator picked while it is still in the group, else the group's own, else its first
 * bot, as the server picks it.
 */
function leadOf(
  botIds: readonly string[],
  picked: string | null,
  current: string | null | undefined,
): string | undefined {
  const kept = [picked, current].find((id) => id && botIds.includes(id));
  return groupLeadBotId(
    botIds.map((id) => ({ id })),
    kept,
  );
}

/** The people the creator adds or takes out: everyone but themselves, who is always in it. */
function othersOf(group: MobileGroup) {
  return group.people.filter((person) => person.userId !== group.creatorId);
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export default function GroupSettingsScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const spacePeople = useSpacePeople();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [leadBotId, setLeadBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    void Promise.all([
      listGroups().then((groups) => groups.find((row) => row.id === groupId) ?? null),
      rpc<MobileBot[]>("bots/list"),
    ])
      .then(([nextGroup, nextBots]) => {
        if (!nextGroup) throw new Error(t("Group not found"));
        setGroup(nextGroup);
        setName(nextGroup.name);
        setDescription(nextGroup.description ?? "");
        setSelected(nextGroup.members.map((member) => member.botId));
        setUserIds(othersOf(nextGroup).map((person) => person.userId));
        setLeadBotId(nextGroup.leadBotId);
        setBots(nextBots);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load group")));
  }, [groupId]);

  // Someone the Space no longer lists stays pickable, so the creator can still take them out.
  const people = [
    ...spacePeople,
    ...(group ? othersOf(group) : []).filter(
      (person) => !spacePeople.some((other) => other.userId === person.userId),
    ),
  ];
  // A member the creator can no longer use stays listed, so they can still take it out.
  const selectable = [
    ...bots.filter((bot) => !bot.archivedAt),
    ...(group?.members ?? [])
      .filter((member) => !bots.some((bot) => bot.id === member.botId))
      .map((member) => ({ ...member, id: member.botId })),
  ];
  const groupBotIds = group?.members.map((member) => member.botId) ?? [];
  // The bots as they will be saved, the group's own first, so the lead shown is the one saved.
  const nextBotIds = applyPicks(groupBotIds, groupBotIds, selected);
  const lead = leadOf(nextBotIds, leadBotId, group?.leadBotId);
  const leadBot = selectable.find((bot) => bot.id === lead);

  async function save() {
    if (!groupId || !group || pending) return;
    setPending(true);
    setError(null);
    try {
      const input: {
        groupId: string;
        name?: string;
        description?: string;
        botIds?: string[];
        userIds?: string[];
        leadBotId?: string;
      } = { groupId };
      // What was switched in or out since the screen opened, applied to the group as it is now,
      // so someone who left meanwhile is not added back.
      const latest = (await listGroups()).find((row) => row.id === groupId) ?? group;
      const botIdsOf = (of: MobileGroup) => of.members.map((member) => member.botId);
      const peopleOf = (of: MobileGroup) => othersOf(of).map((person) => person.userId);
      const botIds = applyPicks(botIdsOf(latest), botIdsOf(group), selected);
      const nextPeople = applyPicks(peopleOf(latest), peopleOf(group), userIds);
      if (name.trim() !== latest.name) input.name = name.trim();
      if (description.trim() !== (latest.description ?? "")) input.description = description.trim();
      if (!sameIds(botIds, botIdsOf(latest))) input.botIds = botIds;
      if (!sameIds(nextPeople, peopleOf(latest))) input.userIds = nextPeople;
      // Unchanged bots keep the lead the server already gives the group; changed ones save the
      // lead shown, rather than leaving the server to pick the first of the new list.
      const savedLead = leadOf(botIds, leadBotId, latest.leadBotId);
      const picked = leadBotId !== group.leadBotId;
      if ((input.botIds || picked) && savedLead && savedLead !== latest.leadBotId)
        input.leadBotId = savedLead;
      if (Object.keys(input).length > 1) await rpc("groups/update", input);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save group"));
    } finally {
      setPending(false);
    }
  }

  function remove() {
    if (!groupId || !group) return;
    Alert.alert(group.name, t("Delete this group? Bots and their solo threads are kept."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () =>
          void rpc("groups/remove", { groupId })
            .then(() => router.replace("/"))
            .catch((err) =>
              Alert.alert(
                t("Could not delete group"),
                err instanceof Error ? err.message : t("Try again."),
              ),
            ),
      },
    ]);
  }

  function leave() {
    if (!groupId || !group) return;
    Alert.alert(group.name, undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Leave group"),
        style: "destructive",
        onPress: () =>
          void rpc("groups/leave", { groupId })
            .then(() => router.replace("/"))
            .catch((err) => setError(serverMessage(err) || t("Try again."))),
      },
    ]);
  }

  const label = { color: tokens.mutedForeground, fontSize: 14, marginTop: 20 };
  const field = {
    marginTop: 8,
    backgroundColor: tokens.muted,
    borderRadius: 11,
    padding: 14,
    color: tokens.foreground,
    fontSize: 16,
  };

  // Nothing to change until it is known whose group this is.
  if (!group) {
    return (
      <>
        <Stack.Screen options={{ title: t("Group settings") }} />
        <ScrollView
          style={{ flex: 1, backgroundColor: tokens.background }}
          contentContainerStyle={{ padding: 24 }}
        >
          {error ? <Text style={{ color: tokens.destructive }}>{error}</Text> : null}
        </ScrollView>
      </>
    );
  }

  // Only its creator changes a group; everyone else sees who is in it and may leave.
  if (!group.canManage) {
    return (
      <>
        <Stack.Screen options={{ title: t("Group settings") }} />
        <ScrollView
          testID="group-settings"
          style={{ flex: 1, backgroundColor: tokens.background }}
          contentContainerStyle={{ padding: 24 }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 20, fontWeight: "600" }}>
            {group.name}
          </Text>
          {group.description ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 16, marginTop: 6 }}>
              {group.description}
            </Text>
          ) : null}
          <Text style={label}>{t("People")}</Text>
          <PersonPicker people={group.people} />
          <Text style={label}>{t("Bots")}</Text>
          <BotMemberPicker
            bots={group.members.map((member) => ({ ...member, id: member.botId }))}
          />
          {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
          <Pressable
            onPress={leave}
            style={{
              marginTop: 24,
              borderRadius: 11,
              borderWidth: 1,
              borderColor: tokens.border,
              padding: 14,
              alignItems: "center",
            }}
          >
            <Text style={{ color: tokens.destructive, fontSize: 16 }}>{t("Leave group")}</Text>
          </Pressable>
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t("Group settings") }} />
      <ScrollView
        testID="group-settings"
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("Group name")}
          placeholderTextColor={tokens.mutedForeground}
          style={field}
        />
        <Text style={label}>{t("Description")}</Text>
        <TextInput
          value={description}
          maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this group is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{ ...field, minHeight: 96, textAlignVertical: "top" }}
        />
        {people.length > 0 ? (
          <>
            <Text style={label}>{t("People")}</Text>
            <PersonPicker
              people={people}
              selected={userIds}
              onChange={setUserIds}
              disabled={pending}
            />
          </>
        ) : null}
        <Text style={label}>{t("Bots")}</Text>
        <BotMemberPicker
          bots={selectable}
          selected={selected}
          onChange={setSelected}
          disabled={pending}
        />
        {nextBotIds.length > 1 && lead ? (
          <>
            <Text style={label}>{t("Lead bot")}</Text>
            <NativeMenu
              compact
              title={t("Lead bot")}
              accessibilityLabel={t("Lead bot")}
              accessibilityValue={leadBot?.name}
              disabled={pending}
              options={nextBotIds.flatMap((id) => {
                const bot = selectable.find((candidate) => candidate.id === id);
                return bot ? [{ value: bot.id, label: bot.name }] : [];
              })}
              selected={lead}
              onSelect={setLeadBotId}
              style={{ ...field, flexDirection: "row", alignItems: "center", gap: 10 }}
            >
              {leadBot ? <BotAvatar character={leadBot.avatarCharacter} size={22} /> : null}
              <Text style={{ flex: 1, color: tokens.foreground, fontSize: 16 }}>
                {leadBot?.name}
              </Text>
              <NativeSymbol
                ios="chevron.up.chevron.down"
                android="chevron-expand"
                size={15}
                color={tokens.mutedForeground}
              />
            </NativeMenu>
          </>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            opacity:
              !name.trim() ||
              selected.length < GROUP_MEMBER_MIN ||
              selected.length > GROUP_MEMBER_MAX ||
              pending
                ? 0.5
                : 1,
            borderRadius: 11,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16, fontWeight: "600" }}>
            {pending ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
        <Pressable
          onPress={remove}
          style={{
            marginTop: 16,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: tokens.border,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.destructive, fontSize: 16 }}>{t("Delete group")}</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
