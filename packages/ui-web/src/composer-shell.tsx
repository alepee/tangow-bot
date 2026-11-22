import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";
import { cn } from "./lib/utils.js";

export type ComposerState = "idle" | "typing" | "dictating" | "speaking";

const BAR_DELAYS_MS = [0, 140, 280, 420];

export interface ComposerShellProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** The attach button — the capsule's leading edge. */
  attach?: ReactNode;
  /** The avatar of the bot that is speaking. */
  leading?: ReactNode;
  /** The field itself. */
  children: ReactNode;
  /** `roundIcon` buttons after the field: voice, then send / stop. */
  trailing?: ReactNode;
  /** Pending attachments, or rewind artifacts — rendered above the input line. */
  attachments?: ReactNode;
  state?: ComposerState;
  /**
   * Dictation mode's own row, under the field: × on the left, the waveform in
   * the middle (this component's own four bars), then this content on the
   * right (the ✓ disc, plus Stop when a reply is running). Only drawn while
   * `state="dictating"`.
   */
  dictationCancel?: ReactNode;
  dictationConfirm?: ReactNode;
}

/** The glass capsule floating over the bottom of the thread; its field's focus lifts it. */
export const ComposerShell = forwardRef<HTMLDivElement, ComposerShellProps>(function ComposerShell(
  {
    attach,
    leading,
    children,
    trailing,
    attachments,
    state = "idle",
    dictationCancel,
    dictationConfirm,
    className,
    ...props
  },
  ref,
) {
  const dictating = state === "dictating";
  return (
    <div
      ref={ref}
      data-slot="composer-shell"
      data-state={state}
      className={cn(
        "rk-glass-control flex min-h-12 flex-col justify-end gap-1.5 rounded-composer p-1.75 motion-safe:transition-shadow motion-safe:duration-(--duration-hover) motion-safe:ease-quiet",
        dictating
          ? "shadow-none ring-2 ring-inset ring-foreground"
          : "focus-within:shadow-composer-focus",
        className,
      )}
      {...props}
    >
      {attachments ? (
        <div data-slot="composer-attachments" className="flex flex-wrap gap-2 px-0.5 pt-0.5 pb-1.5">
          {attachments}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        {attach}
        {leading}
        <div data-slot="composer-shell-field" className="min-w-0 flex-1 px-1">
          {children}
        </div>
        {trailing}
      </div>
      {dictating && (dictationCancel || dictationConfirm) ? (
        <div data-slot="composer-dictation-controls" className="flex items-center gap-2">
          {dictationCancel}
          <span
            aria-hidden="true"
            data-slot="composer-dictating"
            className="flex flex-1 items-center justify-center gap-0.75"
          >
            {BAR_DELAYS_MS.map((delay) => (
              <span
                key={delay}
                className="rk-bar h-3.5 w-0.75 rounded-full bg-foreground"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          {dictationConfirm}
        </div>
      ) : null}
    </div>
  );
});

ComposerShell.displayName = "ComposerShell";
