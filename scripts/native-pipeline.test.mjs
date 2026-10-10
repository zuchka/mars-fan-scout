import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { SourceStore, sha } from "../scout/source-store.mjs";
import { ScanJobs } from "../scout/jobs.mjs";
import {
  tilesForRegion,
  mapPoints,
  maskIoU,
  mergeCandidates,
  clipRegion,
} from "../public/geometry.js";
import { estimateFringe } from "../public/fringe.js";
const root = resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function terminal(store, job) {
  for (let i = 0; i < 200; i++) {
    if (!["queued", "running"].includes(job.status)) return job;
    await sleep(10);
  }
  throw new Error("Job did not finish");
}
const square = (x, y, s) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

test("tile planner covers a non-square native region including seams and exact edges", () => {
  const region = { x: 17, y: 35, width: 2301, height: 1199 },
    tiles = tilesForRegion(region, 1);
  assert.equal(tiles.length, 6);
  for (let y = 35; y < 1234; y += 17)
    for (let x = 17; x < 2318; x += 19)
      assert.ok(
        tiles.some(
          (t) =>
            x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height,
        ),
      );
  assert.equal(Math.max(...tiles.map((t) => t.x + t.width)), 2318);
  assert.deepEqual(
    mapPoints(
      [
        [0, 0],
        [512, 256],
      ],
      { x: 17, y: 35, width: 1024, height: 512 },
      { width: 512, height: 256 },
    ),
    [
      [17, 35],
      [1041, 547],
    ],
  );
  assert.equal(
    tilesForRegion({ x: 0, y: 0, width: 2048, height: 2048 }, 2).length,
    1,
  );
  assert.equal(
    tilesForRegion({ x: 0, y: 0, width: 2048, height: 2048 }, 1).length,
    9,
  );
  assert.throws(() =>
    clipRegion(
      { x: 200, y: 0, width: 1, height: 2 },
      { width: 100, height: 100 },
    ),
  );
});
test("mask overlap suppresses duplicate tiles while retaining nearby separate fans", () => {
  const a = {
    id: "a",
    tile_id: "0",
    polygon: square(10, 10, 20),
    confidence: 0.7,
    area: 400,
    clipped: false,
  };
  const b = {
    ...a,
    id: "b",
    tile_id: "1",
    polygon: square(11, 10, 20),
    clipped: true,
  };
  const c = { ...a, id: "c", tile_id: "1", polygon: square(32, 10, 20) };
  assert.ok(maskIoU(a.polygon, b.polygon) > 0.8);
  assert.equal(maskIoU(a.polygon, c.polygon), 0);
  assert.deepEqual(
    mergeCandidates([b, a, c]).map((x) => x.id),
    ["a", "c"],
  );
  assert.deepEqual(mergeCandidates([a, b])[0].duplicate_ids, ["b"]);
});
test("source upload preserves exact bytes and native dimensions across region reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-native-source-"));
  try {
    const sources = new SourceStore(root, directory);
    await sources.init();
    const original = await sharp({
      create: { width: 1536, height: 768, channels: 3, background: "#668899" },
    })
      .png()
      .toBuffer();
    const meta = await sources.add(original, "test");
    assert.equal(meta.width, 1536);
    assert.equal(meta.height, 768);
    assert.equal(meta.original_sha256, sha(original));
    assert.deepEqual(await readFile(await sources.original(meta.id)), original);
    const region = await sources.region(
      meta.id,
      { x: 512, y: 256, width: 600, height: 400 },
      1024,
    );
    assert.deepEqual(region.output, { width: 600, height: 400 });
    const matched = await sources.region(
      meta.id,
      { x: 512, y: 256, width: 601, height: 401 },
      1024,
      { analysisScale: 2 },
    );
    assert.deepEqual(matched.output, { width: 301, height: 201 });
    const matchedInfo = await sharp(matched.bytes).metadata();
    assert.deepEqual([matchedInfo.width, matchedInfo.height], [301, 201]);
    assert.equal((await sharp(region.bytes).metadata()).width, 600);
    assert.deepEqual(await readFile(await sources.original(meta.id)), original);
    assert.throws(() => tilesForRegion({ width: 100, height: 100 }, 0.5));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("native prepared sample retains 16-bit values and aligns with old sample", async () => {
  const native = await sharp(
    join(root, "assets/scout-native-16.png"),
  ).metadata();
  assert.equal(native.depth, "ushort");
  assert.equal(native.width, 2048);
  const newer = await sharp(join(root, "public/sources/sample-native.png"))
    .resize(1024, 1024)
    .greyscale()
    .raw()
    .toBuffer();
  const old = await sharp(join(root, "public/images/scout-2024-dev.jpg"))
    .greyscale()
    .raw()
    .toBuffer();
  let error = 0;
  for (let i = 0; i < old.length; i++) error += Math.abs(old[i] - newer[i]);
  assert.ok(
    error / old.length < 4,
    `Image registration or normalization changed: MAE ${error / old.length}`,
  );
});
test("scan IDs are idempotent and retries dispatch only unfinished tiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-jobs-"));
  let calls = 0,
    reservations = 0;
  let fail = true;
  try {
    const sources = {
      meta: async () => ({
        id: "source",
        width: 1500,
        height: 700,
        original_sha256: "abc",
      }),
      region: async (id, t) => ({
        bytes: Buffer.from("test"),
        region: t,
        output: { width: t.width, height: t.height },
        encoding: "png",
        sha256: "a",
      }),
    };
    const store = new ScanJobs({
      directory,
      sources,
      access: {
        remaining: () => 100 - reservations,
        reserve: () => {
          reservations++;
          return true;
        },
      },
      modelId: "test",
      concurrency: 2,
      infer: async () => {
        calls++;
        if (calls === 2 && fail)
          return { status: 502, body: { error: "offline" } };
        return { status: 200, body: { predictions: [] } };
      },
    });
    await store.init();
    const request = {
      id: crypto.randomUUID(),
      source_id: "source",
      region: { x: 0, y: 0, width: 1500, height: 700 },
      scale: 1,
    };
    const job = await store.create(request);
    const duplicate = await store.create(request);
    assert.equal(duplicate, job);
    await terminal(store, job);
    assert.equal(job.status, "partial");
    assert.equal(calls, 2);
    assert.equal(reservations, 2);
    fail = false;
    const retry = await store.create({
      ...request,
      id: crypto.randomUUID(),
      retry_of: job.id,
    });
    await terminal(store, retry);
    assert.equal(calls, 3);
    assert.equal(retry.status, "complete");
    assert.equal(store.public(retry).completed, 2);
    await assert.rejects(
      () => store.create({ ...request, scale: 2 }),
      /different inputs/,
    );
  } finally {
    await sleep(30);
    await rm(directory, { recursive: true, force: true });
  }
});
test("cancel stops queued dispatch and restart leaves unknown outcomes explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-cancel-"));
  let release;
  let calls = 0;
  const options = {
    directory,
    sources: {
      meta: async () => ({
        id: "source",
        width: 2500,
        height: 700,
        original_sha256: "abc",
      }),
      region: async (id, t) => ({
        bytes: Buffer.from("test"),
        region: t,
        output: { width: t.width, height: t.height },
      }),
    },
    access: { remaining: () => 20, reserve: () => true },
    modelId: "test",
    concurrency: 1,
    infer: async () => {
      calls++;
      await new Promise((r) => (release = r));
      return { status: 200, body: { predictions: [] } };
    },
  };
  try {
    const store = new ScanJobs(options);
    await store.init();
    const job = await store.create({
      id: crypto.randomUUID(),
      source_id: "source",
      region: { x: 0, y: 0, width: 2500, height: 700 },
      scale: 1,
    });
    while (!release) await sleep(5);
    await store.cancel(job.id);
    release();
    await sleep(50);
    assert.equal(calls, 1);
    assert.equal(job.status, "cancelled");
    assert.equal(job.tiles[0].status, "complete");
    const interrupted = {
      ...job,
      id: crypto.randomUUID(),
      status: "running",
      tiles: [
        { id: "0", status: "running", dispatched_at: new Date().toISOString() },
      ],
    };
    await writeFile(
      join(directory, interrupted.id + ".json"),
      JSON.stringify(interrupted),
    );
    const restarted = new ScanJobs(options);
    await restarted.init();
    assert.equal(restarted.jobs.get(interrupted.id).status, "interrupted");
    assert.equal(restarted.jobs.get(interrupted.id).tiles[0].status, "unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("fringe remains connected to seeds and does not select an isolated dark distractor", () => {
  const width = 96,
    height = 64,
    gray = new Uint8Array(width * height).fill(190);
  for (let y = 8; y < 56; y++)
    for (let x = 10; x < 48; x++)
      gray[y * width + x] = 80 + Math.round((x - 10) * 2);
  for (let y = 15; y < 40; y++)
    for (let x = 72; x < 90; x++) gray[y * width + x] = 30;
  const result = estimateFringe({
    gray,
    width,
    height,
    polygon: square(14, 20, 16),
    sensitivity: 0.45,
  });
  assert.ok(result.alpha[30 * width + 20] > 0);
  assert.equal(result.alpha[30 * width + 80], 0);
  assert.match(result.meaning, /not probability/);
  const blocked = estimateFringe({
    gray,
    width,
    height,
    polygon: square(14, 20, 16),
    sensitivity: 0.45,
    points: [{ x: 20, y: 30, label: "exclude" }],
  });
  assert.equal(blocked.alpha[30 * width + 20], 0);
});

