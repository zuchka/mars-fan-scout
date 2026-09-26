import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export function createDemoAccess({ code = "", dailyLimit = 0, usagePath, now = () => new Date() }) {
  const expected = Buffer.from(code);
  let usage = null;
  if (dailyLimit > 0) {
    try {
      const saved = JSON.parse(readFileSync(usagePath, "utf8"));
      if (typeof saved.day === "string" && Number.isSafeInteger(saved.count) && saved.count >= 0) usage = saved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  function authorized(value) {
    if (!expected.length) return true;
    if (typeof value !== "string") return false;
    const supplied = Buffer.from(value);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function remaining() {
    if (!dailyLimit) return null;
    const day = now().toISOString().slice(0, 10);
    return Math.max(0, dailyLimit - (usage?.day === day ? usage.count : 0));
  }

  function reserve() {
    if (!dailyLimit) return true;
    if (remaining() === 0) return false;
    const day = now().toISOString().slice(0, 10);
    const next = { day, count: (usage?.day === day ? usage.count : 0) + 1 };
    writeFileSync(usagePath, JSON.stringify(next), { mode: 0o600 });
    usage = next;
    return true;
  }

  return { accessRequired: !!expected.length, authorized, remaining, reserve };
}
