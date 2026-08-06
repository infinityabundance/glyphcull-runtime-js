//! Text breaking — word boundaries and line-break opportunities.
//!
//! Scope (documented in DESIGN.md D7 and TESTING.md): the runtime breaks
//! Latin/Cyrillic/Greek and mark-heavy text at UAX #29-grounded word
//! boundaries, and CJK text between ideographs (no dictionary needed for
//! break *opportunities*). The rules implemented here are the v1 subset:
//!
//! - A break is allowed after whitespace runs.
//! - A break is forbidden inside a word (letters, digits, underscores,
//!   apostrophes in contractions).
//! - A break is forbidden before closing punctuation
//!   `, . ; : ! ? ) ] } %` and after opening punctuation `( [ {` and quotes.
//! - Combining marks bind to their base (no break between base and mark).
//! - CJK ideographs/hiragana/katakana/hangul: break allowed between any two;
//!   forbidden before closing CJK punctuation and after opening CJK
//!   punctuation.
//! - Explicit newlines are forced breaks (preformatted content).
//!
//! The token stream feeds the Knuth–Plass line breaker (`kp.ts`).

/** How a break after a token is classified. */
export enum BreakClass {
  /** A space: the natural break opportunity (glue). */
  Space = 'space',
  /** A permissible break with no glue (CJK between-ideograph). */
  Allowed = 'allowed',
  /** No break here (inside a word, before punctuation, …). */
  Forbidden = 'forbidden',
  /** A forced break (explicit newline). */
  Forced = 'forced',
}

/** One text token for the line breaker. */
export interface TextToken {
  readonly text: string;
  readonly breakAfter: BreakClass;
}

const SPACE = /\s/;
const WORD_CHAR = /[\p{L}\p{N}_\u2019]/u; // letters, digits, underscore, right single quote
const PUNCTUATION = /[\p{P}\p{S}]/u;
const NO_BREAK_BEFORE =
  /[,.!?;:%\u2026)\]}\u3001\u3002\uff09\uff3d\u300b\u300d\u3011\uff1f\uff01\uff1b\uff1a]/u;
const NO_BREAK_AFTER = /[(["“‘«「『〈《（［【’]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Tokenize text into breakable units. Whitespace runs become separate
 * tokens with `BreakClass.Space`; CJK characters become individual tokens
 * with `BreakClass.Allowed` breaks between them; word runs stay intact.
 */
export function tokenizeForBreaking(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const charLen = ch.length;

    if (cp === 0x0a || cp === 0x0d) {
      tokens.push({ text: ch, breakAfter: BreakClass.Forced });
      i += charLen;
      continue;
    }
    if (SPACE.test(ch)) {
      // A whitespace run: one glue token.
      let j = i;
      while (j < n && SPACE.test(text[j]!)) j += 1;
      tokens.push({ text: text.slice(i, j), breakAfter: BreakClass.Space });
      i = j;
      continue;
    }
    if (CJK.test(ch)) {
      // CJK: each char is its own box; breaks are allowed between them.
      // Closing CJK punctuation binds to the preceding character (no break
      // between them, UAX #29 CL/NS semantics).
      let j = i + charLen;
      while (j < n) {
        const nextCp = text.codePointAt(j)!;
        const nextCh = String.fromCodePoint(nextCp);
        const nextLen = nextCh.length;
        if (PUNCTUATION.test(nextCh) && NO_BREAK_BEFORE.test(nextCh)) {
          j += nextLen;
          continue;
        }
        break;
      }
      tokens.push({
        text: text.slice(i, j),
        breakAfter: j < n ? BreakClass.Allowed : BreakClass.Forbidden,
      });
      i = j;
      continue;
    }
    // A word run: letters/digits/underscore/contraction apostrophe.
    let j = i;
    while (j < n) {
      const nextCp = text.codePointAt(j)!;
      const nextCh = String.fromCodePoint(nextCp);
      const nextLen = nextCh.length;
      if (SPACE.test(nextCh) || CJK.test(nextCh) || nextCp === 0x0a || nextCp === 0x0d) {
        break;
      }
      if (WORD_CHAR.test(nextCh)) {
        j += nextLen;
        continue;
      }
      if (PUNCTUATION.test(nextCh)) {
        if (NO_BREAK_BEFORE.test(nextCh)) {
          // Closing punctuation binds to the preceding word (and its
          // break-after is still decided by what follows).
          j += nextLen;
          continue;
        }
        if (NO_BREAK_AFTER.test(nextCh) && j === i) {
          // An opening punctuation at the token start binds to the following
          // word (a break is forbidden after it): '('hello' → one token.
          j += nextLen;
          continue;
        }
        break;
      }
      break;
    }
    // Defensive: never emit an empty token — the scan always consumes at
    // least the current character (a symbol that binds neither way, e.g. '$').
    if (j === i) j = i + charLen;
    // Decide the break after this word based on the next character.
    const nextStart = j;
    let breakAfter: BreakClass;
    if (nextStart < n) {
      const nextCh = text[nextStart]!;
      if (NO_BREAK_AFTER.test(nextCh)) {
        // An opener follows: the word binds to it; the break happens later.
        breakAfter = BreakClass.Forbidden;
      } else {
        breakAfter = BreakClass.Allowed;
      }
    } else {
      breakAfter = BreakClass.Forbidden; // end of text
    }
    tokens.push({ text: text.slice(i, j), breakAfter });
    i = j;
  }
  return tokens;
}

/** Whether a codepoint is a combining mark (Mn / Me / Mc). */
export function isCombiningMark(cp: number): boolean {
  // Quick check for the common combining ranges; the full Mn/Me/Mc tables
  // are not needed for v1 glyph attachment (marks advance 0 in the atlas).
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe20 && cp <= 0xfe2f) // Combining Half Marks
  );
}
