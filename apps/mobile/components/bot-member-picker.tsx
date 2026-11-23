import type { GroupPerson, SpaceMembers } from "@tangow/contracts";
import { GROUP_MEMBER_MAX } from "@tangow/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { type MobileBot, type MobileMe, rpc } from "../lib/api";
import { userInitials } from "../lib/inbox";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { UserAvatar } from "./user-avatar";

type PickerBot = Pick<MobileBot, "id" | "name" | "avatarCharacter"> & {
  status?: string;
};

/** A group's bots, each switched in or out; without `onChange`, only listed. */
export function BotMemberPicker({
  bots,
  selected = [],
  onChange,
  disabled = false,
}: {
  bots: PickerBot[];
  selected?: string[];
  onChange?: (botIds: string[]) => void;
  disabled?: boolean;
}) {
  return bots.map((bot) => (
    <MemberRow
      key={bot.id}
      avatar={<BotAvatar character={bot.avatarCharacter} size={34} status={bot.status} />}
      name={bot.name}
      checked={selected.includes(bot.id)}
      disabled={disabled || (!selected.includes(bot.id) && selected.length >= GROUP_MEMBER_MAX)}
      onToggle={
        onChange &&
        ((next) => {
          if (next && selected.length >= GROUP_MEMBER_MAX) return;
          onChange(next ? [...selected, bot.id] : selected.filter((id) => id !== bot.id));
        })
      }
    />
  ));
}

/** The other people of your Space, whom a group's creator can add to it. */
export function useSpacePeople(): GroupPerson[] {
  const [people, setPeople] = useState<GroupPerson[]>([]);
  useEffect(() => {
    let live = true;
    void rpc<MobileMe>("me")
      .then(async (me) => {
        const { members } = await rpc<SpaceMembers>("spaces/members", { spaceId: me.spaceId });
        if (live) setPeople(members.filter((member) => member.userId !== me.userId));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return people;
}

/** A group's people, each switched in or out; without `onChange`, only listed. */
export function PersonPicker({
  people,
  selected = [],
  onChange,
  disabled = false,
}: {
  people: GroupPerson[];
  selected?: string[];
  onChange?: (userIds: string[]) => void;
  disabled?: boolean;
}) {
  return people.map((person) => (
    <MemberRow
      key={person.userId}
      avatar={<UserAvatar initials={userInitials(person.name)} image={person.image} size={34} />}
      name={person.name}
      checked={selected.includes(person.userId)}
      disabled={disabled}
      onToggle={
        onChange &&
        ((next) =>
          onChange(
            next ? [...selected, person.userId] : selected.filter((id) => id !== person.userId),
          ))
      }
    />
  ));
}

function MemberRow({
  avatar,
  name,
  checked,
  disabled,
  onToggle,
}: {
  avatar: ReactNode;
  name: string;
  checked: boolean;
  disabled: boolean;
  onToggle?: (next: boolean) => void;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={styles.row}>
      {avatar}
      <Text style={[styles.name, { color: tokens.foreground }]}>{name}</Text>
      {onToggle ? (
        <Switch
          accessibilityLabel={name}
          value={checked}
          disabled={disabled}
          trackColor={{ false: tokens.border, true: tokens.primary }}
          thumbColor={checked ? tokens.primaryForeground : tokens.foreground}
          onValueChange={onToggle}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  name: { flex: 1, fontSize: 16 },
});
