function normalizeEnvSecret(value) {
  let secret = String(value || '').trim();
  if ((secret.startsWith('"') && secret.endsWith('"')) || (secret.startsWith("'") && secret.endsWith("'"))) {
    secret = secret.slice(1, -1).trim();
  }
  return secret.replace(/\\\$/g, '$');
}

const RESEND_API_KEY = normalizeEnvSecret(process.env.RESEND_API_KEY);
const EMAIL_FROM_NAME = normalizeEnvSecret(process.env.EMAIL_FROM_NAME) || 'RashadTech';
const EMAIL_FROM_ADDRESS = normalizeEnvSecret(process.env.EMAIL_FROM_ADDRESS) || 'noreply@rashadtech.tv';
const EMAIL_REPLY_TO = normalizeEnvSecret(process.env.EMAIL_REPLY_TO) || 'support@rashadtech.tv';
const SITE_URL = normalizeEnvSecret(process.env.SITE_URL) || 'https://rashadtech.tv';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtmlParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `<p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function wrapEmailHtml({ title, bodyHtml, preheader }) {
  const preview = escapeHtml(preheader || title || '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title || 'RashadTech')}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preview}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:20px 24px;border-bottom:3px solid #e50914;">
              <div style="font-size:20px;font-weight:700;color:#111827;">${escapeHtml(EMAIL_FROM_NAME)}</div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px;">${escapeHtml(SITE_URL.replace(/^https?:\/\//, ''))}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">${bodyHtml}</td>
          </tr>
          <tr>
            <td style="padding:16px 24px 22px;border-top:1px solid #e5e7eb;background:#fafafa;">
              <div style="font-size:12px;line-height:1.5;color:#6b7280;">
                This message was sent by ${escapeHtml(EMAIL_FROM_NAME)}. Reply to <a href="mailto:${escapeHtml(EMAIL_REPLY_TO)}" style="color:#2563eb;">${escapeHtml(EMAIL_REPLY_TO)}</a> if you need help.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildOtpEmailContent(name, otp, subject) {
  const displayName = String(name || 'there').trim() || 'there';
  const title = String(subject || 'Your RashadTech verification code').trim();
  const text = [
    `Hello ${displayName},`,
    '',
    `Your verification code is ${otp}.`,
    'It expires in 10 minutes. Do not share this code with anyone.',
    '',
    `If you did not request this, you can ignore this email.`,
    '',
    EMAIL_FROM_NAME
  ].join('\n');
  const bodyHtml = `
    <p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Hello ${escapeHtml(displayName)},</p>
    <p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Use this verification code to continue on ${escapeHtml(SITE_URL.replace(/^https?:\/\//, ''))}:</p>
    <div style="margin:18px 0 20px;padding:16px 18px;background:#111827;color:#ffffff;border-radius:10px;font-size:28px;letter-spacing:6px;font-weight:700;text-align:center;">${escapeHtml(otp)}</div>
    <p style="margin:0 0 14px;line-height:1.6;color:#6b7280;font-size:14px;">This code expires in 10 minutes. Never share it with anyone.</p>`;
  const html = wrapEmailHtml({ title, bodyHtml, preheader: `Your code is ${otp}` });
  return { subject: title, text, html };
}

function buildMarketingEmailContent(name, subject, message) {
  const displayName = String(name || 'Customer').trim() || 'Customer';
  const title = String(subject || `Message from ${EMAIL_FROM_NAME}`).trim();
  const body = String(message || '').trim();
  const text = body.toLowerCase().startsWith(title.toLowerCase()) ? body : `${title}\n\n${body}`;
  const greeting = `<p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Hello ${escapeHtml(displayName)},</p>`;
  const bodyHtml = greeting + textToHtmlParagraphs(text.replace(new RegExp(`^${title}\\s*`, 'i'), '').trim() || text);
  const html = wrapEmailHtml({ title, bodyHtml, preheader: title });
  return { subject: title, text, html };
}

function formatFromAddress() {
  return `${EMAIL_FROM_NAME} <${EMAIL_FROM_ADDRESS}>`;
}

function isServerEmailConfigured() {
  return Boolean(RESEND_API_KEY || normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY));
}

function getActiveEmailProvider() {
  if (RESEND_API_KEY) return 'resend';
  if (normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY)) return 'emailjs';
  return 'none';
}

function getEmailDeliverabilityStatus(extra = {}) {
  const provider = getActiveEmailProvider();
  return {
    provider,
    resendConfigured: Boolean(RESEND_API_KEY),
    emailjsConfigured: Boolean(normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY)),
    serverEmailConfigured: isServerEmailConfigured(),
    fromName: EMAIL_FROM_NAME,
    fromAddress: EMAIL_FROM_ADDRESS,
    replyTo: EMAIL_REPLY_TO,
    inboxTips: [
      provider === 'resend'
        ? 'Resend is active — verify rashadtech.tv in Resend and add SPF/DKIM DNS records there.'
        : 'For best inbox delivery, add RESEND_API_KEY on Render and verify rashadtech.tv (SPF + DKIM).',
      `Use a fixed sender name (${EMAIL_FROM_NAME}) and reply address (${EMAIL_REPLY_TO}), not the customer email.`,
      'Keep OTP subject as {{subject}} in EmailJS. Avoid words like "FREE", "URGENT", or all caps in broadcasts.',
      'Ask new customers to mark your first email as "Not spam" once — this trains Gmail/Outlook for future messages.'
    ],
    ...extra
  };
}

function sharedTemplateFields(email, name) {
  const recipient = String(email || '').trim().toLowerCase();
  const displayName = String(name || recipient || 'Customer').trim() || 'Customer';
  return {
    to_email: recipient,
    email: recipient,
    user_email: recipient,
    recipient,
    to_name: displayName,
    user_name: displayName,
    from_name: EMAIL_FROM_NAME,
    reply_to: EMAIL_REPLY_TO,
    support_email: EMAIL_REPLY_TO,
    site_url: SITE_URL
  };
}

function otpTemplateParams(email, otp, name, subject) {
  const content = buildOtpEmailContent(name, otp, subject);
  return {
    ...sharedTemplateFields(email, name),
    subject: content.subject,
    title: content.subject,
    email_subject: content.subject,
    mail_subject: content.subject,
    otp_code: otp,
    verification_code: otp,
    passcode: otp,
    code: otp,
    otp,
    reset_code: otp,
    message: content.text,
    body: content.text,
    content: content.text,
    html_message: content.html,
    email_content: content.html
  };
}

function marketingTemplateParams(email, name, subject, message) {
  const content = buildMarketingEmailContent(name, subject, message);
  return {
    ...sharedTemplateFields(email, name),
    subject: content.subject,
    title: content.subject,
    email_subject: content.subject,
    mail_subject: content.subject,
    user_subject: content.subject,
    message: content.text,
    body: content.text,
    content: content.text,
    user_message: content.text,
    email_content: content.html,
    html_message: content.html,
    email_type: 'marketing',
    otp_code: '',
    verification_code: '',
    passcode: '',
    code: '',
    otp: '',
    reset_code: ''
  };
}

async function sendViaResend({ to, subject, text, html, headers }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const payload = {
    from: formatFromAddress(),
    to: [String(to || '').trim().toLowerCase()],
    subject: String(subject || '').trim(),
    text: String(text || '').trim(),
    html: String(html || '').trim(),
    reply_to: EMAIL_REPLY_TO
  };
  if (headers && Object.keys(headers).length) payload.headers = headers;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend failed: ${r.status}${body ? ` — ${body}` : ''}`);
  }
}

