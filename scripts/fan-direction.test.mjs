import test from "node:test";
import assert from "node:assert/strict";
import { polygonAxis, directionEstimate, circularSummary, compassPoint } from "../public/fan-direction.mjs";

test("a long mask supports opposite directions only after its source end is chosen", () => {
  const axis = polygonAxis([[0, 0], [80, 0], [80, 16], [0, 16]]);
  assert.ok(axis.usable);
  assert.equal(directionEstimate(axis, null, 90), null);
  const fromA = directionEstimate(axis, "a", 90);
  const fromB = directionEstimate(axis, "b", 90);
  assert.ok(Math.abs(fromA.towardDegrees) < .001);
  assert.ok(Math.abs(fromA.fromDegrees - 180) < .001);
  assert.ok(Math.abs(fromB.towardDegrees - 180) < .001);
});

test("a round blotch cannot be assigned a shape-derived direction", () => {
  const axis = polygonAxis([[0, 0], [20, 0], [20, 20], [0, 20]]);
  assert.equal(axis.usable, false);
  assert.equal(directionEstimate(axis, "a", 0), null);
});

test("near-north bearings average across zero, while opposing bearings stay mixed", () => {
  const nearNorth = circularSummary([350, 10]);
  assert.ok(nearNorth.meanDegrees < 1 || nearNorth.meanDegrees > 359);
  assert.equal(compassPoint(350), "N");
  assert.equal(circularSummary([0, 180]).meanDegrees, null);
});
