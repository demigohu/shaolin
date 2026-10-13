/**
 * In-memory staging for screening-time signals.
 * Cleared at the start of every screening cycle and when a setup is proposed.
 */

import { extractRsi } from "./tools/market.js";

let staged = {};

export function stageSignals(partial) {
  if (!partial || typeof partial !== "object") return;
  staged = { ...staged, ...partial };
}

export function clearStagedSignals() {
  staged = {};
}

export function getAndClearStagedSignals() {
  const snapshot = { ...staged };
  staged = {};
  return snapshot;
}

const CONFIDENCE_MAP = { "very high": 4, high: 3, medium: 2, low: 1 };

function mapConfidence(label) {
  if (label == null) return null;
  return CONFIDENCE_MAP[String(label).trim().toLowerCase()] ?? null;
}

export function extractSignalsFromMtf(mtf) {
  if (!mtf || typeof mtf !== "object") return {};
  return {
    mtf_net_score: mtf.alignment?.net_score ?? null,
    mtf_alignment_confidence: mapConfidence(mtf.alignment?.confidence),
    mtf_divergent_count: Array.isArray(mtf.alignment?.divergent_timeframes)
      ? mtf.alignment.divergent_timeframes.length
      : null,
  };
}

export function extractSignalsFromCombined(combined) {
  if (!combined || typeof combined !== "object" || combined.error) return {};
  const tech = combined.technical || {};
  const momentum = tech.market_sentiment?.momentum;
  return {
    combined_signals_agree: combined.confluence?.signals_agree ? 1 : 0,
    news_sentiment_score: combined.sentiment?.sentiment_score ?? null,
    rsi: extractRsi(tech.rsi),
    trend_strength: momentum === "Bullish" ? 1 : momentum === "Bearish" ? -1 : 0,
  };
}
