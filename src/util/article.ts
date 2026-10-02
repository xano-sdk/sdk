/**
 * The indefinite article a word takes, by how it is SAID: "an ephemeral",
 * "an apiGroup", "an 8-byte body", but "a uuid", "a user", "a one-off".
 *
 * A message built as `a ${noun}` read "a ephemeral" the day the noun became a
 * vowel-initial kind, so every interpolated noun goes through here instead.
 */
export function article(word: string): "a" | "an" {
  const w = word.trim().toLowerCase();
  // A number is said by its digits: 8, 11, 18 and 80-89 (and 800…, 8000…) open
  // on a vowel sound. Only the leading group matters, so "11-byte" and
  // "11000" both take "an" ("eleven", "eleven thousand").
  const digits = /^\d+/.exec(w)?.[0];
  if (digits !== undefined) {
    if (digits.startsWith("8")) return "an";
    const lead = digits.length % 3 === 2 ? digits.slice(0, 2) : "";
    return lead === "11" || lead === "18" ? "an" : "a";
  }
  // Vowel letters said as a consonant: "you" (uu-, uni-, use-, eu-) and "won" (one).
  if (/^(uu|uni|uint|use|usu|uti|ur[il]|eu|one\b|once)/.test(w)) return "a";
  // Consonant letters said as a vowel: an initialism spelled out ("em-see-pee").
  if (/^(mcp|llm|mfa|sql|sms|smtp|ssl|ssh|xml|html|http|rpc)/.test(w)) return "an";
  return /^[aeiou]/.test(w) ? "an" : "a";
}

/** The word with its article: `withArticle("ephemeral")` → `"an ephemeral"`. */
export function withArticle(word: string): string {
  return `${article(word)} ${word}`;
}
