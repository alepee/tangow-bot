import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceInvitation, SpaceMembers } from "@tangow/contracts";
import { Button, Input, SettingRow, UserAvatar } from "@tangow/ui-web";
import type { FormEvent } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { AutoReviewSettings } from "../components/AutoReviewSettings";
import { rpc } from "../lib/rpc";
import { userInitials } from "../lib/user-initials";

type GeneralSpace = { id: string; name: string; canRename?: boolean };

export function SpaceGeneralSettings({
  space,
  onSpaceRenamed,
  messagingEnabled = false,
  onOpenMessaging,
  onOpenDecisionModel,
}: {
  space?: GeneralSpace;
  onSpaceRenamed?: () => void | Promise<void>;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  onOpenDecisionModel?: () => void;
}) {
  return (
    <div className="space-y-5">
      {space ? <SpaceNameRow key={space.id} space={space} onRenamed={onSpaceRenamed} /> : null}
      {space ? (
        <SpaceMembersSection key={space.id} spaceId={space.id} isOwner={space.canRename === true} />
      ) : null}

      {messagingEnabled && onOpenMessaging ? (
        <section className="rounded-card bg-group shadow-group px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Messaging</Trans>
          </h3>
          <p className="mt-3 text-[13px] text-muted-foreground/70">
            <Trans>Chat apps, group channels, and agent connections.</Trans>
          </p>
          <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
            <Trans>Manage messaging settings</Trans>
          </Button>
        </section>
      ) : null}

      <AutoReviewSettings onOpenDecisionModel={onOpenDecisionModel} />

      <details data-testid="advanced-settings" className="group rounded-card bg-group shadow-group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75">
          <span>
            <span className="block text-[15px] text-foreground">
              <Trans>Advanced</Trans>
            </span>
            <span className="mt-1 block text-[12.5px] text-muted-foreground/80">
              <Trans>Optional controls most people never need</Trans>
            </span>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-5">
          <ApprovalRulesSettings />
        </div>
      </details>
    </div>
  );
}

/** Saves on blur or Enter; an empty or unchanged name puts the saved one back. */
function SpaceNameRow({
  space,
  onRenamed,
}: {
  space: GeneralSpace;
  onRenamed?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [value, setValue] = useState(space.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(space.name);
  }, [space.name]);

  async function commit() {
    const name = value.trim();
    if (!name || name === space.name) {
      setValue(space.name);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rpc.spaces.rename({ spaceId: space.id, name });
    } catch {
      setValue(space.name);
      setError(t`Couldn't rename the space`);
      return;
    } finally {
      setPending(false);
    }
    setValue(name);
    await onRenamed?.();
  }

  return (
    <section className="rounded-card bg-group shadow-group px-4 py-3">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <label
          htmlFor={space.canRename ? inputId : undefined}
          className="text-row-name text-foreground"
        >
          <Trans>Name</Trans>
        </label>
        {space.canRename ? (
          <Input
            id={inputId}
            data-testid="space-name-input"
            value={value}
            maxLength={60}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="max-w-65"
          />
        ) : (
          <span className="min-w-0 truncate text-row-name text-muted-foreground">{space.name}</span>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const DAY_MS = 24 * 60 * 60_000;

function SpaceMembersSection({ spaceId, isOwner }: { spaceId: string; isOwner: boolean }) {
  const { t } = useLingui();
  const [view, setView] = useState<SpaceMembers | null>(null);
  const [pending, setPending] = useState(false);
  const [emails, setEmails] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setView(await rpc.spaces.members({ spaceId }));
  }, [spaceId]);

  useEffect(() => {
    void refresh().catch(() => setError(t`Couldn't load members`));
  }, [refresh, t]);

  async function act(action: () => Promise<void>, failure: string) {
    setPending(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async () => {
      await rpc.spaces.createInvite({
        spaceId,
        emails: emails
          .split(",")
          .map((email) => email.trim())
          .filter(Boolean),
      });
      setEmails("");
    }, t`Couldn't invite them`);
  }

  async function copyLink(invitation: SpaceInvitation) {
    setError(null);
    try {
      // Undefined outside a secure context, such as a self-hosted install over plain HTTP.
      await navigator.clipboard.writeText(invitation.url);
      setCopiedId(invitation.id);
    } catch {
      setError(t`Couldn't copy the link`);
    }
  }

  if (!view) {
    return error ? (
      <p role="alert" className="text-meta text-destructive">
        {error}
      </p>
    ) : null;
  }

  return (
    <section data-testid="space-members" className="rounded-card bg-group shadow-group">
      <h3 className="px-3.5 pt-3 text-label text-muted-foreground">
        <Trans>Members</Trans>
      </h3>
      {view.members.map((member) => (
        <SettingRow
          key={member.userId}
          leading={
            <UserAvatar
              initials={userInitials(member.name)}
              image={member.image}
              className="size-7 text-label"
            />
          }
          label={member.name}
          value={member.isOwner ? t`Owner` : undefined}
        >
          {isOwner && !member.isOwner ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                void act(
                  () =>
                    rpc.spaces
                      .removeMember({ spaceId, userId: member.userId })
                      .then(() => undefined),
                  t`Couldn't remove ${member.name}`,
                )
              }
            >
              <Trans>Remove</Trans>
            </Button>
          ) : null}
        </SettingRow>
      ))}
      {view.invitations.map((invitation) => {
        const days = Math.max(
          1,
          Math.ceil((new Date(invitation.expiresAt).getTime() - Date.now()) / DAY_MS),
        );
        return (
          <SettingRow
            key={invitation.id}
            data-testid="space-invite-row"
            label={<span className="break-all">{invitation.email}</span>}
            subline={plural(days, {
              one: "Expires in # day",
              other: "Expires in # days",
            })}
          >
            <Button variant="ghost" size="sm" onClick={() => void copyLink(invitation)}>
              {copiedId === invitation.id ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                void act(
                  () =>
                    rpc.spaces
                      .revokeInvite({ spaceId, invitationId: invitation.id })
                      .then(() => undefined),
                  t`Couldn't revoke the invite link`,
                )
              }
            >
              <Trans>Revoke</Trans>
            </Button>
          </SettingRow>
        );
      })}
      {isOwner ? (
        <form className="flex gap-2 px-3.5 pt-1 pb-3.5" onSubmit={invite}>
          <Input
            type="email"
            multiple
            required
            value={emails}
            disabled={pending}
            onChange={(event) => setEmails(event.target.value)}
            placeholder="ana@example.com, ben@example.com"
            aria-label={t`Emails to invite`}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" className="rounded-full" disabled={pending}>
            <Trans>Invite</Trans>
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="px-3.5 pb-3 text-meta text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
