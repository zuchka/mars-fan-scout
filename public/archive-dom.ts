type ArchiveElement<K extends string> =
  K extends "scene-image" ? HTMLImageElement :
  K extends "hirise-link" ? HTMLAnchorElement :
  K extends "overlay" | "direction-rose" ? SVGSVGElement :
  K extends "threshold" ? HTMLInputElement :
  K extends "run-model" | "replay-button" | "reference-tab" | "model-tab" ? HTMLButtonElement :
  HTMLElement;

export function element<K extends string>(id: K): ArchiveElement<K> {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing archive element: ${id}`);
  return found as ArchiveElement<K>;
}
