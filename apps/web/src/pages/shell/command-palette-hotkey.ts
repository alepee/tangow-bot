export function isCommandPaletteHotkey(event: KeyboardEvent) {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === "k";
}

/** The modifier the palette's shortcuts use: ⌘ on Apple platforms, Ctrl elsewhere. */
export function commandModifierKey() {
  if (typeof navigator === "undefined") return "⌘";
  // platform is deprecated but still the most reliable Apple check in browsers.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}
