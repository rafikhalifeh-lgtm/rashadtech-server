function isValidOsnOtp(code) {
  return /^\d{4}$/.test(String(code || ''));
}

function isLikelyOsnPhoneFragment(code, context) {
  const ctx = String(context || '').toLowerCase();
  if (!ctx) return false;
  if (/call|tel:|phone|whatsapp|mobile|customer service|support line|hotline/i.test(ctx)) return true;
  if (/\+\d|00\d{2,}/.test(ctx)) return true;
  if (new RegExp(`\\d\\s*${code}|${code}\\s*\\d`).test(ctx)) return true;
  return false;
}

function extractOsnOtp(body) {
  const text = String(body || '');
  if (!text) return null;
  const labeledPatterns = [
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security|pin)\s*(?:code|password|pin)?\s*[:#\-]?\s*((?:\d[\s\-]*){4})\b/gi,
    /(?:code|password|pin)\s*[:#\-]?\s*((?:\d[\s\-]*){4})\b/gi,
    /\b((?:\d[\s\-]*){4})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/gi,
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*[:#\-]?\s*(\d{4})\b/gi,
    /\b(\d{4})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/gi
  ];
  for (const re of labeledPatterns) {
    for (const m of text.matchAll(re)) {
      const digits = String(m[1] || '').replace(/\D/g, '');
      if (digits.length === 4 && isValidOsnOtp(digits)) {
        return digits;
      }
    }
  }
  const candidates = [...text.matchAll(/\b(\d{4})\b/g)]
    .map((m) => ({
      code: m[1],
      context: text.slice(Math.max(0, (m.index || 0) - 48), (m.index || 0) + 48)
    }))
    .filter((x) => isValidOsnOtp(x.code) && !isLikelyOsnPhoneFragment(x.code, x.context));
  return candidates.length ? candidates[candidates.length - 1].code : null;
}

function extractOsnCode(parsedEmail, emailPlainBody) {
  const from = (parsedEmail.from || '').toString().toLowerCase();
  const body = typeof emailPlainBody === 'function' ? emailPlainBody(parsedEmail) : String(parsedEmail.text || parsedEmail.html || '');
  const lower = body.toLowerCase();
  const fromOsn = /osn|osnplus|osntv|osn\.com|osnplus\.com/i.test(from);
  const bodyOsn = /osn\+?|osn plus|osnplus|osn streaming|osn\+ streaming/i.test(lower);
  if (!fromOsn && !bodyOsn) return null;

  const code = extractOsnOtp(body);
  return code ? { code, customerSafe: true } : null;
}

module.exports = {
  isValidOsnOtp,
  isLikelyOsnPhoneFragment,
  extractOsnOtp,
  extractOsnCode
};
