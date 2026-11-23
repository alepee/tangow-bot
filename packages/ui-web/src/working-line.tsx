import { ChevronDown } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useLayoutEffect, useState } from "react";
import { cn } from "./lib/utils.js";
import { useElapsed } from "./use-elapsed.js";

export interface WorkingLineProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** A working `BotAvatar` at the `message` size. Omit it for no avatar column at all. */
  avatar?: ReactNode;
  /** "Maya is drafting the recap", already translated. */
  label: ReactNode;
  /** Epoch ms the run started. Falls back to mount time. */
  startedAt?: number;
}

/**
 * The only thing that moves while a bot works. A label too long for one line
 * is cut with an ellipsis; a chevron then opens it whole, and the label itself
 * is the toggle, so it needs no name of its own.
 */
export function WorkingLine({ avatar, label, startedAt, className, ...props }: WorkingLineProps) {
  const elapsed = useElapsed(startedAt);
  // A state ref: the label remounts when it moves into the toggle button,
  // and the measure must follow the new node.
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (!element || open) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, label, open]);

  const text = (
    <span
      ref={setElement}
      data-slot="working-line-label"
      className={cn(
        "min-w-0",
        open ? "break-words" : "truncate",
        "text-working text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
  return (
    <div
      data-slot="working-line"
      role="status"
      className={cn(
        "flex min-w-0 max-w-full gap-3.5",
        open ? "items-start" : "items-center",
        className,
      )}
      {...props}
    >
      {avatar ? <span className="w-message shrink-0">{avatar}</span> : null}
      {overflowing || open ? (
        <button
          type="button"
          data-slot="working-line-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 items-start gap-1.5 text-start duration-(--duration-hover) ease-quiet hover:text-foreground"
        >
          {text}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-hover) ease-quiet",
              open && "rotate-180",
            )}
          />
        </button>
      ) : (
        text
      )}
      <span
        aria-hidden="true"
        data-slot="working-line-elapsed"
        className="shrink-0 font-mono text-mono text-muted-foreground tabular-nums"
      >
        {elapsed}
      </span>
    </div>
  );
}