async function sendViaEmailJS({ templateId, templateParams, emailJs }) {
  const privateKey = normalizeEnvSecret(emailJs.privateKey);
  if (!privateKey) throw new Error('EMAILJS_PRIVATE_KEY is not configured');
  const payload = {
    service_id: emailJs.serviceId,
    template_id: templateId,
    user_id: emailJs.publicKey,
    accessToken: privateKey,
    template_params: templateParams
  };
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`EmailJS failed: ${r.status}${body ? ` — ${body}` : ''}`);
  }
}

async function deliverOtpEmail({ email, otp, name, subject, emailJs }) {
  const content = buildOtpEmailContent(name, otp, subject);
  if (RESEND_API_KEY) {
    await sendViaResend({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: { 'X-Entity-Ref-ID': `otp-${Date.now()}` }
    });
    return { provider: 'resend' };
  }
  await sendViaEmailJS({
    templateId: emailJs.otpTemplateId,
    templateParams: otpTemplateParams(email, otp, name, subject),
    emailJs
  });
  return { provider: 'emailjs' };
}

async function deliverMarketingEmail({ email, name, subject, message, templateId, emailJs }) {
  const content = buildMarketingEmailContent(name, subject, message);
  if (RESEND_API_KEY) {
    await sendViaResend({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: {
        'List-Unsubscribe': `<mailto:${EMAIL_REPLY_TO}?subject=unsubscribe>`,
        'X-Entity-Ref-ID': `marketing-${Date.now()}`
      }
    });
    return { provider: 'resend' };
  }
  await sendViaEmailJS({
    templateId,
    templateParams: marketingTemplateParams(email, name, subject, message),
    emailJs
  });
  return { provider: 'emailjs' };
}

module.exports = {
  buildMarketingEmailContent,
  buildOtpEmailContent,
  deliverMarketingEmail,
  deliverOtpEmail,
  getActiveEmailProvider,
  getEmailDeliverabilityStatus,
  isServerEmailConfigured,
  marketingTemplateParams,
  otpTemplateParams,
  EMAIL_FROM_NAME,
  EMAIL_REPLY_TO,
  EMAIL_FROM_ADDRESS
};
