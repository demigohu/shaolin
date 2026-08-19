import { getCurrentSession } from "./modes.js";
import { config } from "./config.js";
import { toPips } from "./tools/price.js";
import { formatPriceDual } from "./tools/price.js";

const lastTelegramAt = new Map();
const DEFAULT_COOLDOWN_MIN = 60;

function cooldownMin(key) {
  const n = config.notifications?.cooldownMin?.[key];
  return Number.isFinite(n) ? n : DEFAULT_COOLDOWN_MIN;
}

export function shouldNotifyTelegram(key, cooldownMinutes = null) {
  if (config.notifications?.enabled === false) return false;
  const cd = cooldownMinutes ?? cooldownMin(key);
  const last = lastTelegramAt.get(key) || 0;
  if (Date.now() - last < cd * 60_000) return false;
  lastTelegramAt.set(key, Date.now());
  return true;
}

export function resetNotifyCooldown(key) {
  lastTelegramAt.delete(key);
}

export function formatSessionSkip(mode) {
  const session = getCurrentSession();
  const allowed = (mode.sessions || []).join(", ");
  return [
    "⏸ SHAOLIN — Screening skipped",
    `Mode: ${mode.id} | Session now: ${session}`,
    `Allowed: ${allowed}`,
    "Management tetap jalan untuk open setups.",
    "Tip: set sessions to [\"any\"] in user-config untuk 24h gold.",
  ].join("\n");
}

export function formatOpenSetupSkip(open, mode) {
  return [
    "👀 SHAOLIN — Setup open (no new screening)",
    `Monitoring ${open.length} setup(s) every ${mode.managementIntervalMin}m`,
    "",
    open.map(formatSetupLine).join("\n\n"),
  ].join("\n");
}

function formatSetupLine(setup) {
  const tps = (setup.tp_levels || [])
    .map((t) => `TP${t.level} ${t.price} [${t.status}]`)
    .join(" | ");
  return [
    `${setup.side.toUpperCase()} ${setup.id}`,
    `Entry ${setup.entry} | SL ${setup.sl} (${setup.sl_pips}p)`,
    tps || `TP ${setup.tp}`,
  ].join("\n");
}

export function formatManagementDigest(open, price, events = []) {
  const lines = [
    "📊 SHAOLIN — Management",
    `Price: ${formatPriceDual(price)} | ${new Date().toISOString().slice(11, 16)} UTC`,
    "",
  ];

  if (events.length) {
    lines.push("🔔 Events:", ...events.map((e) => `• ${e}`), "");
  }

  for (const setup of open) {
    lines.push(formatSetupStatus(setup, price));
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function formatSetupStatus(setup, price) {
  const side = setup.side;
  const entry = setup.entry;
  const sl = setup.sl;
  const pip = config.broker.pipSize || 0.1;
  const risk = Math.abs(entry - sl) || pip;
  const rr = side === "long" ? (price - entry) / risk : (entry - price) / risk;
  const distEntryPips = toPips(Math.abs(price - entry));
  const distSlPips = toPips(Math.abs(price - sl));

  const tpLines = (setup.tp_levels || []).map((tp) => {
    const dist = toPips(Math.abs(tp.price - price));
    const icon = tp.status === "hit" ? "✅" : "⏳";
    return `  ${icon} TP${tp.level} ${tp.price} (${dist}p away)`;
  });

  return [
    `${setup.side.toUpperCase()} \`${setup.id}\``,
    `  Entry ${entry} (${distEntryPips}p ${price >= entry ? "above" : "below"})`,
    `  SL ${sl} (${distSlPips}p away) | RR now ${rr.toFixed(2)}`,
    ...tpLines,
  ].join("\n");
}

export function formatSetupAlert(setup) {
  const tps = (setup.tp_levels || [])
    .map((t) => `  TP${t.level}: ${formatPriceDual(t.price)} — close ${t.close_pct}%`)
    .join("\n");
  return [
    "🥋 SHAOLIN SETUP",
    "━━━━━━━━━━━━━━━",
    `${setup.symbol} ${setup.side.toUpperCase()} | ${setup.mode}`,
    setup.setup_type ? `Type: ${setup.setup_type}` : null,
    setup.confluence_factors?.length ? `Confluence: ${setup.confluence_factors.join(", ")}` : null,
    "",
    `Entry  ${formatPriceDual(setup.entry)}`,
    `SL     ${formatPriceDual(setup.sl)} (${setup.sl_pips} pips)`,
    tps || `TP     ${formatPriceDual(setup.tp)}`,
    "",
    `RR ${setup.rr_ratio} | Conf ${setup.confidence}%`,
    "",
    setup.reason?.slice(0, 280) || "",
    setup.risks?.length ? `\n⚠️ ${setup.risks.slice(0, 3).join(" · ")}` : "",
    "",
    `→ Entry manual MT5 (${config.broker.name})`,
    `ID: ${setup.id}`,
  ].filter(Boolean).join("\n");
}

export function formatEventAlert(events) {
  return ["🔔 SHAOLIN ALERT", "━━━━━━━━━━━━━━━", ...events.map((e) => `• ${e}`)].join("\n");
}

export function formatScreeningDigest({ action, summary, smc, openCount = 0 }) {
  const lines = [
    "🔍 SHAOLIN — Screening",
    `Action: ${action || "WATCH"} | ${new Date().toISOString().slice(11, 16)} UTC`,
  ];
  if (smc) {
    lines.push(`WIB ${smc.wib} | ${smc.amd_phase} | price ${smc.price ?? "?"}`);
    if (smc.liquidity_events?.length) lines.push(`Liquidity: ${smc.liquidity_events.join(", ")}`);
    if (smc.suggested_setups?.length) lines.push(`Plays: ${smc.suggested_setups.join(", ")}`);
    if (smc.fib?.in_ote_zone) lines.push("Fib: price IN OTE zone (0.618–0.72)");
    if (smc.structure?.bms_hint) lines.push(`Structure: ${smc.structure.bms_hint}`);
  }
  if (openCount > 0) lines.push(`Open setups: ${openCount} — screening skipped for new entries`);
  if (summary) lines.push("", summary.slice(0, 600));
  return lines.join("\n").trim();
}
