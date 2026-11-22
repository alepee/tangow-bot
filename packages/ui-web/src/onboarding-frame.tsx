import { wordmark } from "@tangow/avatars/brand/wordmark";
import type { FormEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";

/** Must match the phone breakpoint in `onboarding.css`. */
const PHONE_MAX_WIDTH = 860;

export type OnboardingFrameProps = {
  /** The scene card's content: a picture laid over the clay plate. */
  scene: ReactNode;
  title: ReactNode;
  /** The step's fields. */
  children?: ReactNode;
  /** Anchored at the bottom of the step, main button first. */
  actions: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

/**
 * One frame for every step before an account exists: the wordmark, the clay scene
 * card and a step box of fixed height whose actions sit at its foot, so the title
 * and the main button land at the same place on every step.
 */
export function OnboardingFrame({
  scene,
  title,
  children,
  actions,
  onSubmit,
}: OnboardingFrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  useKeyboardInset(frame);
  return (
    <div ref={frame} className="rk-onboarding" data-slot="onboarding-frame">
      <div className="rk-onboarding-top">
        <svg
          className="rk-onboarding-logo"
          viewBox={wordmark.viewBox}
          role="img"
          aria-label="Tangow"
        >
          <path fill="currentColor" fillRule="evenodd" d={wordmark.path} />
        </svg>
      </div>
      <div className="rk-onboarding-pane">
        <form className="rk-onboarding-screen" onSubmit={onSubmit}>
          <h1>{title}</h1>
          {children}
          <div className="rk-onboarding-actions">{actions}</div>
        </form>
      </div>
      <div className="rk-onboarding-stage">{scene}</div>
    </div>
  );
}

/**
 * Phone keyboard: the main button rides just above it and the focused field is
 * scrolled above the button. Measured against the layout viewport, because iOS
 * 27 Safari shrinks `innerHeight` with the keyboard.
 */
function useKeyboardInset(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const frame = ref.current;
    const viewport = window.visualViewport;
    if (!frame || !viewport) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const layout = document.documentElement.clientHeight;
      const covered = layout - viewport.height;
      const open = covered > 80 && viewport.scale < 1.05 && frame.clientWidth <= PHONE_MAX_WIDTH;
      frame.style.setProperty("--kb", `${Math.max(0, covered - viewport.offsetTop)}px`);
      frame.toggleAttribute("data-keyboard", open);
      document.body.style.paddingBottom = open ? `${covered}px` : "";
      const field = document.activeElement;
      const button = frame.querySelector(".rk-onboarding-actions > :first-child");
      if (!open || !button || !(field instanceof HTMLElement) || !field.matches("input, select")) {
        return;
      }
      const overlap =
        field.getBoundingClientRect().bottom + 12 - button.getBoundingClientRect().top;
      if (overlap > 1) window.scrollBy(0, overlap);
    };
    // Moving between fields with the keyboard already up fires no viewport event.
    const onFocus = () => {
      clearTimeout(settle);
      settle = setTimeout(update, 350);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", onFocus);
    return () => {
      clearTimeout(settle);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", onFocus);
      document.body.style.paddingBottom = "";
    };
  }, [ref]);
}
