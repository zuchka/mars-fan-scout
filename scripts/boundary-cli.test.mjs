import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile),
  root = resolve(import.meta.dirname, "..");
test("boundary CLI scores synthetic geometry and refuses mismatched sources or exposed final data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-boundary-cli-"));
  const core = {
      polygon: [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
      ],
    },
    envelope = {
      polygon: [
        [1, 1],
        [5, 1],
        [5, 5],
        [1, 5],
      ],
    };
  const annotation = {
    format: "mars-boundary-review-v1",
    source: {
      original_sha256: "a".repeat(64),
      width: 10,
      height: 10,
      observation: "SYNTHETIC_TEST",
    },
    split: "development",
    reviewer: "test-fixture-a",
    second_reviewer: "test-fixture-b",
    coverage_complete: true,
    instances: [{ id: "fixture-fan", class: "fan", core, envelope }],
  };
  const predicted = {
    format: "mars-native-review-v1",
    source: annotation.source,
    run: {
      status: "complete",
      region: { x: 0, y: 0, width: 10, height: 10 },
      model_id: "test/model",
      candidates: [{ id: "fixture-proposal", ...core }],
    },
    refinements: {},
  };
  try {
    const a = join(directory, "annotation.json"),
      p = join(directory, "predictions.json"),
      report = join(directory, "report.json");
    await writeFile(a, JSON.stringify(annotation));
    await writeFile(p, JSON.stringify(predicted));
    await exec(
      process.execPath,
      ["scripts/score_boundaries.mjs", a, p, report],
      { cwd: root },
    );
    const result = JSON.parse(await readFile(report));
    assert.equal(result.precision, 1);
    assert.equal(result.recall, 1);
    assert.equal(result.instances[0].iou, 1);
    assert.equal(result.aggregate.core_omission, 0);
    predicted.source = {
      ...annotation.source,
      original_sha256: "b".repeat(64),
    };
    await writeFile(p, JSON.stringify(predicted));
    await assert.rejects(
      () =>
        exec(process.execPath, ["scripts/score_boundaries.mjs", a, p, report], {
          cwd: root,
        }),
      /same source bytes/,
    );
    annotation.split = "final";
    annotation.source.observation = "ESP_082241_0950";
    await writeFile(a, JSON.stringify(annotation));
    const manifest = join(directory, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({ annotations: ["annotation.json"] }),
    );
    await assert.rejects(
      () =>
        exec(
          process.execPath,
          ["scripts/validate_boundary_benchmark.mjs", manifest],
          { cwd: root },
        ),
      /Already inspected/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
