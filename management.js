/**
 * Deterministic setup lifecycle — pure functions over a setup + live price.
 * proposed (limit) → active → resolved (tp_*, sl_hit, time_exit, stale_no_fill, ...)
 */

import { config } from "./config.js";
import { toPips } from "./tools/price.js";
import { isLimitFilled, shouldExpireStaleByDistance, shouldInvalidatePreFill, distanceFromEntryPips } from "./tools/setup-gates.js";

const nowIso = () => new Date().toISOString();

function pipsFor(setup, exitPrice) {
  return setup.side === "long" ? toPips(exitPrice - setup.entry) : toPips(setup.entry - exitPrice);
}

/** Position-weighted P&L in pips: closed partials + remaining size exited at exitPrice. */
export function realizedPnlPips(setup, exitPrice = null) {
  let weighted = 0;
  for (const p of setup.partial_filled || []) weighted += (p.close_pct / 100) * pipsFor(setup, p.price);
  const remaining = setup.remaining_pct ?? 100;
  if (remaining > 0 && exitPrice != null) weighted += (remaining / 100) * pipsFor(setup, exitPrice);
  return Math.round(weighted * 10) / 10;
}

export function resolveInPlace(setup, outcome, { exitPrice = null, ...extra } = {}) {
  setup.status = "resolved";
  setup.outcome = outcome;
  setup.resolved_at = nowIso();
  setup.pnl_pips = setup.activated_at ? realizedPnlPips(setup, exitPrice) : 0;
  if (exitPrice != null && setup.activated_at) setup.exit_price = exitPrice;
  Object.assign(setup, extra);
  return setup;
}

/**
 * Extremes the order could have been touched at since `sinceIso`: the poll price, plus the
 * live bar's high/low when that bar opened after `sinceIso` (an older bar's range may predate it).
 */
function touchRange(price, bar, sinceIso) {
  const since = Date.parse(sinceIso || "");
  const usable = bar && Number.isFinite(since) && bar.t >= since;
  return { low: usable ? Math.min(price, bar.low) : price, high: usable ? Math.max(price, bar.high) : price };
}

/**
 * Advance one setup against the live price (and the live bar's range, so wicks between
 * polls count). Mutates and returns { setup, events, resolved }.
 * SL/TP fills are booked at the level price (stop/limit orders), not the poll price.
 * When one bar spans both SL and a TP, SL is assumed first (conservative).
 */
