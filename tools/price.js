import { config } from "../config.js";

export function toBrokerPrice(oandaPrice) {
  const n = Number(oandaPrice);
  if (!Number.isFinite(n)) return null;
  const offset = Number(config.broker.priceOffset) || 0;
  const digits = config.broker.digits ?? 2;
  return Number((n + offset).toFixed(digits));
}

export function toPips(distance) {
  const pip = config.broker.pipSize || 0.1;
  if (!Number.isFinite(distance) || pip <= 0) return 0;
  return Math.round(distance / pip);
}

export function roundToPips(price) {
  const pip = config.broker.pipSize || 0.1;
  const digits = config.broker.digits ?? 2;
  if (!Number.isFinite(price)) return 0;
  return Number((Math.round(price / pip) * pip).toFixed(digits));
}

export function computeTpLevels(side, entry, sl, partialTp) {
  const risk = side === "long" ? entry - sl : sl - entry;
  if (risk <= 0) return [];

  return (partialTp || []).map((tp, i) => {
    const rr = Number(tp.atRr) || 1;
    const price = side === "long" ? entry + risk * rr : entry - risk * rr;
    return {
      level: i + 1,
      price: roundToPips(price),
      rr,
      close_pct: tp.pct,
      status: "pending",
    };
  });
}

export function computeRrRatio(side, entry, sl, tpFinal) {
  const risk = Math.abs(entry - sl);
  const reward = side === "long" ? tpFinal - entry : entry - tpFinal;
  if (risk <= 0 || reward <= 0) return 0;
  return Number((reward / risk).toFixed(2));
}

export function formatPriceDual(oandaPrice) {
  const broker = toBrokerPrice(oandaPrice);
  const offset = Number(config.broker.priceOffset) || 0;
  if (Math.abs(offset) < 1e-9) return String(oandaPrice);
  return `${oandaPrice} (OANDA) → ~${broker} (${config.broker.name})`;
}
