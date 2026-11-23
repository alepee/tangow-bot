import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, GroupPerson } from "@tangow/contracts";
import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
} from "@tangow/contracts";
import { applyPicks, groupLeadBotId } from "@tangow/core";
import {
  BotAvatar,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  UserAvatar,
} from "@tangow/ui-web";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { userInitials } from "../lib/user-initials";

function validSelection(name: string, selected: readonly string[]) {
  return (
    Boolean(name.trim()) &&
    selected.length >= GROUP_MEMBER_MIN &&
    selected.length <= GROUP_MEMBER_MAX
  );
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

type PickerBot = Pick<Bot, "id" | "name" | "avatarCharacter"> & {
  status?: string;
};

/** The Space's other people, those a group's creator can add; none when they can't be read. */
function useSpacePeople(spaceId: string | undefined, userId: string): GroupPerson[] {
  const [people, setPeople] = useState<GroupPerson[]>([]);
  useEffect(() => {
    if (!spaceId) return;
    let live = true;
    rpc.spaces.members({ spaceId }).then(
      (view) =>
        live &&
        setPeople(
          view.members
            .filter((member) => member.userId !== userId)
            .map(({ userId, name, image }) => ({ userId, name, image })),
        ),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [spaceId, userId]);
  return people;
}

function personAvatar(person: GroupPerson) {
  return (
    <UserAvatar
      initials={userInitials(person.name)}
      image={person.image}
      className="size-8 text-label"
    />
  );
}

function botAvatar(bot: PickerBot) {
  return <BotAvatar character={bot.avatarCharacter} size={32} status={bot.status} />;
}

/** A person or bot of the group: a toggle while it is being picked, a plain row otherwise. */
function MemberRow({
  avatar,
  name,
  checked = false,
  onToggle,
}: {
  avatar: ReactNode;
  name: string;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {avatar}
      <span className="flex-1 text-[15px] text-foreground" dir="auto">
        {name}
      </span>
      {checked ? <Check size={14} className="text-muted-foreground" aria-hidden /> : null}
    </>
  );
  const layout = "flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start";
  return onToggle ? (
    <button
      type="button"
      aria-pressed={checked}
      onClick={onToggle}
      className={`${layout} ${checked ? "bg-muted" : "hover:bg-accent"}`}
    >
      {content}
    </button>
  ) : (
    <div className={layout}>{content}</div>
  );
}

function toggled(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

/** The Space's other people to add, shown only when the Space has any. */
function PeoplePicker({
  people,
  selected,
  onChange,
}: {
  people: GroupPerson[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  if (people.length === 0) return null;
  return (
    <>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>People</Trans>
      </div>
      <div className="mt-2 max-h-[240px] space-y-1 overflow-y-auto">
        {people.map((person) => (
          <MemberRow
            key={person.userId}
            avatar={personAvatar(person)}
            name={person.name}
            checked={selected.includes(person.userId)}
            onToggle={() => onChange(toggled(selected, person.userId))}
          />
        ))}
      </div>
    </>
  );
}

function MemberPicker({
  bots,
  selected,
  onChange,
  maxHeight,
}: {
  bots: PickerBot[];
  selected: string[];
  onChange: (selected: string[]) => void;
  maxHeight: "max-h-[240px]" | "max-h-[280px]";
}) {
  function toggle(botId: string) {
    if (selected.includes(botId) || selected.length < GROUP_MEMBER_MAX) {
      onChange(toggled(selected, botId));
    }
  }

  return (
    <div className={`mt-2 ${maxHeight} space-y-1 overflow-y-auto`}>
      {bots.map((bot) => (
        <MemberRow
          key={bot.id}
          avatar={botAvatar(bot)}
          name={bot.name}
          checked={selected.includes(bot.id)}
          onToggle={() => toggle(bot.id)}
        />
      ))}
    </div>
  );
}

export type GroupInput = {
  name: string;
  description: string;
  botIds: string[];
  userIds: string[];
};

export function CreateGroupForm({
  bots,
  spaceId,
  userId,
  onCancel,
  onCreate,
}: {
  bots: Bot[];
  spaceId: string | undefined;
  userId: string;
  onCancel: () => void;
  onCreate: (input: GroupInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedPeople, setSelectedPeople] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = useSpacePeople(spaceId, userId);
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  async function create() {
    if (submitting || !validSelection(name, selected)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        botIds: selected,
        userIds: selectedPeople,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not create group`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New group</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new group`}
          onClick={onCancel}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this group`}
          className="mt-2"
        />
      </label>
      <label htmlFor={descriptionId} className="mt-5 block text-sm text-muted-foreground">
        <Trans>Description</Trans>
        <Textarea
          id={descriptionId}
          value={description}
          maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this group is for`}
          rows={3}
          className="mt-2"
        />
      </label>
      <PeoplePicker people={people} selected={selectedPeople} onChange={setSelectedPeople} />
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members (pick {GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={selectable}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[280px]"
      />
      <Button
        className="mt-5 w-full"
        disabled={submitting || !validSelection(name, selected)}
        onClick={() => void create()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create group</Trans>}
      </Button>
    </div>
  );
}

/**
 * The group's settings for its creator. Everyone else sees who is in it, read-only, and can leave.
 */
export function GroupSettings({
  group,
  bots,
  userId,
  onSave,
  onRemove,
  onLeave,
}: {
  group: Group;
  bots: Bot[];
  userId: string;
  onSave: (input: Partial<GroupInput> & { leadBotId?: string | null }) => Promise<void>;
  onRemove: () => Promise<void>;
  onLeave: () => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(group.name);
  // Older API builds omit description; treat missing as empty so save() never trims undefined.
  const currentDescription = group.description ?? "";
  const [description, setDescription] = useState(currentDescription);
  const currentBotIds = group.members.map((member) => member.botId);
  const [openedBotIds] = useState(currentBotIds);
  const [selected, setSelected] = useState(currentBotIds);
  const nextBotIds = applyPicks(currentBotIds, openedBotIds, selected);
  // The creator is always in the group: only the others are picked.
  const currentPeople = group.people.map((person) => person.userId).filter((id) => id !== userId);
  const [openedPeople] = useState(currentPeople);
  const [selectedPeople, setSelectedPeople] = useState(currentPeople);
  const nextPeople = applyPicks(currentPeople, openedPeople, selectedPeople);
  const leadId = useId();
  const [lead, setLead] = useState(group.leadBotId);
  // The lead leaves with its bot; the first bot answers then.
  const currentLead = lead && nextBotIds.includes(lead) ? lead : null;
  const [pending, setPending] = useState<"save" | "remove" | "leave" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spacePeople = useSpacePeople(group.canManage ? group.spaceId : undefined, userId);
  // Someone the Space no longer lists stays pickable, so the creator can still take them out.
  const people = [
    ...spacePeople,
    ...group.people.filter(
      (person) =>
        person.userId !== userId && !spacePeople.some((other) => other.userId === person.userId),
    ),
  ];
  // A member the creator can no longer use stays listed, so they can still take it out.
  const selectable = useMemo(
    () => [
      ...bots.filter((bot) => !bot.archivedAt),
      ...group.members
        .filter((member) => !bots.some((bot) => bot.id === member.botId))
        .map((member) => ({ ...member, id: member.botId })),
    ],
    [bots, group.members],
  );

  async function mutate(kind: "save" | "remove" | "leave", action: () => Promise<void>) {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : kind === "save"
            ? t`Could not save group`
            : kind === "remove"
              ? t`Could not remove group`
              : t`Could not leave group`,
      );
    } finally {
      setPending(null);
    }
  }

  function save() {
    return onSave({
      name: name.trim() !== group.name ? name.trim() : undefined,
      description: description.trim() !== currentDescription ? description.trim() : undefined,
      botIds: sameMembers(nextBotIds, currentBotIds) ? undefined : nextBotIds,
      userIds: sameMembers(nextPeople, currentPeople) ? undefined : nextPeople,
      leadBotId: currentLead !== group.leadBotId ? currentLead : undefined,
    });
  }

  if (!group.canManage) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[13.5px] text-muted-foreground">
            <Trans>Group settings</Trans>
          </span>
        </div>
        {error ? (
          <p role="alert" className="mb-3 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="space-y-1">
          {group.people.map((person) => (
            <MemberRow key={person.userId} avatar={personAvatar(person)} name={person.name} />
          ))}
          {group.members.map((member) => (
            <MemberRow
              key={member.botId}
              avatar={botAvatar({ ...member, id: member.botId })}
              name={member.name}
            />
          ))}
        </div>
        <Button
          variant="destructive"
          className="mt-5 w-full"
          disabled={pending !== null}
          onClick={() => void mutate("leave", onLeave)}
        >
          {pending === "leave" ? <Trans>Leaving…</Trans> : <Trans>Leave group</Trans>}
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <label htmlFor={descriptionId} className="mt-5 block text-sm text-muted-foreground">
        <Trans>Description</Trans>
        <Textarea
          id={descriptionId}
          value={description}
          maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this group is for`}
          rows={3}
          className="mt-2"
        />
      </label>
      <PeoplePicker people={people} selected={selectedPeople} onChange={setSelectedPeople} />
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={selectable}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[240px]"
      />
      {nextBotIds.length > 1 ? (
        <label htmlFor={leadId} className="mt-5 block text-sm text-muted-foreground">
          <Trans>Lead bot</Trans>
          <NativeSelect
            id={leadId}
            // With none chosen, the group's first bot leads, as the server picks it.
            value={groupLeadBotId(
              nextBotIds.map((id) => ({ id })),
              currentLead,
            )}
            onChange={(event) => setLead(event.target.value)}
            className="mt-2 w-full"
          >
            {nextBotIds.map((botId) => (
              <NativeSelectOption key={botId} value={botId}>
                {selectable.find((bot) => bot.id === botId)?.name ?? ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      <Button
        className="mt-5 w-full"
        disabled={pending !== null || !validSelection(name, nextBotIds)}
        onClick={() => void mutate("save", save)}
      >
        {pending === "save" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
      <Button
        variant="destructive"
        className="mt-4 w-full"
        disabled={pending !== null}
        onClick={() => void mutate("remove", onRemove)}
      >
        {pending === "remove" ? <Trans>Deleting…</Trans> : <Trans>Delete group</Trans>}
      </Button>
    </div>
  );
}

export function memberName(
  members: Group["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}
