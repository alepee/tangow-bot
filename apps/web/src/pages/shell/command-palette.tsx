import { Trans, useLingui } from "@lingui/react/macro";
import type { SearchHit, SearchHitKind } from "@tangow/contracts";
import {
  BotAvatar,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  GroupAvatar,
  Kbd,
} from "@tangow/ui-web";
import type { LucideIcon } from "lucide-react";
import { FileText, Link, MessageSquare, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";
import { userInitials } from "../../lib/user-initials";
import type { SettingsSection } from "../settings-sections";
import {
  accountSettingsSections,
  SETTINGS_NAV,
  SPACE_SETTINGS_SECTIONS,
} from "../settings-sections";
import { commandModifierKey } from "./command-palette-hotkey";
import type { SidebarChat, SidebarGroup } from "./layout";

type HitKind = Exclude<SearchHitKind, "conversation">;

const HIT_ICONS: Record<HitKind, LucideIcon> = {
  message: MessageSquare,
  routine: Repeat,
  file: FileText,
  link: Link,
};

function chatSearchText(item: SidebarChat) {
  return item.kind === "bot"
    ? `${item.chat.name} ${item.chat.title ?? ""} ${item.chat.preview ?? ""}`.toLowerCase()
    : `${item.chat.name} ${item.chat.preview}`.toLowerCase();
}

function hitKey(hit: SearchHit) {
  return `${hit.kind}-${hit.botId ?? hit.groupId}-${hit.messageId ?? hit.artifactId ?? hit.routineId ?? hit.url}`;
}

/** The ⌘K palette: the roster's bots and chats, the space's content and the settings sections. */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  userId,
  initials,
  userImage,
  onSelectChat,
  onSelectSettings,
  onSelectHit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: SidebarGroup[];
  userId: string | undefined;
  initials: string;
  userImage: string | null;
  onSelectChat: (item: SidebarChat) => void;
  onSelectSettings: (section: SettingsSection) => void;
  onSelectHit: (hit: SearchHit) => void;
}) {
  const { t } = useLingui();
  const [search, setSearch] = useState("");
  // Hits remember their query, so a finished search never shows under a newer one.
  const [found, setFound] = useState<{ query: string; hits: SearchHit[] }>({ query: "", hits: [] });
  const [loading, setLoading] = useState(false);
  const modKey = commandModifierKey();
  const query = search.trim();
  const needle = query.toLowerCase();
  const allHits = useMemo(() => (found.query === query ? found.hits : []), [found, query]);
  const hits = allHits.filter((hit) => hit.kind !== "conversation");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const chats = useMemo(() => {
    const items = groups.flatMap((group) => group.bots);
    // The server also matches what the roster doesn't carry, such as a bot's description.
    const matched = new Set(
      allHits.flatMap((hit) => (hit.kind === "conversation" ? [hit.botId ?? hit.groupId] : [])),
    );
    const visible = needle
      ? items.filter((item) => matched.has(item.chat.id) || chatSearchText(item).includes(needle))
      : items;
    return {
      bots: visible.filter((item) => item.kind === "bot"),
      groups: visible.filter((item) => item.kind === "group"),
    };
  }, [groups, needle, allHits]);

  const settings = useMemo(() => {
    if (!needle) return [];
    return [...accountSettingsSections(), ...SPACE_SETTINGS_SECTIONS].filter((id) =>
      t(SETTINGS_NAV[id].label).toLowerCase().includes(needle),
    );
  }, [t, needle]);

  useEffect(() => {
    if (!open || !query) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void rpc.search
        .query({ q: query })
        .then((result) => {
          if (!abort.signal.aborted) {
            setFound({ query, hits: result.hits });
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) setFound({ query, hits: [] });
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const allBots = useMemo(
    () =>
      new Map(
        groups
          .flatMap((group) => group.bots)
          .flatMap((item) => (item.kind === "bot" ? [[item.chat.id, item.chat] as const] : [])),
      ),
    [groups],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) {
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const item = chats.bots[Number(event.key) - 1];
      if (!item) return;
      event.preventDefault();
      onSelectChat(item);
      onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chats.bots, onOpenChange, onSelectChat, open]);

  function select(action: () => void) {
    action();
    onOpenChange(false);
  }

  const hitGroups: { kind: HitKind; heading: string }[] = [
    { kind: "message", heading: t`Messages` },
    { kind: "routine", heading: t`Routines` },
    { kind: "file", heading: t`Files` },
    { kind: "link", heading: t`Links` },
  ];

  const chatRow = (item: SidebarChat, index: number) => {
    const shortcut = item.kind === "bot" && index < 9 ? `${modKey}${index + 1}` : null;
    return (
      <CommandItem
        key={`chat:${item.chat.id}`}
        value={`chat:${item.chat.id}`}
        data-testid={`command-palette-${item.kind}-${item.chat.id}`}
        onSelect={() => select(() => onSelectChat(item))}
        className="gap-2.75 px-2.5 py-2.25"
      >
        {item.kind === "bot" ? (
          <BotAvatar character={item.chat.avatarCharacter} size={28} status={item.chat.status} />
        ) : (
          <GroupAvatar
            members={item.chat.members}
            people={item.chat.people
              .filter((person) => person.userId !== userId)
              .map((person) => ({ initials: userInitials(person.name), image: person.image }))}
            size={28}
            userInitials={initials}
            userImage={userImage}
          />
        )}
        <RowText
          name={item.chat.name}
          unread={item.chat.unread}
          status={
            item.kind === "bot"
              ? item.chat.title || item.chat.preview
              : item.chat.preview || item.chat.members.map((member) => member.name).join(", ")
          }
        />
        {shortcut ? (
          <CommandShortcut className="tracking-normal">
            <Kbd>{shortcut}</Kbd>
          </CommandShortcut>
        ) : null}
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`Search`}
      description={t`Search bots, chats, settings`}
      className="sm:max-w-2xl"
    >
      <Command
        shouldFilter={false}
        className="rk-glass-list rounded-bubble"
        data-testid="command-palette"
      >
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={t`Search bots, chats, settings`}
          data-testid="command-palette-search"
        />
        <CommandList className="max-h-[min(24rem,50svh)]" data-testid="command-palette-list">
          <CommandEmpty>
            {loading ? <Trans>Searching…</Trans> : <Trans>No results</Trans>}
          </CommandEmpty>
          {chats.bots.length > 0 ? (
            <CommandGroup heading={t`Bots`}>{chats.bots.map(chatRow)}</CommandGroup>
          ) : null}
          {chats.groups.length > 0 ? (
            <CommandGroup heading={t`Chats`}>{chats.groups.map(chatRow)}</CommandGroup>
          ) : null}
          {hitGroups.map(({ kind, heading }) => {
            const rows = hits.filter((hit) => hit.kind === kind);
            if (rows.length === 0) return null;
            return (
              <CommandGroup key={kind} heading={heading}>
                {rows.map((hit) => {
                  const bot = kind === "message" && hit.botId ? allBots.get(hit.botId) : undefined;
                  const chatName = hit.groupName ?? hit.botName;
                  return (
                    <CommandItem
                      key={hitKey(hit)}
                      value={`hit:${hitKey(hit)}`}
                      onSelect={() => select(() => onSelectHit(hit))}
                      className="gap-2.75 px-2.5 py-2.25"
                    >
                      {bot ? (
                        <BotAvatar character={bot.avatarCharacter} size={28} />
                      ) : (
                        <IconTile icon={HIT_ICONS[kind]} />
                      )}
                      <RowText
                        name={hit.title}
                        status={
                          kind === "message" || !chatName
                            ? hit.snippet
                            : `${chatName} · ${hit.snippet}`
                        }
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            );
          })}
          {settings.length > 0 ? (
            <CommandGroup heading={t`Settings`}>
              {settings.map((id) => (
                <CommandItem
                  key={`settings:${id}`}
                  value={`settings:${id}`}
                  data-testid={`command-palette-settings-${id}`}
                  onSelect={() => select(() => onSelectSettings(id))}
                  className="gap-2.75 px-2.5 py-2.25"
                >
                  <IconTile icon={SETTINGS_NAV[id].icon} />
                  <RowText name={t(SETTINGS_NAV[id].label)} />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** The roster row's two lines: the name, bolder when selected, and a quieter status. */
function RowText({
  name,
  status,
  unread = false,
}: {
  name: ReactNode;
  status?: ReactNode;
  unread?: boolean;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <span
          dir="auto"
          className="truncate text-row-name text-foreground group-data-selected/command-item:font-medium"
        >
          {name}
          {unread ? (
            <span className="sr-only">
              <Trans> (unread)</Trans>
            </span>
          ) : null}
        </span>
        {unread ? (
          <span aria-hidden="true" className="size-1.25 shrink-0 rounded-full bg-foreground" />
        ) : null}
      </div>
      {status ? (
        <div dir="auto" className="truncate text-row-status text-foreground-subtle">
          {status}
        </div>
      ) : null}
    </div>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-row bg-well text-foreground group-data-selected/command-item:bg-card">
      <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

export { isCommandPaletteHotkey } from "./command-palette-hotkey";
