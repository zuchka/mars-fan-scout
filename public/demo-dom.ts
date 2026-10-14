type Inputs = "access-code" | "rf-layer" | "sam-layer" | "fill-opacity" | "view-contrast" |
  "image-input" | "review-input" | "fringe-sensitivity";
type Selects = "scan-area" | "scan-scale" | "context-size" | "edit-mode";
type Buttons = "fit-view" | "zoom-out" | "zoom-in" | "native-view" | "hide-overlays" |
  "sample-button" | "orbit-button" | "download-source" | "scan-button" | "cancel-scan" |
  "retry-scan" | "inspect-native" | "refine-button" | "next-unreviewed" |
  "clear-review" | "fringe-button" | "fringe-clear" | "undo-edit" | "reset-edits" |
  "export-review";

type DemoElement<K extends string> = K extends Inputs ? HTMLInputElement :
  K extends Selects ? HTMLSelectElement : K extends Buttons ? HTMLButtonElement :
  K extends "mars-image" | "source-evidence" ? HTMLCanvasElement :
  K extends "candidate-overlay" ? SVGSVGElement :
  K extends "other-regions" ? HTMLDetailsElement :
  K extends "scan-progress" ? HTMLProgressElement :
  K extends "access-form" ? HTMLFormElement : HTMLElement;

export function element<K extends string>(id: K): DemoElement<K> {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as DemoElement<K>;
}