test("COCO raster masks preserve holes, disconnected components and compressed signed deltas", async () => {
  const { decodeRLE, encodeRLE, maskRGBA } = await import("../public/masks.js");
  const mask = new Uint8Array(8 * 6);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) mask[y * 8 + x] = 1;
  mask[2 * 8 + 2] = 0;
  mask[4 * 8 + 7] = 1;
  assert.deepEqual(decodeRLE(encodeRLE(mask, 8, 6)).pixels, mask);
  // Known COCO runs [0,1,3,1,3,2,2]; the final signed delta is -1.
  const compressed = { size: [3, 4], counts: "013001O" };
  assert.deepEqual(
    [...decodeRLE(compressed).pixels],
    [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0],
  );
  const rgba = maskRGBA(encodeRLE(mask, 8, 6));
  assert.equal(rgba.rgba[(2 * 8 + 2) * 4 + 3], 0);
  assert.equal(rgba.rgba[(4 * 8 + 7) * 4 + 3], 255);
  assert.throws(() => decodeRLE({ size: [3, 4], counts: [13] }));
  assert.throws(() => decodeRLE({ size: [3, 4], counts: "o" }));
});
test("boundary metrics ignore ambiguous bands and detect core misses and leakage", async () => {
  const { boundaryMetrics, matchInstances, validateAnnotation } = await import(
    "../public/boundary-metrics.js"
  );
  const core = Uint8Array.from([0, 1, 1, 0, 0]),
    envelope = Uint8Array.from([0, 1, 1, 1, 0]),
    unknown = new Uint8Array(5);
  const perfect = boundaryMetrics(
    Uint8Array.from([0, 1, 1, 1, 0]),
    core,
    envelope,
    unknown,
    5,
    1,
  );
  assert.equal(perfect.iou, 1);
  assert.equal(perfect.core_omission, 0);
  assert.equal(perfect.background_leakage, 0);
  const wrong = boundaryMetrics(
    Uint8Array.from([0, 1, 0, 1, 1]),
    core,
    envelope,
    unknown,
    5,
    1,
  );
  assert.equal(wrong.core_omission, 0.5);
  assert.equal(wrong.background_leakage, 1 / 3);
  assert.equal(matchInstances([core, core], [core]).length, 1);
  assert.throws(
    () =>
      validateAnnotation({
        format: "mars-boundary-review-v1",
        source: {
          original_sha256: "a".repeat(64),
          width: 5,
          height: 1,
          observation: "test",
        },
        instances: [],
        coverage_complete: false,
      }),
    /coverage/,
  );
});
test("upload quota retains previous sources and EXIF rotation has a documented source frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-quota-"));
  try {
    const original = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#668899" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const store = new SourceStore(root, directory);
    await store.init();
    const meta = await store.add(original, "oriented");
    assert.deepEqual([meta.width, meta.height], [300, 400]);
    assert.deepEqual(await readFile(await store.original(meta.id)), original);
    assert.equal(meta.orientation, 6);
    const limited = new SourceStore(root, directory, { maxSourceBytes: 1 });
    const bytes = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "#111111" },
    })
      .png()
      .toBuffer();
    await assert.rejects(() => limited.add(bytes, "new"), /storage is full/);
    assert.deepEqual(await readFile(await store.original(meta.id)), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent jobs never exceed the provider allowance and corrupted jobs are quarantined", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-accounting-"));
  let calls = 0,
    budget = 1;
  const options = {
    directory,
    sources: {
      meta: async () => ({
        id: "source",
        width: 256,
        height: 256,
        original_sha256: "abc",
      }),
      region: async (id, t) => ({
        bytes: Buffer.from("test"),
        region: t,
        output: { width: 256, height: 256 },
      }),
    },
    access: {
      remaining: () => budget,
      reserve: () => {
        if (!budget) return false;
        budget--;
        return true;
      },
    },
    modelId: "test",
    concurrency: 2,
    infer: async () => {
      calls++;
      return { status: 200, body: { predictions: [] } };
    },
  };
  try {
    const store = new ScanJobs(options);
    await store.init();
    const config = {
      source_id: "source",
      region: { x: 0, y: 0, width: 256, height: 256 },
    };
    const jobs = await Promise.allSettled([
      store.create({ ...config, id: crypto.randomUUID() }),
      store.create({ ...config, id: crypto.randomUUID() }),
    ]);
    for (const j of jobs)
      if (j.status === "fulfilled") await terminal(store, j.value);
    assert.equal(calls, 1);
    assert.equal(budget, 0);
    const id = crypto.randomUUID();
    await writeFile(join(directory, id + ".json"), "{broken");
    const restored = new ScanJobs(options);
    await restored.init();
    assert.equal(restored.jobs.has(id), false);
    assert.equal(
      await readFile(join(directory, id + ".json.invalid"), "utf8"),
      "{broken",
    );
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await rm(directory, { recursive: true, force: true });
  }
});

test("boundary matching maximizes one-to-one matches and reports exact visible boundaries", async () => {
  const { boundaryMetrics, matchInstances } = await import(
    "../public/boundary-metrics.js"
  );
  const left = Uint8Array.from([1, 1, 0, 0]),
    right = Uint8Array.from([0, 0, 1, 1]),
    both = Uint8Array.from([1, 1, 1, 1]);
  assert.equal(matchInstances([both, left], [left, right], 0.25).length, 2);
  const known = new Uint8Array(4),
    exact = boundaryMetrics(left, left, left, known, 4, 1, left, 1);
  assert.equal(exact.boundary_f1, 1);
  assert.equal(exact.dice, 1);
  const negative = boundaryMetrics(left, known, known, known, 4, 1);
  assert.equal(negative.core_omission, null);
  assert.equal(negative.background_leakage, 1);
});
