/**
 * Redaction helpers. The API key is an opaque bearer token and must never be
 * written to logs at any level. These helpers scrub it from arbitrary strings
 * and header objects before anything is logged.
 */
/**
 * Remove any occurrence of the given secret from a string, plus common
 * `Authorization: Bearer …` patterns, so no token leaks through error text.
 */
export function redactSecret(text, secret) {
    let out = text;
    if (secret && secret.length > 0) {
        out = out.split(secret).join("«redacted»");
    }
    // Defense in depth: scrub bearer tokens even if the exact secret is unknown.
    out = out.replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, "$1«redacted»");
    out = out.replace(/("?authorization"?\s*[:=]\s*"?)(bearer\s+)?[A-Za-z0-9._\-]+/gi, "$1«redacted»");
    return out;
}
//# sourceMappingURL=redact.js.map