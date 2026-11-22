import pave800 from "@tangow/avatars/onboarding/pave-800.webp";
import pave1600 from "@tangow/avatars/onboarding/pave-1600.webp";
import plateau01800 from "@tangow/avatars/onboarding/plateau/p01-800.webp";
import plateau011600 from "@tangow/avatars/onboarding/plateau/p01-1600.webp";
import plateau04800 from "@tangow/avatars/onboarding/plateau/p04-800.webp";
import plateau041600 from "@tangow/avatars/onboarding/plateau/p04-1600.webp";

function scene(small: string, large: string) {
  return (
    <img
      src={small}
      srcSet={`${small} 800w, ${large} 1600w`}
      sizes="(max-width: 860px) calc(100vw - 32px), 55vw"
      alt=""
    />
  );
}

export const paveScene = scene(pave800, pave1600);
export const welcomeScene = scene(plateau01800, plateau011600);
export const signupScene = scene(plateau04800, plateau041600);
