/**
 * Setup chart: recent entry-TF candles with the entry, SL, TPs and the plan POI zone,
 * rendered as SVG and rasterised to PNG for Telegram. Pure — candles in, Buffer out.
 */

import { Resvg } from "@resvg/resvg-js";

const W = 1000;
const H = 560;
const PAD = { top: 44, right: 96, bottom: 28, left: 12 };
const C = {
  bg: "#131722",
  grid: "#232838",
  text: "#c9ced8",
  dim: "#7a8194",
  up: "#26a69a",
  down: "#ef5350",
  entry: "#e8e8e8",
  sl: "#ef5350",
  tp: "#26a69a",
  zoneLong: "rgba(38,166,154,0.14)",
  zoneShort: "rgba(239,83,80,0.14)",
};
const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wibClock = (ms) => new Date(ms + 7 * 3_600_000).toISOString().slice(11, 16);

/** Nice round step for the price axis. */
function niceStep(range, ticks = 8) {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

/**
 * @param candles [{ t, o, h, l, c }] ascending (entry TF)
 * @param setup   { side, entry, sl, tp_levels: [{ level, price }], setup_type, grade, entry_style }
 * @param zone    optional plan POI { id, zone_low, zone_high, side }
 * @returns SVG string
 */
export function setupChartSvg({ candles, setup, zone = null, title = "", tf = "5m", bars = 72 }) {
  const data = (candles || []).slice(-bars);
  const tps = (setup.tp_levels || []).map((t) => ({ label: `TP${t.level}`, price: Number(t.price) }));
  const levels = [
    { label: "SL", price: Number(setup.sl), color: C.sl },
    { label: setup.entry_style === "limit" ? "LIMIT" : "ENTRY", price: Number(setup.entry), color: C.entry, dash: true },
    ...tps.map((t) => ({ ...t, color: C.tp })),
  ].filter((l) => Number.isFinite(l.price));

  const prices = [...data.flatMap((k) => [k.h, k.l]), ...levels.map((l) => l.price)];
  if (zone) prices.push(zone.zone_low, zone.zone_high);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (p) => PAD.top + ((hi - p) / (hi - lo)) * plotH;
  // Leave room on the right of the last candle so the levels read as "ahead".
  const slots = data.length + 8;
  const slotW = plotW / slots;
  const x = (i) => PAD.left + slotW * (i + 0.5);

  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="${FONT}">`];
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  const step = niceStep(hi - lo);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    out.push(`<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="${C.grid}"/>`);
    out.push(`<text x="${W - PAD.right + 6}" y="${(y(p) + 4).toFixed(1)}" fill="${C.dim}" font-size="11">${p.toFixed(2)}</text>`);
  }
  for (let i = 0; i < data.length; i += 12) {
    out.push(`<text x="${x(i).toFixed(1)}" y="${H - 9}" fill="${C.dim}" font-size="11" text-anchor="middle">${wibClock(data[i].t)}</text>`);
  }

  if (zone) {
    const top = y(zone.zone_high);
    out.push(`<rect x="${PAD.left}" y="${top.toFixed(1)}" width="${plotW}" height="${Math.max(1, y(zone.zone_low) - top).toFixed(1)}" fill="${zone.side === "long" ? C.zoneLong : C.zoneShort}"/>`);
    out.push(`<text x="${PAD.left + 6}" y="${(top + 14).toFixed(1)}" fill="${C.dim}" font-size="11">${esc(zone.id || "POI")} ${zone.side?.toUpperCase() ?? ""}</text>`);
  }

  const bodyW = Math.max(1, slotW * 0.62);
  data.forEach((k, i) => {
    const color = k.c >= k.o ? C.up : C.down;
    const top = y(Math.max(k.o, k.c));
    out.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(k.h).toFixed(1)}" y2="${y(k.l).toFixed(1)}" stroke="${color}"/>`);
    out.push(`<rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, y(Math.min(k.o, k.c)) - top).toFixed(1)}" fill="${color}"/>`);
  });

  for (const l of levels) {
    const ly = y(l.price).toFixed(1);
    out.push(`<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${ly}" y2="${ly}" stroke="${l.color}" stroke-width="1.6"${l.dash ? ' stroke-dasharray="6 4"' : ""}/>`);
    out.push(`<rect x="${W - PAD.right}" y="${(Number(ly) - 9).toFixed(1)}" width="${PAD.right - 2}" height="18" fill="${l.color}"/>`);
    out.push(`<text x="${W - PAD.right + 4}" y="${(Number(ly) + 4).toFixed(1)}" fill="${C.bg}" font-size="11" font-weight="bold">${l.label} ${l.price.toFixed(2)}</text>`);
  }

  out.push(`<text x="${PAD.left + 4}" y="26" fill="${C.text}" font-size="16" font-weight="bold">${esc(title)}</text>`);
  out.push(`<text x="${W - PAD.right}" y="26" fill="${C.dim}" font-size="12" text-anchor="end">${esc(tf)} · WIB</text>`);
  out.push("</svg>");
  return out.join("");
}

export function renderPng(svg) {
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render().asPng();
}
