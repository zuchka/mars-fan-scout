import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

type Reservation = { run_id: string; reserved_usd: number; cost_usd: number | null; at: string };
type BudgetState = { day: string; calls: number; spent_usd: number; reservations: Record<string, Reservation> };

export class ReviewBudget {
  path: string;
  dailyCallLimit: number;
  dailyUsdLimit: number;
  perRunUsdLimit: number;
  reservationUsd: number;
  state: BudgetState;

  constructor(path: string, { dailyCallLimit, dailyUsdLimit, perRunUsdLimit, reservationUsd = 0.01 }: {
    dailyCallLimit: number; dailyUsdLimit?: number; perRunUsdLimit?: number; reservationUsd?: number;
  }) {
    this.path = path;
    this.dailyCallLimit = Number(dailyCallLimit || 0);
    this.dailyUsdLimit = Number(dailyUsdLimit || 0);
    this.perRunUsdLimit = Number(perRunUsdLimit || 0);
    this.reservationUsd = Number(reservationUsd);
    if (![this.dailyCallLimit, this.dailyUsdLimit, this.perRunUsdLimit, this.reservationUsd].every(Number.isFinite) || this.dailyCallLimit < 0 || this.dailyUsdLimit < 0 || this.perRunUsdLimit < 0 || this.reservationUsd < 0) throw new Error("Invalid review budget");
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { day: "", calls: 0, spent_usd: 0, reservations: {} };
  }
  get enabled() { return Number.isInteger(this.dailyCallLimit) && this.dailyCallLimit > 0 && (this.reservationUsd === 0 || this.dailyUsdLimit >= 2 * this.reservationUsd && this.perRunUsdLimit >= 2 * this.reservationUsd); }
  persist() { const tmp = this.path + ".tmp"; writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(tmp, this.path); }
  day() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.day !== today) { this.state = { day: today, calls: 0, spent_usd: 0, reservations: {} }; this.persist(); }
  }
  reserve(id: string, runId: string, amount = this.reservationUsd): boolean {
    this.day();
    if (!this.enabled || this.state.calls >= this.dailyCallLimit || (this.reservationUsd > 0 && this.state.spent_usd + amount > this.dailyUsdLimit + 1e-9)) return false;
    const runHeld = Object.values(this.state.reservations).filter(item => item.run_id === runId).reduce((sum, item) => sum + item.reserved_usd, 0);
    if (this.reservationUsd > 0 && runHeld + amount > this.perRunUsdLimit + 1e-9) return false;
    if (this.state.reservations[id]) return false;
    this.state.calls++;
    this.state.spent_usd += amount;
    this.state.reservations[id] = { run_id: runId, reserved_usd: amount, cost_usd: null, at: new Date().toISOString() };
    this.persist();
    return true;
  }
  reconcile(id: string, cost: number | null): void {
    this.day();
    const item = this.state.reservations[id];
    if (!item || cost === null || !Number.isFinite(cost) || cost < 0) return;
    item.cost_usd = cost;
    this.state.spent_usd += cost - item.reserved_usd;
    this.persist();
  }
  status() { this.day(); return { enabled: this.enabled, daily_calls_remaining: Math.max(0, this.dailyCallLimit - this.state.calls), daily_usd_remaining: this.reservationUsd === 0 ? null : Math.max(0, this.dailyUsdLimit - this.state.spent_usd) }; }
}
