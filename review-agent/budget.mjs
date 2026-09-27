import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export class ReviewBudget {
  constructor(path, { dailyCallLimit, dailyUsdLimit, perRunUsdLimit }) {
    this.path = path;
    this.dailyCallLimit = Number(dailyCallLimit || 0);
    this.dailyUsdLimit = Number(dailyUsdLimit || 0);
    this.perRunUsdLimit = Number(perRunUsdLimit || 0);
    if (![this.dailyCallLimit, this.dailyUsdLimit, this.perRunUsdLimit].every(Number.isFinite) || this.dailyCallLimit < 0 || this.dailyUsdLimit < 0 || this.perRunUsdLimit < 0) throw new Error("Invalid review budget");
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { day: "", calls: 0, spent_usd: 0, reservations: {} };
  }
  get enabled() { return Number.isInteger(this.dailyCallLimit) && this.dailyCallLimit > 0 && this.dailyUsdLimit >= 0.02 && this.perRunUsdLimit >= 0.02; }
  persist() { const tmp = this.path + ".tmp"; writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(tmp, this.path); }
  day() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.day !== today) { this.state = { day: today, calls: 0, spent_usd: 0, reservations: {} }; this.persist(); }
  }
  reserve(id, runId, amount = 0.01) {
    this.day();
    if (!this.enabled || this.state.calls >= this.dailyCallLimit || this.state.spent_usd + amount > this.dailyUsdLimit + 1e-9) return false;
    const runHeld = Object.values(this.state.reservations).filter(item => item.run_id === runId).reduce((sum, item) => sum + item.reserved_usd, 0);
    if (runHeld + amount > this.perRunUsdLimit + 1e-9) return false;
    if (this.state.reservations[id]) return false;
    this.state.calls++;
    this.state.spent_usd += amount;
    this.state.reservations[id] = { run_id: runId, reserved_usd: amount, cost_usd: null, at: new Date().toISOString() };
    this.persist();
    return true;
  }
  reconcile(id, cost) {
    this.day();
    const item = this.state.reservations[id];
    if (!item || !Number.isFinite(cost) || cost < 0) return;
    item.cost_usd = cost;
    this.state.spent_usd += cost - item.reserved_usd;
    this.persist();
  }
  status() { this.day(); return { enabled: this.enabled, daily_calls_remaining: Math.max(0, this.dailyCallLimit - this.state.calls), daily_usd_remaining: Math.max(0, this.dailyUsdLimit - this.state.spent_usd) }; }
}
