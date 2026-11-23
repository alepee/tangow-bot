import type { NativeEntityMentions, TableActions } from "@tangow/chat-ui/native";
import { NativeEntityMentionsProvider, TableActionsProvider } from "@tangow/chat-ui/native";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { EntityMentionGlyph } from "./entity-mention-glyph";

/** What a thread's bubbles read: their table actions, and the entities a mention can name. */
export function ThreadProviders({
  tableActions,
  mentions,
  skills,
  children,
}: {
  tableActions: TableActions;
  mentions: NativeEntityMentions["mentions"];
  skills: NativeEntityMentions["skills"];
  children: ReactNode;
}) {
  // The bubbles draw in place what the composer can name.
  const entityMentions = useMemo<NativeEntityMentions>(
    () => ({
      mentions,
      skills,
      glyph: (mention, tint) => <EntityMentionGlyph mention={mention} tint={tint} />,
    }),
    [mentions, skills],
  );
  return (
    <NativeEntityMentionsProvider value={entityMentions}>
      <TableActionsProvider value={tableActions}>{children}</TableActionsProvider>
    </NativeEntityMentionsProvider>
  );
}