export function evaluateSetup(setup, price, mode, bar = null) {
  const events = [];
  const zonePips = mode.entryZonePips ?? 3;

  if (setup.status === "proposed") {
    const r = touchRange(price, bar, setup.proposed_at);
    // The wick toward the limit is the one that fills it.
    const fillPrice = setup.side === "long" ? r.low : r.high;
    if (shouldInvalidatePreFill(setup, price)) {
      resolveInPlace(setup, "invalidated_pre_fill");
      events.push(`❌ SL before fill ${setup.id} @ ${price} (limit never activated — cancel the order on MT5)`);
      return { setup, events, resolved: true };
    }
    if (setup.entry_style === "limit" && !isLimitFilled(setup, price, zonePips) && !isLimitFilled(setup, fillPrice, 0)) {
      if (shouldExpireStaleByDistance(setup, price, mode)) {
        resolveInPlace(setup, "stale_no_fill", { stale_distance_pips: distanceFromEntryPips(setup, price) });
        events.push(`⌛ STALE ${setup.id} — price ran ${distanceFromEntryPips(setup, price)}p away without fill (cancel the limit on MT5)`);
        return { setup, events, resolved: true };
      }
      return { setup, events, resolved: false };
    }
    setup.status = "active";
    setup.activated_at = setup.activated_at || nowIso();
    if (setup.entry_style === "limit") events.push(`✅ ENTRY ZONE ${setup.id} — limit filled @ ${price}`);
  }

  const { side, entry, sl } = setup;
  const risk = Math.abs(entry - (setup.original_sl ?? sl));
  if (risk > 0) {
    const rr = side === "long" ? (price - entry) / risk : (entry - price) / risk;
    setup.max_rr_reached = Math.round(Math.max(setup.max_rr_reached || 0, rr) * 100) / 100;
  }

  const range = touchRange(price, bar, setup.activated_at);
  const worst = side === "long" ? range.low : range.high;
  const best = side === "long" ? range.high : range.low;

  if (side === "long" ? worst <= sl : worst >= sl) {
    const outcome = setup.original_sl != null ? "tp_partial_then_be" : setup.partial_filled?.length ? "tp_partial_then_sl" : "sl_hit";
    resolveInPlace(setup, outcome, { exitPrice: sl });
    events.push(`🛑 SL HIT ${setup.id} @ ${worst === price ? price : `${sl} (bar ${side === "long" ? "low" : "high"} ${worst})`} (${setup.pnl_pips} pips)`);
    return { setup, events, resolved: true };
  }

  const levels = setup.tp_levels || [];
  for (const tp of levels) {
    if (tp.status === "hit") continue;
    if (!(side === "long" ? best >= tp.price : best <= tp.price)) break; // ladder is ordered
    tp.status = "hit";
    tp.hit_at = nowIso();
    tp.hit_price = price;
    setup.partial_filled = [...(setup.partial_filled || []), { level: tp.level, close_pct: tp.close_pct, price: tp.price }];
    setup.remaining_pct = Math.max(0, (setup.remaining_pct ?? 100) - tp.close_pct);
    events.push(`🎯 TP${tp.level} HIT ${setup.id} @ ${price} — close ${tp.close_pct}% on MT5`);

    if (setup.remaining_pct <= 0) {
      resolveInPlace(setup, levels.length > 1 ? "tp_full" : "tp_hit", { exitPrice: tp.price });
      return { setup, events, resolved: true };
    }
    if (tp.level === 1 && config.management?.breakevenAlertAfterTp1 !== false && !setup.be_alerted) {
      setup.be_alerted = true;
      // Track what the trader does on MT5: the rest of the position now risks nothing.
      if (config.management?.trackBreakeven !== false) {
        setup.original_sl = sl;
        setup.sl = entry;
        events.push(`🔒 ${setup.id}: TP1 done — move SL to breakeven ${entry} on MT5 (bot now tracks SL at ${entry})`);
      } else {
        events.push(`🔒 ${setup.id}: TP1 done — consider moving SL to breakeven ${entry} on MT5`);
      }
    }
  }

  const alertPct = config.screening?.nearTpSlAlertPct ?? 80;
  for (const tp of levels) {
    if (tp.status !== "pending" || tp.near_alerted) continue;
    const total = Math.abs(tp.price - entry);
    const progressed = side === "long" ? price - entry : entry - price;
    if (total > 0 && progressed / total >= alertPct / 100) {
      tp.near_alerted = true;
      events.push(`📍 Near TP${tp.level} ${setup.id}: ${price} → ${tp.price}`);
    }
  }

  return { setup, events, resolved: false };
}

/**
 * Time stop. Unfilled setups expire `maxAgeMin` after proposal; filled ones
 * `maxAgeMin` after fill, booked at the current price (needs a live price).
 */
export function evaluateExpiry(setup, maxAgeMin, price = null, now = Date.now()) {
  if (setup.status === "proposed") {
    const ageMin = (now - Date.parse(setup.proposed_at)) / 60000;
    if (ageMin <= maxAgeMin) return null;
    resolveInPlace(setup, "expired");
    return `⌛ EXPIRED ${setup.id} — not filled within ${maxAgeMin}m (cancel the limit on MT5)`;
  }
  if (setup.status === "active" && price != null) {
    const ageMin = (now - Date.parse(setup.activated_at || setup.proposed_at)) / 60000;
    if (ageMin <= maxAgeMin) return null;
    resolveInPlace(setup, "time_exit", { exitPrice: price });
    return `⏱ TIME EXIT ${setup.id} @ ${price} — open ${Math.round(ageMin)}m > ${maxAgeMin}m, close remaining on MT5 (${setup.pnl_pips} pips)`;
  }
  return null;
}
