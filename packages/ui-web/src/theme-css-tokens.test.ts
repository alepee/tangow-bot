import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type MaterialKey, materials, type TypographyKey, typography } from "@tangow/ui-tokens";
import { describe, expect, it } from "vitest";
import { MAPPED_RADIUS_KEYS, MAPPED_SIZE_KEYS } from "./lib/utils.js";

/** `rowName` -> `row-name` (mirrors the generator's `kebabCase` in `@tangow/ui-tokens`). */
function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

describe("ui-web theme CSS matches the ui-tokens source", () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

  it("maps every typography key to its --text-* theme variables", () => {
    for (const key of Object.keys(typography) as TypographyKey[]) {
      const name = kebabCase(key);
      const type = `type-${name}`;
      expect(css, `--text-${name}`).toContain(`--text-${name}: var(--${type}-size);`);
      expect(css, `--text-${name}--line-height`).toContain(
        `--text-${name}--line-height: var(--${type}-leading);`,
      );
      expect(css, `--text-${name}--letter-spacing`).toContain(
        `--text-${name}--letter-spacing: var(--${type}-tracking);`,
      );
      expect(css, `--text-${name}--font-weight`).toContain(
        `--text-${name}--font-weight: var(--${type}-weight);`,
      );
    }
  });

  it("maps the primitive radii to their --corner-* source variables", () => {
    for (const key of MAPPED_RADIUS_KEYS) {
      expect(css, `--radius-${key}`).toContain(`--radius-${key}: var(--corner-${key});`);
    }
  });

  it("maps the control sizes into the spacing namespace", () => {
    for (const key of MAPPED_SIZE_KEYS) {
      const name = kebabCase(key);
      expect(css, `--spacing-${name}`).toContain(`--spacing-${name}: var(--size-${name});`);
    }
  });

  it("keeps the plain primitive classes in a layer a utility can beat", () => {
    const layer = blockAfter(css, "@layer components {");
    for (const rule of [
      ".rk-press:active",
      ".rk-press-round:active",
      ".rk-bar",
      ".rk-dot",
      ".rk-halo",
      ".rk-shimmer",
    ]) {
      expect(layer, rule).toContain(rule);
    }
  });

  describe("materials", () => {
    const materialsCss = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "materials.css"),
      "utf8",
    );
    const layer = blockAfter(materialsCss, "@layer components {");
    const reduced = blockAfter(materialsCss, "@media (prefers-reduced-transparency: reduce) {");

    it("turns every material into its opaque fallback under Reduce Transparency", () => {
      const unblurred = reduced.slice(reduced.lastIndexOf("}", reduced.indexOf("backdrop-filter")));
      for (const key of Object.keys(materials) as MaterialKey[]) {
        expect(layer, key).toContain(`.rk-glass-${key} {`);
        expect(reduced, key).toContain(`background: var(--material-${key}-fallback);`);
        expect(unblurred, key).toContain(`.rk-glass-${key}`);
      }
      expect(unblurred).toContain("backdrop-filter: none;");
    });
  });

  describe("reduced motion", () => {
    const block = blockAfter(css, "@media (prefers-reduced-motion: reduce) {");

    it("stops what travels", () => {
      for (const rule of [
        ".animate-arrive",
        ".rk-bar",
        ".rk-dot",
        ".rk-halo",
        ".rk-shimmer",
        ".rk-press:active",
      ]) {
        expect(block, rule).toContain(rule);
      }
    });
  });
});

/** The body of the first brace-balanced block opened by `opener`. */
function blockAfter(css: string, opener: string): string {
  const start = css.indexOf(opener);
  expect(start, opener).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start + opener.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return css.slice(start + opener.length, i);
    }
  }
  throw new Error(`unbalanced block for ${opener}`);
}
