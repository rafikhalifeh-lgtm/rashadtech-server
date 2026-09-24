function isValidDisneyOtp(code) {
  return /^(?:\d{4}|\d{6})$/.test(String(code || ''));
}

function isLikelyDisneyFalsePositive(code, context) {
  const ctx = String(context || '');
  if (!/^\d{4}$/.test(String(code || ''))) return false;
  if (/^20\d{2}$/.test(code) || /^19\d{2}$/.test(code)) return true;
  if (/call|tel:|phone|whatsapp|mobile|customer service|support line|hotline/i.test(ctx)) return true;
  if (/\+\d|00\d{2,}/.test(ctx)) return true;
  return false;
}

function normalizeSpacedDigits(value, lengths) {
  const digits = String(value || '').replace(/\D/g, '');
  const allowed = Array.isArray(lengths) ? lengths : [lengths];
  return allowed.includes(digits.length) ? digits : null;
}

function extractDisneyOtp(body) {
  const text = String(body || '');
  if (!text) return null;
  const lengths = [6, 4];
  const labeledPatterns = [
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*(?:is)?\s*[:#\-]?\s*((?:\d[\s\-]*){4,6})\b/gi,
    /(?:code|password)\s*(?:is)?\s*[:#\-]?\s*((?:\d[\s\-]*){4,6})\b/gi,
    /\b((?:\d[\s\-]*){4,6})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/gi,
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*[:#\-]?\s*(\d{4,6})\b/gi,
    /\b(\d{4,6})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/gi,
    /passcode[^\d]{0,40}((?:\d[\s\-]){4,11})/gi
  ];
  for (const re of labeledPatterns) {
    for (const m of text.matchAll(re)) {
      const digits = normalizeSpacedDigits(m[1], lengths);
      if (digits && isValidDisneyOtp(digits)) return digits;
    }
  }
  for (const len of lengths) {
    const re = new RegExp(`\\b(\\d{${len}})\\b`, 'g');
    const candidates = [...text.matchAll(re)]
      .map((m) => ({
        code: m[1],
        context: text.slice(Math.max(0, (m.index || 0) - 48), (m.index || 0) + 48)
      }))
      .filter((x) => isValidDisneyOtp(x.code) && !isLikelyDisneyFalsePositive(x.code, x.context));
    if (candidates.length) return candidates[candidates.length - 1].code;
  }
  return null;
}

function isDisneySender(from) {
  const value = String(from || '').toLowerCase();
  return /disney|disneyplus|disneyaccount|mydisney|email\.disneyplus/i.test(value);
}

function isDisneyEmailContent(body) {
  const lower = String(body || '').toLowerCase();
  return /disney|disney\+|mydisney|one[\s-]?time passcode|one[\s-]?time code|verification code|passcode/i.test(lower);
}

function defaultDisneyPlainBody(parsed) {
  const subject = String(parsed.subject || '').trim();
  const text = String(parsed.text || '').trim();
  const html = String(parsed.html || '');
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  const parts = [];
  if (subject) parts.push(subject);
  if (text) parts.push(text);
  if (stripped && (!text || !text.includes(stripped.slice(0, 24)))) parts.push(stripped);
  return parts.join('\n') || text || subject;
}

function extractDisneyCode(parsedEmail, plainBodyFn) {
  const plainBody = typeof plainBodyFn === 'function' ? plainBodyFn : defaultDisneyPlainBody;
  const from = (parsedEmail.from || '').toString();
  const body = plainBody(parsedEmail);
  if (!isDisneySender(from) && !isDisneyEmailContent(body)) return null;
  const code = extractDisneyOtp(body);
  return code ? { code, customerSafe: true } : null;
}

module.exports = {
  isValidDisneyOtp,
  isLikelyDisneyFalsePositive,
  extractDisneyOtp,
  isDisneySender,
  isDisneyEmailContent,
  extractDisneyCode
};
