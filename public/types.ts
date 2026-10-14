export type Point = [number, number];
export type Size = { width: number; height: number };
export type Region = Size & { x: number; y: number };

export type Proposal = {
  id: string;
  tile_id: string;
  polygon: Point[];
  confidence: number;
  area: number;
  clipped?: boolean;
  duplicate_ids?: string[];
};

export type RLE = { size: [number, number]; counts: number[] | string };

export type ReviewDecision = "accepted" | "rejected" | "unsure";
export type ReviewRecord = {
  decision: ReviewDecision;
  at: string;
  candidate_id: string;
  source_sha256: string;
};
export type ReviewMap = Record<string, ReviewRecord>;
