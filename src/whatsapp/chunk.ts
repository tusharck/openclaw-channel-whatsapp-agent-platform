/**
 * Text chunking for outbound WhatsApp messages.
 *
 * The Agent Platform caps a text body at 4096 characters. We chunk at a
 * configurable soft limit (default 4000) to leave headroom, preferring to split
 * on paragraph, then line, then word boundaries, and hard-splitting only when a
 * single token exceeds the limit.
 *
 * Chunk boundaries are counted in Unicode code points (via the string iterator)
 * rather than UTF-16 units, so surrogate pairs (emoji) are never split in half.
 */

/** WhatsApp's hard cap for a text message body. */
export const WHATSAPP_TEXT_HARD_LIMIT = 4096;

/** Default soft limit; leaves headroom under the 4096 hard cap. */
export const DEFAULT_CHUNK_LIMIT = 4000;

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Hard-split a string with no usable boundary into <=limit code-point pieces. */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  let buf = "";
  let count = 0;
  for (const ch of text) {
    // ch may be a multi-UTF-16 code point; treat it as one unit.
    if (count + 1 > limit) {
      out.push(buf);
      buf = "";
      count = 0;
    }
    buf += ch;
    count++;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/** Greedily pack `parts` (joined by `sep`) into chunks no longer than `limit`. */
function packParts(parts: string[], sep: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const sepLen = codePointLength(sep);

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const part of parts) {
    const partLen = codePointLength(part);
    if (partLen > limit) {
      // Part alone exceeds the limit: flush, then split it finer.
      flush();
      const finer = splitFiner(part, limit);
      // All but the last finer piece are already at/under limit.
      for (let i = 0; i < finer.length - 1; i++) chunks.push(finer[i]);
      current = finer[finer.length - 1] ?? "";
      continue;
    }
    const currentLen = codePointLength(current);
    const projected = current.length === 0 ? partLen : currentLen + sepLen + partLen;
    if (projected <= limit) {
      current = current.length === 0 ? part : current + sep + part;
    } else {
      flush();
      current = part;
    }
  }
  flush();
  return chunks;
}

/** Split a single over-limit part on progressively finer boundaries. */
function splitFiner(part: string, limit: number): string[] {
  // Try line boundaries within a paragraph.
  if (part.includes("\n")) {
    return packParts(part.split("\n"), "\n", limit);
  }
  // Then word boundaries.
  if (/\s/.test(part)) {
    return packParts(part.split(/(?<=\s)/), "", limit);
  }
  // No boundary at all: hard split.
  return hardSplit(part, limit);
}

/**
 * Split `text` into chunks no longer than `limit` code points (default 4000),
 * never exceeding WhatsApp's 4096 hard cap.
 */
export function chunkText(text: string, limit: number = DEFAULT_CHUNK_LIMIT): string[] {
  const effective = Math.max(1, Math.min(limit, WHATSAPP_TEXT_HARD_LIMIT));
  if (text.length === 0) return [];
  if (codePointLength(text) <= effective) return [text];

  // Prefer paragraph boundaries (blank lines), preserving them as separators.
  const paragraphs = text.split(/\n{2,}/);
  const chunks = packParts(paragraphs, "\n\n", effective);
  // Final safety net: guarantee no chunk exceeds the hard cap.
  return chunks.flatMap((c) => (codePointLength(c) > WHATSAPP_TEXT_HARD_LIMIT ? hardSplit(c, effective) : [c]));
}
