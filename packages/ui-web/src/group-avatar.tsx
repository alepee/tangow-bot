import { type CSSProperties, memo } from "react";
import { BotAvatar } from "./bot-avatar.js";
import { cn } from "./lib/utils.js";
import { UserAvatar } from "./user-avatar.js";

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

export interface GroupAvatarProps {
  members: GroupAvatarMember[];
  /** The group's other people, shown beside its bots. */
  people?: GroupAvatarPerson[];
  size?: number;
  className?: string;
  /** When set, a one-bot group without other people pairs the bot with the user's initials. */
  userInitials?: string;
  /** Profile photo shown instead of the initials tile, initials on failure. */
  userImage?: string | null;
}

type Tile = { bot: GroupAvatarMember } | { person: GroupAvatarPerson };

export const GroupAvatar = memo(function GroupAvatar({
  members,
  people = [],
  size = 38,
  className,
  userInitials,
  userImage,
}: GroupAvatarProps) {
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
      <div
        className={cn(
          "tangow-group-avatar relative flex items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size, flex: "none" }}
      >
        <svg
          aria-hidden="true"
          width={Math.round(size * 0.48)}
          height={Math.round(size * 0.48)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
    );
  }

  if (tiles.length === 1) {
    return renderTile(firstTile, size, cn("tangow-group-avatar", className));
  }

  const pair = tiles.length === 2;
  const miniSize = Math.round(size * (pair ? 0.65 : 0.54));
  const positions: CSSProperties[] = pair
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
    <div
      className={cn("tangow-group-avatar relative rounded-full select-none", className)}
      style={{ width: size, height: size, flex: "none" }}
    >
      {visibleTiles.map((tile, index) => (
        <div
          key={"bot" in tile ? (tile.bot.botId ?? index) : `person-${index}`}
          className="absolute rounded-full"
          style={{
            ...positions[index],
            zIndex: index + 1,
            boxShadow: "0 0 0 1.5px var(--accent)",
          }}
        >
          {renderTile(tile, miniSize)}
        </div>
      ))}
      {tiles.length > 3 ? (
        <div
          className="absolute right-0 bottom-0 z-[3] flex items-center justify-center rounded-full bg-accent text-label font-semibold text-foreground"
          style={{
            width: miniSize,
            height: miniSize,
            boxShadow: "0 0 0 1.5px var(--accent)",
          }}
        >
          {`+${tiles.length - 2}`}
        </div>
      ) : null}
    </div>
  );
});

function renderTile(tile: Tile, size: number, className?: string) {
  if ("bot" in tile) {
    return (
      <BotAvatar
        character={tile.bot.avatarCharacter}
        size={size}
        status={tile.bot.status}
        className={className}
      />
    );
  }
  return (
    <UserAvatar
      // Decorative: the initials would otherwise prefix the row's accessible name.
      aria-hidden="true"
      initials={tile.person.initials}
      image={tile.person.image}
      className={className}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
    />
  );
}
