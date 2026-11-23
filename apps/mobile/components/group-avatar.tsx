import { memo } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { native, useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { UserAvatar } from "./user-avatar";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  avatarCharacter?: string | null;
  status?: string;
}

export interface GroupAvatarPerson {
  initials: string;
  image?: string | null;
}

type Tile = { bot: GroupAvatarMember } | { person: GroupAvatarPerson };

export const GroupAvatar = memo(function GroupAvatar({
  members,
  people = [],
  size = 54,
  userInitials,
  userImage,
}: {
  members: GroupAvatarMember[];
  /** The group's other people, shown beside its bots. */
  people?: GroupAvatarPerson[];
  size?: number;
  /** When set, a one-bot group without other people pairs the bot with the user's initials. */
  userInitials?: string;
  /** Profile photo shown instead of the initials tile, initials on failure. */
  userImage?: string | null;
}) {
  const styles = useThemedStyles(createGroupAvatarStyles);
  const bots: Tile[] = members.map((bot) => ({ bot }));
  const others: Tile[] = people.map((person) => ({ person }));
  const me: Tile[] =
    members.length === 1 && others.length === 0 && (userInitials || userImage)
      ? [{ person: { initials: userInitials ?? "", image: userImage } }]
      : [];
  // The first bot and the first person lead, so both kinds stay visible when the rest overflow.
  const tiles = [bots[0], others[0], ...me, ...bots.slice(1), ...others.slice(1)].filter(
    (tile) => tile !== undefined,
  );
  const firstTile = tiles[0];
  if (!firstTile) {
    return (
      <View
        style={[
          styles.fallback,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.35) }]}>👥</Text>
      </View>
    );
  }

  // A pile of tiles stays still, as on web; a lone bot comes alive like any avatar.
  const renderTile = (tile: Tile, tileSize: number) =>
    "bot" in tile ? (
      <BotAvatar
        character={tile.bot.avatarCharacter}
        size={tileSize}
        status={tile.bot.status}
        still={tiles.length > 1}
      />
    ) : (
      <UserAvatar initials={tile.person.initials} image={tile.person.image} size={tileSize} />
    );

  if (tiles.length === 1) return renderTile(firstTile, size);

  const pair = tiles.length === 2;
  const miniSize = Math.round(size * (pair ? 0.65 : 0.54));
  const positions: ViewStyle[] = pair
    ? [
        { top: 0, left: 0 },
        { right: 0, bottom: 0 },
      ]
    : [
        { top: 0, left: (size - miniSize) / 2 },
        { bottom: 0, left: 0 },
        { right: 0, bottom: 0 },
      ];
  const visibleTiles = tiles.slice(0, tiles.length <= 3 ? tiles.length : 2);

  return (
    <View style={{ width: size, height: size, position: "relative" }}>
      {visibleTiles.map((tile, index) => (
        <View
          key={"bot" in tile ? (tile.bot.botId ?? index) : `person-${index}`}
          style={{
            position: "absolute",
            ...positions[index],
            zIndex: index + 1,
          }}
        >
          {renderTile(tile, miniSize)}
        </View>
      ))}
      {tiles.length > 3 ? (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            zIndex: 3,
            width: miniSize,
            height: miniSize,
            borderRadius: miniSize / 2,
            backgroundColor: native.fillPressed,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: native.label, fontSize: 10, fontWeight: "600" }}>
            +{tiles.length - 2}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function createGroupAvatarStyles() {
  return StyleSheet.create({
    fallback: {
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    fallbackText: {
      color: native.secondaryLabel,
    },
  });
}
