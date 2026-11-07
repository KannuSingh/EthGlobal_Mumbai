// Post text from the chain is untrusted. Pages and the wallet only ever put it in the DOM as
// textContent, never as HTML, so markup in a post shows as the characters typed. On top of that,
// these helpers deal with characters that are invisible or reorder the text around them
// (bidirectional overrides, zero-width spaces, C0/C1 controls), which could make a post or a
// call look like something it isn't.

/** Controls, bidi embeddings/overrides/isolates, zero-width and invisible format characters. Keeps \n, \t, ZWNJ and ZWJ (emoji). */
export const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿￹-￻]/g;

/** Post text ready to show: hidden characters out, at most two combining marks in a row, at most one blank line. */
export function cleanText(s) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(HIDDEN, "")
    .replace(/\p{M}{3,}/gu, (m) => [...m].slice(0, 2).join(""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** For the wallet: the exact text, with each hidden character shown as an escape such as ‮. */
export function showHidden(s) {
  return String(s ?? "").replace(HIDDEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
