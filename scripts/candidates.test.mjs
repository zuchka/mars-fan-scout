import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { predictionsFromRoboflow, showcaseCandidates } from "../public/candidates.js";

test("sample demo selects substantial regions and preserves the full proposal set", async () => {
  const frozen = JSON.parse(await readFile(new URL("../evaluation/demo-repair/sample-roboflow.json", import.meta.url)));
  const image = { width: 1024, height: 1024 };
  const proposals = predictionsFromRoboflow(frozen.response, image);
  const selected = showcaseCandidates(proposals, image);
  assert.equal(proposals.length, 22);
  assert.equal(selected.length, 3);
  assert.deepEqual(selected.map(item => item.sourceIndex), [0, 11, 8]);
  assert.ok(selected.every(item => item.area > 1000));
  assert.ok(proposals.some(item => item.area < 10));
  assert.ok(selected.every(item => proposals.includes(item)));
});

test("tiny marks never displace a plausible lower-confidence region", () => {
  const image = { width: 1024, height: 1024 };
  const response = { image, predictions: [
    { confidence: .99, points: [[0, 0], [3, 0], [3, 3], [0, 3]] },
    { confidence: .35, points: [[100, 100], [135, 100], [135, 140], [100, 140]] },
  ] };
  const proposals = predictionsFromRoboflow(response, image);
  assert.equal(proposals.length, 2);
  assert.deepEqual(showcaseCandidates(proposals, image).map(item => item.sourceIndex), [1]);
});

test("a sparse crop shows two substantial candidates instead of filling a third slot with a speck", async () => {
  const response = JSON.parse(await readFile(new URL("../evaluation/locked/predictions/locked-04.json", import.meta.url)));
  const image = { width: 1024, height: 1024 };
  const proposals = predictionsFromRoboflow(response, image);
  assert.deepEqual(showcaseCandidates(proposals, image).map(item => item.sourceIndex), [0, 1]);
  assert.ok(proposals.some(item => item.area < 200));
});

test("box detector predictions become inspectable region polygons", () => {
  const items = predictionsFromRoboflow({ image: { width: 1024, height: 1024 }, predictions: [
    { x: 500, y: 400, width: 80, height: 120, confidence: .7 },
  ] }, { width: 1024, height: 1024 });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].bounds, { left: 460, top: 340, right: 540, bottom: 460 });
  assert.equal(items[0].area, 9600);
});
