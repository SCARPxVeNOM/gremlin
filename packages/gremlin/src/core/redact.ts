/**
 * Redaction for anything that leaves Kane's evidence pack or arrives from a bug report:
 * emails, phone numbers, card-like numbers, tokens and keys.
 */

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<![\w/.-])\+?\d[\d\s().-]{7,}\d(?![\w/.-])/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const TOKENS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe-style
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
];

/** Card numbers that are published test values and safe to keep. */
const TEST_CARDS = new Set(['4242424242424242', '4000056655665556', '5555555555554444', '378282246310005']);

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface RedactionResult {
  text: string;
  found: Record<string, number>;
}

export function redact(input: string, opts: { keepEmails?: RegExp } = {}): RedactionResult {
  const found: Record<string, number> = {};
  const bump = (k: string) => (found[k] = (found[k] ?? 0) + 1);
  let text = input;
  for (const re of TOKENS) {
    text = text.replace(re, () => {
      bump('token');
      return '[redacted-token]';
    });
  }
  text = text.replace(EMAIL, (m) => {
    if (opts.keepEmails?.test(m)) return m;
    bump('email');
    return '[redacted-email]';
  });
  text = text.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || TEST_CARDS.has(digits) || !luhn(digits)) return m;
    bump('card');
    return '[redacted-card]';
  });
  text = text.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return m;
    // Leave plain years, prices and order numbers alone: phone numbers carry separators or a +.
    if (!/[+\s().-]/.test(m)) return m;
    bump('phone');
    return '[redacted-phone]';
  });
  return { text, found };
}

export function redactText(input: string): string {
  return redact(input, { keepEmails: /@(example\.(com|org|net)|[\w-]+\.test|[\w-]+\.local)$/i }).text;
}
