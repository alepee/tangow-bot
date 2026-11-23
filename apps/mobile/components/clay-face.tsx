import type { AvatarCrop, CharacterFace, FaceState } from "@tangow/contracts";
import {
  eyesCentre,
  eyeVeil,
  FACE_BLINK_JITTER_MS,
  FACE_GLANCE,
  gazeOffsets,
  pupilReach,
} from "@tangow/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Image as SvgImage } from "react-native-svg";
import type { FaceMotionPlan, FacePose } from "../lib/clay-face";
import {
  FACES,
  mixPose,
  motionPlan,
  playCycle,
  playSpans,
  poseOf,
  samePose,
} from "../lib/clay-face";
import type { Frame } from "./clay-face-layers";
import {
  ClosedLid,
  LID_TRAVEL,
  LowerLid,
  Mouth,
  PUPIL_ROOM,
  Pupil,
  place,
  Under,
  UpperLid,
} from "./clay-face-layers";

const EXPRESSION_MS = 300;
const EXPRESSION_EASING = Easing.bezier(0.23, 1, 0.32, 1);
/** A glance eases out and back, as fast as the web animator's per-frame easing. */
const GLANCE_MOVE_MS = 250;
/** One period of the mouth tremor: the brand animator's `sin(0.07 t)`. */
const TREMOR_MS = (2 * Math.PI) / 0.07;
/** Reduce Motion, followed live: Reanimated's hook reads the setting once. */
function useReduceMotion(): boolean {
  const initial = useReducedMotion();
  const [reduced, setReduced] = useState(initial);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (mounted) setReduced(on);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** The pose drawn: from the still's, eased into each new expression; snapped under Reduce Motion. */
function useFacePose(face: CharacterFace, target: FacePose, reduced: boolean): FacePose {
  const [pose, setPose] = useState(() => poseOf(face, { expression: face.defaut, gaze: "free" }));
  const shown = useRef(pose);
  shown.current = pose;
  useEffect(() => {
    const from = shown.current;
    if (reduced || samePose(from, target)) {
      setPose(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / EXPRESSION_MS);
      setPose(k === 1 ? target : mixPose(from, target, EXPRESSION_EASING(k)));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reduced]);
  return pose;
}

const native = { useNativeDriver: true } as const;

function loopOf(value: Animated.Value, duration: number) {
  value.setValue(0);
  return Animated.loop(
    Animated.timing(value, { toValue: 1, duration, easing: Easing.linear, ...native }),
  );
}

/**
 * Blinks, glances, the idle motion and the tremor, on the native driver: each runs as a native
 * animation started by a timer or a loop, so a live face costs no JavaScript per frame.
 * Gaze is in gaze units on top of the pose, `tic` -1 to 0, `shake` -1 to 1, `closure` 0 to 1.
 */
function useFaceMotion(plan: FaceMotionPlan, restGaze: { gx: number; gy: number }) {
  const [values] = useState(() => ({
    glance: new Animated.ValueXY({ x: 0, y: 0 }),
    closure: new Animated.Value(0),
    clock: new Animated.Value(0),
    tremor: new Animated.Value(0),
  }));
  const phase = useRef(Math.random() * 6).current;
  const rest = useRef(restGaze);
  rest.current = restGaze;
  const cycle = useMemo(() => (plan.play ? playCycle(plan.play, phase) : null), [plan.play, phase]);

  useEffect(() => {
    if (!cycle) return;
    // Held stretches are plain delays: the native driver only writes the layers while they move.
    const steps = playSpans(cycle).map((span) =>
      span.moves
        ? Animated.timing(values.clock, {
            toValue: span.to,
            duration: span.ms,
            easing: Easing.linear,
            ...native,
          })
        : Animated.delay(span.ms),
    );
    const restart = Animated.timing(values.clock, { toValue: 0, duration: 0, ...native });
    const loop = Animated.loop(Animated.sequence([restart, ...steps]));
    loop.start();
    return () => loop.stop();
  }, [cycle, values]);

  const trembles = plan.tremor > 0;
  useEffect(() => {
    if (!trembles) return;
    const loop = loopOf(values.tremor, TREMOR_MS);
    loop.start();
    return () => loop.stop();
  }, [trembles, values]);

  useEffect(() => {
    const blink = plan.blink;
    if (!blink) return;
    let timer: ReturnType<typeof setTimeout>;
    let running: Animated.CompositeAnimation | null = null;
    const after = (delay: number) => {
      timer = setTimeout(() => {
        running = Animated.sequence([
          Animated.timing(values.closure, {
            toValue: 1,
            duration: blink.close,
            easing: Easing.linear,
            ...native,
          }),
          Animated.timing(values.closure, {
            toValue: 0,
            duration: blink.open,
            easing: Easing.linear,
            ...native,
          }),
        ]);
        running.start();
        after(blink.every + Math.random() * FACE_BLINK_JITTER_MS);
      }, delay);
    };
    after(800 + Math.random() * 2500);
    return () => {
      clearTimeout(timer);
      running?.stop();
      values.closure.setValue(0);
    };
  }, [plan.blink, values]);

  useEffect(() => {
    if (!plan.glance) return;
    let timer: ReturnType<typeof setTimeout>;
    let running: Animated.CompositeAnimation | null = null;
    const move = (to: { x: number; y: number }) =>
      Animated.timing(values.glance, {
        toValue: to,
        duration: GLANCE_MOVE_MS,
        easing: EXPRESSION_EASING,
        ...native,
      });
    const after = (delay: number) => {
      timer = setTimeout(() => {
        const to = {
          x: (Math.random() - 0.5) * 0.9 - rest.current.gx,
          y: (Math.random() - 0.6) * 0.5 - rest.current.gy,
        };
        running = Animated.sequence([
          move(to),
          Animated.delay(FACE_GLANCE.duration - 2 * GLANCE_MOVE_MS),
          move({ x: 0, y: 0 }),
        ]);
        running.start();
        after(FACE_GLANCE.every + Math.random() * FACE_GLANCE.jitter);
      }, delay);
    };
    after(2000 + Math.random() * 4000);
    return () => {
      clearTimeout(timer);
      running?.stop();
      values.glance.setValue({ x: 0, y: 0 });
    };
  }, [plan.glance, values]);

  return useMemo(() => {
    // A part the motion never moves stays off the clock, so the clock does not write its layer.
    const along = (output: number[] | undefined) =>
      cycle && output?.some((value) => value !== output[0])
        ? values.clock.interpolate({ inputRange: cycle.input, outputRange: output })
        : new Animated.Value(output?.[0] ?? 0);
    const wave = Array.from({ length: 17 }, (_, i) => i / 16);
    return {
      gx: Animated.add(values.glance.x, along(cycle?.gx)),
      gy: Animated.add(values.glance.y, along(cycle?.gy)),
      tic: along(cycle?.tic),
      shake: values.tremor.interpolate({
        inputRange: wave,
        outputRange: wave.map((u) => Math.sin(2 * Math.PI * u + phase)),
      }),
      closure: values.closure,
    };
  }, [cycle, phase, values]);
}

function degrees(rise: number, halfWidth: number) {
  return (Math.atan(rise / Math.max(1, halfWidth)) * 180) / Math.PI;
}

/**
 * The character's faceless body with its face drawn live on top, framed like the still image.
 * Paths are drawn again only when the expression changes; the gaze, blinks and mouth motions are
 * native transforms of the pupil, lid and mouth layers, clipped by round views. The face shows
 * once the body has loaded (`onReady`). Decorative: the avatar carries the name.
 */
export function ClayFace({
  face,
  body,
  crop,
  size,
  state,
  onReady,
}: {
  face: CharacterFace;
  body: ImageSourcePropType;
  crop: AvatarCrop;
  size: number;
  state: FaceState;
  onReady: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const reduced = useReduceMotion();
  const target = useMemo(
    () => poseOf(face, { expression: state.expression, gaze: state.gaze }),
    [face, state.expression, state.gaze],
  );
  const pose = useFacePose(face, target, reduced);
  const plan = useMemo(
    () =>
      motionPlan({ expression: state.expression, gaze: state.gaze, motion: state.motion }, reduced),
    [state.expression, state.gaze, state.motion, reduced],
  );
  const motion = useFaceMotion(plan, target.eyes[0]!);
  const frame: Frame = { crop, k: size / crop.side };
  const { k } = frame;
  const offsets = gazeOffsets(face);
  const W = 1.3 * face.yeux[0]!.r;
  const halfMouth = target.mouth.w / 2;
  const mouthTurn = useMemo(
    () =>
      Animated.add(
        Animated.multiply(motion.tic, degrees(0.07 * W, halfMouth)),
        Animated.multiply(motion.shake, degrees(plan.tremor * 0.03 * W, halfMouth)),
      ).interpolate({ inputRange: [-360, 360], outputRange: ["-360deg", "360deg"] }),
    [motion, W, halfMouth, plan.tremor],
  );
  // Built once per expression, not on each frame of its transition.
  const eyeMotion = useMemo(
    () =>
      face.yeux.map((eye, i) => {
        const reach = pupilReach(eye, target.eyes[i]!.ps) * k;
        return {
          x: Animated.multiply(motion.gx, reach),
          y: Animated.multiply(motion.gy, reach),
          lid: motion.closure.interpolate({
            inputRange: [0, 1],
            outputRange: [0, target.eyes[i]!.o * LID_TRAVEL * eye.r * k],
          }),
        };
      }),
    [face, target, motion, k],
  );
  const centre = eyesCentre(face);
  const head = pose.head;
  const turn = head.rv + head.pe * 0.7;
  const r0 = face.yeux[0]!.r;
  const mouthAt = place(frame, face.bouche.cx, face.bouche.cy + pose.mouth.dy, 0);
  const centreAt = place(frame, centre.x, centre.y, 0);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={size} height={size} viewBox={`${crop.x} ${crop.y} ${crop.side} ${crop.side}`}>
        <SvgImage
          href={body}
          width={1024}
          height={1024}
          onLoad={() => {
            setLoaded(true);
            onReady();
          }}
        />
      </Svg>
      {loaded ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              transformOrigin: [centreAt.left, centreAt.top, 0],
              transform: [
                { translateX: head.dx * r0 * k },
                { translateY: head.dy * r0 * k },
                { rotate: `${turn}deg` },
                { scaleY: head.sy },
              ],
            },
          ]}
        >
          <Under face={face} pose={pose} frame={frame} />
          {face.yeux.map((eye, i) => {
            const { cx, cy, r } = eye;
            const eyePose = pose.eyes[i]!;
            const round = FACES.constantes.debord_paupiere * r;
            const room = PUPIL_ROOM * r * k;
            const closed = 1 - eyeVeil(r, eyePose.o, eyePose.ob);
            return (
              <View key={eye.cote} style={StyleSheet.absoluteFill}>
                <View
                  style={[
                    styles.clip,
                    place(frame, cx - r, cy - r, 2 * r),
                    { borderRadius: r * k },
                  ]}
                >
                  <Animated.View
                    style={{
                      position: "absolute",
                      left: -room,
                      top: -room,
                      transform: [{ translateX: eyeMotion[i]!.x }, { translateY: eyeMotion[i]!.y }],
                    }}
                  >
                    <Pupil eye={eye} pose={eyePose} offset={offsets[i]!} face={face} k={k} />
                  </Animated.View>
                  <View style={StyleSheet.absoluteFill}>
                    <LowerLid eye={eye} pose={eyePose} face={face} k={k} />
                  </View>
                </View>
                <View
                  style={[
                    styles.clip,
                    place(frame, cx - round, cy + 0.05 * r - round, 2 * round),
                    { borderRadius: round * k },
                  ]}
                >
                  <Animated.View
                    style={{
                      position: "absolute",
                      left: 0,
                      top: -LID_TRAVEL * r * k,
                      transform: [{ translateY: eyeMotion[i]!.lid }],
                    }}
                  >
                    <UpperLid eye={eye} pose={eyePose} face={face} k={k} />
                  </Animated.View>
                  {closed > 0.001 ? (
                    <View style={StyleSheet.absoluteFill}>
                      <ClosedLid eye={eye} opacity={closed} k={k} />
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              {
                transformOrigin: [mouthAt.left, mouthAt.top, 0],
                transform: [{ rotate: mouthTurn }],
              },
            ]}
          >
            <Mouth face={face} pose={pose} frame={frame} />
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: "absolute", overflow: "hidden" },
});
