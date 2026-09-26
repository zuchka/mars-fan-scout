import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoAccess } from "../demo-access.mjs";

test("a meeting code gates inference without exposing it through status", () => {
  const access = createDemoAccess({ code:"meet-mars-7", usagePath:"unused" });
  assert.equal(access.accessRequired, true);
  assert.equal(access.authorized(undefined), false);
  assert.equal(access.authorized("meet-mars"), false);
  assert.equal(access.authorized("meet-mars-8"), false);
  assert.equal(access.authorized("meet-mars-7"), true);
  assert.equal(access.remaining(), null);
});

test("daily tile allowance survives restarts and resets on a new UTC day", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-demo-access-"));
  try {
    let current = new Date("2026-09-26T23:59:59Z");
    const options = { code:"x", dailyLimit:2, usagePath:join(dir, "usage.json"), now:()=>current };
    const access = createDemoAccess(options);
    assert.equal(access.remaining(), 2);
    assert.equal(access.reserve(), true);
    assert.equal(createDemoAccess(options).remaining(), 1);
    assert.equal(access.reserve(), true);
    assert.equal(access.reserve(), false);
    assert.equal(createDemoAccess(options).remaining(), 0);
    current = new Date("2026-09-27T00:00:00Z");
    assert.equal(createDemoAccess(options).remaining(), 2);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
});
