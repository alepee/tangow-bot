import type { ComponentPropsWithoutRef } from "react";
import { BotAvatar } from "./bot-avatar.js";
import { cn } from "./lib/utils.js";

/** `receipt`, `stackXs`, `interstitial` and `stack` from the `sizes` tokens. */
export type StackedAvatarSize = 14 | 16 | 17 | 20;

/** How far each avatar slides under the one before it, per stack size. */
const OVERLAP: Record<StackedAvatarSize, number> = { 14: 3, 16: 4, 17: 4, 20: 5 };

export interface StackedAvatarItem {
  identity?: string;
  working?: boolean;
  character?: string | null;
}

export interface StackedAvatarsProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  items: StackedAvatarItem[];
  size: StackedAvatarSize;
  /** Avatars shown before the rest collapses into `+N`. */
  max?: number;
  /**
   * Translated name for the group ("Maya, Atlas and 2 more"). Without it the
   * stack is decoration and is hidden from assistive technology, which is right
   * when the sentence beside it already names the bots.
   */
  label?: string;
}

/** The bots behind a group, a delegation or a receipt, in one glance. */
export function StackedAvatars({
  items,
  size,
  max = 3,
  label,
  className,
  ...props
}: StackedAvatarsProps) {
  const shown = items.slice(0, max);
  const overflow = items.length - shown.length;
  // Named for assistive technology, or hidden from it — never a bare label on a
  // role that cannot carry one. Keeping the pair together enforces that.
  const labelling = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <span
      data-slot="stacked-avatars"
      data-size={size}
      {...labelling}
      className={cn("inline-flex items-center", className)}
      {...props}
    >
      {shown.map((item, index) => (
        <span
          key={item.identity ?? index}
          className="inline-flex"
          style={index === 0 ? undefined : { marginInlineStart: -OVERLAP[size] }}
        >
          <BotAvatar
            character={item.character}
            size={size}
            status={item.working ? "running" : undefined}
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          data-slot="stacked-avatars-overflow"
          className="ps-1 text-label text-muted-foreground"
        >
          {`+${overflow}`}
        </span>
      ) : null}
    </span>
  );
}
