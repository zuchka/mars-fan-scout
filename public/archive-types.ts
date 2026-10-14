import type { Point } from "./types.js";

export type Mark = {
  id: string; base: Point | null; vector: Point | null; polygon?: Point[];
  bearing: number | null; votes?: number; confidence?: number;
  catalogMatch?: string | null; tile_id?: string;
};
export type Scene = {
  id: string; image: string; title: string; subtitle: string; role: string;
  obsid: string; location: Point; basis_bearings: Point; source_url: string;
  markings: Mark[];
};
export type ArchiveState = {
  scenes: Scene[]; sceneIndex: number; stage: "raw" | "fans" | "wind";
  source: "reference" | "model"; modelReady: boolean; modelTraining: boolean;
  modelRecorded: boolean; modelVerified: boolean; modelResults: Record<string, Mark[]>;
  threshold: number; selected: Mark | null; replayTimers: Array<ReturnType<typeof setTimeout>>;
};
