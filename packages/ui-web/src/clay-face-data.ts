import expressionsFile from "@tangow/avatars/face/expressions.json";
import faceFile from "@tangow/avatars/face/visages.json";
import type { CharacterFace, ExpressionsFile, FaceFile } from "@tangow/contracts";
import { characterById } from "@tangow/contracts";

export const FACES: FaceFile = faceFile;
export const EXPRESSIONS: ExpressionsFile = expressionsFile;

/** The face of a catalogue character; missing or unknown is the neutral character's. */
export function faceFor(character: string | null | undefined): CharacterFace {
  const { id } = characterById(character);
  return FACES.persos.find((face) => face.id === id) ?? FACES.persos[0]!;
}
