/**
 * Track record of FILLED trades, grouped by setup type / session / side /
 * confluence tag. Shown to the SCREENER and used to block setup types that
 * keep losing in the current mode.
 */

import { config } from "./config.js";
import { getPerformanceRecords } from "./lessons.js";
import { isTrade } from "./setup-memory.js";

function summarize(trades) {
  const wins = trades.filter((t) => (t.pnl_pips ?? 0) > 0).length;
  const net = trades.reduce((s, t) => s + (t.pnl_pips ?? 0), 0);
  return {
    n: trades.length,
    wins,
    win_rate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
    net_pips: Math.round(net * 10) / 10,
    avg_pips: trades.length ? Math.round((net / trades.length) * 10) / 10 : 0,
  };
}

function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    for (const key of [keyFn(t)].flat()) {
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
  }
  return Object.fromEntries([...groups].map(([k, v]) => [k, summarize(v)]));
}

/** Filled trades of `modeId` under the current strategy version, resolved within the gate window. */
export function recentTrades(modeId, records = getPerformanceRecords(), now = Date.now()) {
  const windowDays = config.performanceGate?.windowDays ?? 60;
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  return records.filter((r) => isTrade(r)
    && r.mode === modeId
    && r.strategy_version === config.strategyVersion
    && Date.parse(r.resolved_at || r.recorded_at) >= cutoff);
}

export function buildPerformanceStats(trades) {
  return {
    overall: summarize(trades),
    by_grade: groupBy(trades, (t) => t.grade),
    by_setup_type: groupBy(trades, (t) => t.setup_type),
    by_session: groupBy(trades, (t) => t.session),
    by_side: groupBy(trades, (t) => t.side),
    by_type_session: groupBy(trades, (t) => (t.setup_type && t.session ? `${t.setup_type}@${t.session}` : null)),
    by_confluence: groupBy(trades, (t) => t.confluence_factors || []),
  };
}

/**
 * Block a setup type whose recent record is clearly losing:
 * ≥ minTrades, win rate ≤ maxWinRate and net pips < 0 — first for this
 * session, then across all sessions.
 */
export function checkTrackRecord({ setup_type, session, mode }, trades = recentTrades(mode)) {
  const gate = config.performanceGate || {};
  if (gate.enabled === false || !setup_type) return { ok: true };
  const minTrades = gate.minTrades ?? 5;
  const maxWinRate = gate.maxWinRate ?? 30;
  const stats = buildPerformanceStats(trades);

  for (const [label, s] of [
    [`${setup_type} during ${session}`, stats.by_type_session[`${setup_type}@${session}`]],
    [setup_type, stats.by_setup_type[setup_type]],
  ]) {
    if (s && s.n >= minTrades && s.win_rate <= maxWinRate && s.net_pips < 0) {
      return {
        ok: false,
        reason: "poor_track_record",
        message: `${label}: ${s.win_rate}% win over ${s.n} trades, net ${s.net_pips}p in the last ${gate.windowDays ?? 60}d — blocked. Pick another setup type or WATCH.`,
      };
    }
  }
  return { ok: true };
}

function formatGroup(title, group, minN) {
  const rows = Object.entries(group)
    .filter(([, s]) => s.n >= minN)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 8)
    .map(([k, s]) => `  ${k}: ${s.n} trades, ${s.win_rate}% win, avg ${s.avg_pips}p, net ${s.net_pips}p`);
  return rows.length ? [`${title}:`, ...rows] : [];
}

export function formatPerformanceStats(modeId) {
  const trades = recentTrades(modeId);
  const days = config.performanceGate?.windowDays ?? 60;
  if (!trades.length) return `Track record (${modeId}, ${config.strategyVersion}, ${days}d): no filled trades yet.`;
  const s = buildPerformanceStats(trades);
  const o = s.overall;
  return [
    `Track record (${modeId}, ${config.strategyVersion}, last ${days}d): ${o.n} trades, ${o.win_rate}% win, avg ${o.avg_pips}p, net ${o.net_pips}p`,
    ...formatGroup("By grade (A = plan POI, B = off-plan)", s.by_grade, 1),
    ...formatGroup("By setup type", s.by_setup_type, 1),
    ...formatGroup("By session", s.by_session, 2),
    ...formatGroup("By side", s.by_side, 2),
    ...formatGroup("By confluence tag", s.by_confluence, 3),
  ].join("\n");
}
