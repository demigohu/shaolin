/** Parse the screener's final answer into SETUP / WATCH / AVOID. */

const VERDICT = /\b(SETUP|WATCH|AVOID)\b/g;

/** Strip markdown/code fences so logs and the next prompt stay plain text. */
export function cleanContent(content) {
  return String(content || "").replace(/```[a-z]*\n?/gi, "").replace(/\bprint\((["'])(.*?)\1\)/g, "$2").trim();
}

/**
 * The prompt asks for the verdict on the first line. Models that open with a
 * markdown header instead state it later ("... WATCH — BMS not printed"), so
 * fall back to the LAST uppercase verdict word — words like "SETUP checklist"
 * earlier in the analysis must not count as a SETUP decision.
 */
/** Second line = the one-sentence reason the prompt asks for (what is missing / awaited). */
export function verdictReason(content, max = 220) {
  const lines = String(content || "").split("\n").map((l) => l.replace(/[*_#>`|]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  // The reason follows the verdict line — skip any preamble the model wrote before it.
  const at = lines.findIndex((l) => /^(SETUP|WATCH|AVOID)\b/.test(l));
  if (at === -1) return (lines[0] || "").slice(0, max);
  const inline = lines[at].replace(/^(SETUP|WATCH|AVOID)\b[\s:—-]*/, "");
  return (inline || lines[at + 1] || "").slice(0, max);
}

export function parseVerdict(content) {
  const text = String(content || "");
  const firstLine = text.split("\n").map((l) => l.replace(/[*_#>`\s]/g, " ").trim()).find(Boolean) || "";
  const head = firstLine.match(/^(SETUP|WATCH|AVOID)\b/);
  if (head) return head[1];
  const all = [...text.matchAll(VERDICT)];
  return all.length ? all.at(-1)[1] : "WATCH";
}
