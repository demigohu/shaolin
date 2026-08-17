/**
 * In-memory staging for screening-time signals.
 * Cleared when a setup is proposed or the screening session ends.
 */

let staged = {};

export function stageSignals(partial) {
  if (!partial || typeof partial !== "object") return;
  staged = { ...staged, ...partial };
}

export function peekStagedSignals() {
  return { ...staged };
}

export function getAndClearStagedSignals() {
  const snapshot = { ...staged };
  staged = {};
  return snapshot;
}

const CONFIDENCE_MAP = {
  "very high": 4,
  high: 3,
  medium: 2,
  low: 1,
};

function mapConfidence(label) {
  if (label == null) return null;
  const key = String(label).trim().toLowerCase();
  return CONFIDENCE_MAP[key] ?? null;
}

function readRsi(tech) {
  if (!tech || typeof tech !== "object") return null;
  const rsi = tech.indicators?.rsi ?? tech.rsi ?? tech.technical_indicators?.rsi;
  return typeof rsi === "number" && Number.isFinite(rsi) ? rsi : null;
}

function readMomentum(tech) {
  const momentum = tech?.market_sentiment?.momentum;
  if (momentum === "Bullish") return 1;
  if (momentum === "Bearish") return -1;
  return 0;
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
  if (!combined || typeof combined !== "object") return {};
  const tech = combined.technical || {};
  return {
    combined_signals_agree: combined.confluence?.signals_agree ? 1 : 0,
    news_sentiment_score: combined.sentiment?.sentiment_score ?? null,
    rsi: readRsi(tech),
    trend_strength: readMomentum(tech),
  };
}

export function buildSignalSnapshot({ mtf, combined, session, confidence, rr_ratio } = {}) {
  return {
    ...extractSignalsFromMtf(mtf),
    ...extractSignalsFromCombined(combined),
    session: session || null,
    setup_confidence: confidence ?? null,
    rr_ratio: rr_ratio ?? null,
  };
}
