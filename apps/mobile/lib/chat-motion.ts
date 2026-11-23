import { motion, springAt } from "@tangow/ui-tokens";
import {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";

/**
 * The thread's micro-feedback motion choices (design-motion spec, PR 2,
 * 7a–7g), gathered in one place so every component reads the same numbers
 * instead of re-deriving them. `useReducedMotion` itself stays the single
 * source of truth for the on/off switch — this module only adds the values
 * that switch depends on.
 */
export const CHAT_MOTION = {
  /** Every animation in this feature collapses to this fade under reduced motion. */
  reducedFadeMs: 120,

  /** 7a — the sent user bubble's spring entrance. */
  // Sent bubble: a firm, well-damped spring (damping ratio ~0.7): a small pop
  // you can feel, settled in ~300 ms. The mock's softer spring read as slow
  // and bouncy; an eased timing read as nothing at all.
  userEnterSpring: { damping: 28, stiffness: 400 } as const,
  // Swipe-to-reply release: well damped, so the bubble settles without
  // wobbling (under 1% overshoot).
  swipeReturnSpring: { damping: 30, stiffness: 320 } as const,
  userEnterTranslateY: 38,
  userEnterScaleFrom: 0.92,

  /** 7b — a new bot bubble's fade + rise. */
  botEnterMs: 220,
  botEnterEasing: Easing.bezier(0.2, 0.8, 0.2, 1),
  botEnterTranslateY: 8,
  botEnterStaggerMs: 70,
  botEnterStaggerCap: 4,

  /** 7c — the typing bubble's exit. */
  typingExitMs: 120,

  /** 7d — long-press press-down / rebound. */
  pressDownScale: 0.96,
  /** Hold before the press-down starts, so a scroll that grazes a bubble never dents it. */
  pressDownDelayMs: 150,
  pressDownMs: 150,
  pressReboundScale: 1.02,
  pressReboundMs: 90,
  reactionPopMs: 240,
  reactionPopScale: 1.25,

  /** 7e — decision card settling. */
  decisionCollapseMs: 320,
  decisionCheckMs: 200,

  /** 7g — swipe to reply. */
  swipeResistanceStart: 40,
  swipeResistanceFactor: 0.6,
  swipeThreshold: 56,
  swipeIconPopScale: 1.2,
  replyPreviewMs: 200,

  /** Capsule press (7e capsules, and reused wherever a capsule needs it). */
  capsulePressScale: 0.95,
  capsulePressMs: 160,
} as const;

/** The one place this feature reads `useReducedMotion` — every component
 * that needs to branch its motion imports this instead of calling Reanimated's
 * hook directly, so the choice never drifts component to component. */
export function useChatReducedMotion(): boolean {
  return useReducedMotion();
}

/** A shared `{ transform: [{ scale }] }` animated style, for anything that
 * only ever scales in place (capsule press, bubble press-down). */
export function usePressScaleStyle() {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return { scale, style };
}

const SPRING_STEPS = 60;
const SPRING_CURVE = Array.from({ length: SPRING_STEPS + 1 }, (_, i) =>
  i === SPRING_STEPS ? 1 : springAt((motion.flight * i) / SPRING_STEPS),
);

/** `motion.spring` over `motion.flight`, the curve the web flight runs on, so both end on time. */
export const SPRING_TIMING = {
  duration: motion.flight,
  easing: (t: number) => {
    "worklet";
    const at = Math.min(t * SPRING_STEPS, SPRING_STEPS - 1e-6);
    const i = Math.floor(at);
    const from = SPRING_CURVE[i] ?? 1;
    return from + ((SPRING_CURVE[i + 1] ?? 1) - from) * (at - i);
  },
};
