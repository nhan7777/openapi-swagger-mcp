// Display helpers over exact bytes. Raw pages are never required to be valid UTF-8; text and formatted views are
// DERIVED from the bytes and labelled as such by the UI. Nothing here changes or re-hashes the original artifact.

/** 16 bytes per line: 8-digit absolute offset, two spaces, space-separated lowercase hex. */
export function hexDump(buf: Uint8Array, baseOffset: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const hex: string[] = [];
    for (let j = i; j < Math.min(i + 16, buf.length); j++) hex.push(buf[j]!.toString(16).padStart(2, '0'));
    lines.push(`${(baseOffset + i).toString(16).padStart(8, '0')}  ${hex.join(' ')}`);
  }
  return lines.join('\n');
}

const uEsc = (cp: number): string => `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;

/** Code points shown as `\u{XXXX}` in derived text: C0/C1 controls (except \n \t), DEL, bidi controls, invisible joiners. */
function needsEscape(cp: number): boolean {
  if (cp === 0x0a || cp === 0x09) return false;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embedding / override
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) return true; // directional marks
  if (cp >= 0x200b && cp <= 0x200d) return true; // zero-width space / joiners
  return cp === 0x2028 || cp === 0x2029 || cp === 0xfeff;
}

export interface DerivedText {
  text: string;
  /** Number of escape sequences inserted (invalid bytes plus escaped code points). */
  escaped: number;
}

/**
 * Decode one byte page as UTF-8 for display. Never throws and never emits U+FFFD: every byte that is not part of a
 * well-formed sequence (including a character cut by the page boundary) becomes `\xNN`; control and bidi code points
 * become `\u{XXXX}`. A literal backslash is shown as `\\` so escapes stay unambiguous.
 */
export function deriveText(buf: Uint8Array): DerivedText {
  const out: string[] = [];
  let escaped = 0;
  let i = 0;
  const n = buf.length;
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => k < n && buf[k]! >= lo && buf[k]! <= hi;
  while (i < n) {
    const b = buf[i]!;
    let cp = -1;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b <= 0xdf && cont(i + 1)) {
      cp = ((b & 0x1f) << 6) | (buf[i + 1]! & 0x3f);
      len = 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      const lo = b === 0xe0 ? 0xa0 : 0x80;
      const hi = b === 0xed ? 0x9f : 0xbf; // no surrogates
      if (cont(i + 1, lo, hi) && cont(i + 2)) {
        cp = ((b & 0x0f) << 12) | ((buf[i + 1]! & 0x3f) << 6) | (buf[i + 2]! & 0x3f);
        len = 3;
      }
    } else if (b >= 0xf0 && b <= 0xf4) {
      const lo = b === 0xf0 ? 0x90 : 0x80;
      const hi = b === 0xf4 ? 0x8f : 0xbf;
      if (cont(i + 1, lo, hi) && cont(i + 2) && cont(i + 3)) {
        cp = ((b & 0x07) << 18) | ((buf[i + 1]! & 0x3f) << 12) | ((buf[i + 2]! & 0x3f) << 6) | (buf[i + 3]! & 0x3f);
        len = 4;
      }
    }
    if (cp < 0) {
      out.push(`\\x${b.toString(16).padStart(2, '0')}`);
      escaped++;
      i++;
    } else if (cp === 0x5c) {
      out.push('\\\\');
      i += len;
    } else if (needsEscape(cp)) {
      out.push(uEsc(cp));
      escaped++;
      i += len;
    } else {
      out.push(String.fromCodePoint(cp));
      i += len;
    }
  }
  return { text: out.join(''), escaped };
}

export type FormatFailure = 'incomplete' | 'not_json' | 'too_large' | 'bom' | 'invalid_utf8' | 'invalid_json' | 'too_deep' | 'output_too_large';
export type FormatResult = { ok: true; text: string; note: string } | { ok: false; reason: FormatFailure };

export const FORMAT_NOTE = 'Re-formatted from the parsed value: numbers are IEEE-754 doubles and duplicate keys are collapsed. The raw view is the original.';
const MAX_DEPTH_DEFAULT = 64;

/** Bracket nesting of JSON text, ignoring brackets inside strings. Iterative; stops as soon as `limit` is exceeded. */
function nestingExceeds(text: string, limit: number): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inStr = false;
    } else if (c === 0x22) inStr = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > limit) return true;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return false;
}

class OutputBudget extends Error {}

/** Two-space pretty printer that aborts as soon as the output would exceed `max` characters. */
function prettyBounded(value: unknown, max: number): string {
  const parts: string[] = [];
  let used = 0;
  const emit = (s: string): void => {
    used += s.length;
    if (used > max) throw new OutputBudget();
    parts.push(s);
  };
  const walk = (v: unknown, indent: string): void => {
    if (Array.isArray(v)) {
      if (v.length === 0) return emit('[]');
      const inner = indent + '  ';
      emit('[\n');
      v.forEach((x, k) => {
        emit(inner);
        walk(x, inner);
        emit(k < v.length - 1 ? ',\n' : '\n');
      });
      emit(indent + ']');
    } else if (typeof v === 'object' && v !== null) {
      const keys = Object.keys(v);
      if (keys.length === 0) return emit('{}');
      const inner = indent + '  ';
      emit('{\n');
      keys.forEach((k, idx) => {
        emit(`${inner}${JSON.stringify(k)}: `);
        walk((v as Record<string, unknown>)[k], inner);
        emit(idx < keys.length - 1 ? ',\n' : '\n');
      });
      emit(indent + '}');
    } else emit(JSON.stringify(v) ?? 'null');
  };
  walk(value, '');
  return parts.join('');
}

/**
 * Pretty-print a complete JSON body for display. Refuses (with a reason) instead of guessing: incomplete or non-JSON
 * artifacts, invalid UTF-8, a BOM, input over `maxBytes`, nesting over `maxDepth`, or output over `maxOutputChars`.
 * Control and bidi code points in the result are escaped like `deriveText`.
 */
export function formatJson(
  bytes: Uint8Array,
  o: { complete: boolean; kind: string; maxBytes: number; maxOutputChars?: number; maxDepth?: number },
): FormatResult {
  if (!o.complete) return { ok: false, reason: 'incomplete' };
  if (o.kind !== 'json') return { ok: false, reason: 'not_json' };
  if (bytes.length > o.maxBytes) return { ok: false, reason: 'too_large' };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { ok: false, reason: 'bom' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid_utf8' };
  }
  if (nestingExceeds(text, o.maxDepth ?? MAX_DEPTH_DEFAULT)) return { ok: false, reason: 'too_deep' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  try {
    const pretty = prettyBounded(value, o.maxOutputChars ?? o.maxBytes * 4);
    return { ok: true, text: escapeDisplay(pretty), note: FORMAT_NOTE };
  } catch (e) {
    if (e instanceof OutputBudget) return { ok: false, reason: 'output_too_large' };
    throw e;
  }
}

/** Escape control/bidi code points in already-decoded text (used for formatted output). */
function escapeDisplay(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += needsEscape(cp) ? uEsc(cp) : ch;
  }
  return out;
}

/** Slice `text` by UTF-16 offset without splitting a surrogate pair. `nextOffset` is absent on the last page. */
export function pageString(text: string, offset: number, limit: number): { text: string; offset: number; nextOffset?: number; totalChars: number } {
  const total = text.length;
  let start = Math.min(Math.max(0, Math.floor(offset)), total);
  if (start > 0 && start < total && isLow(text.charCodeAt(start))) start--;
  let end = Math.min(start + Math.max(1, Math.floor(limit)), total);
  if (end < total && isLow(text.charCodeAt(end))) end--;
  if (end <= start) end = Math.min(start + 2, total);
  return { text: text.slice(start, end), offset: start, ...(end < total ? { nextOffset: end } : {}), totalChars: total };
}
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
