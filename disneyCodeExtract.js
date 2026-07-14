function isValidDisneyOtp(code) {
  return /^\d{6}$/.test(String(code || ''));
}

function extractDisneyOtp(body) {
  const text = String(body || '');
  if (!text) return null;
  const labeledPatterns = [
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*(?:is)?\s*[:#\-]?\s*((?:\d[\s\-]*){6})\b/gi,
    /(?:code|password)\s*(?:is)?\s*[:#\-]?\s*((?:\d[\s\-]*){6})\b/gi,
    /\b((?:\d[\s\-]*){6})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/gi,
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*[:#\-]?\s*(\d{6})\b/gi,
    /\b(\d{6})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/gi,
    /passcode[^\d]{0,40}((?:\d[\s\-]){6,11})/gi
  ];
  for (const re of labeledPatterns) {
    for (const m of text.matchAll(re)) {
      const digits = String(m[1] || '').replace(/\D/g, '');
      if (digits.length === 6 && isValidDisneyOtp(digits)) return digits;
    }
  }
  const candidates = [...text.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]);
  return candidates.length ? candidates[candidates.length - 1] : null;
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
  extractDisneyOtp,
  isDisneySender,
  isDisneyEmailContent,
  extractDisneyCode
};
