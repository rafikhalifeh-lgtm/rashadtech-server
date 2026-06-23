function normalizeEnvSecret(value) {
  let secret = String(value || '').trim();
  if ((secret.startsWith('"') && secret.endsWith('"')) || (secret.startsWith("'") && secret.endsWith("'"))) {
    secret = secret.slice(1, -1).trim();
  }
  return secret.replace(/\\\$/g, '$');
}

const DEFAULT_FROM_NAME = 'RashadTech';
const DEFAULT_FROM_ADDRESS = 'noreply@rashadtech.tv';
const DEFAULT_REPLY_TO = 'support@rashadtech.tv';
const DEFAULT_SITE_URL = 'https://rashadtech.tv';

function resolveEmailConfig(data) {
  const settings = (data && data.siteSettings) || {};
  return {
    resendApiKey: normalizeEnvSecret(process.env.RESEND_API_KEY) || normalizeEnvSecret(settings.resendApiKey),
    fromName: normalizeEnvSecret(process.env.EMAIL_FROM_NAME) || normalizeEnvSecret(settings.emailFromName) || DEFAULT_FROM_NAME,
    fromAddress: normalizeEnvSecret(process.env.EMAIL_FROM_ADDRESS) || normalizeEnvSecret(settings.emailFromAddress) || DEFAULT_FROM_ADDRESS,
    replyTo: normalizeEnvSecret(process.env.EMAIL_REPLY_TO) || normalizeEnvSecret(settings.emailReplyTo) || DEFAULT_REPLY_TO,
    siteUrl: normalizeEnvSecret(process.env.SITE_URL) || DEFAULT_SITE_URL
  };
}

function maskSecret(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

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

function wrapEmailHtml({ title, bodyHtml, preheader, config }) {
  const cfg = config || resolveEmailConfig();
  const preview = escapeHtml(preheader || title || '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title || cfg.fromName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preview}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:20px 24px;border-bottom:3px solid #e50914;">
              <div style="font-size:20px;font-weight:700;color:#111827;">${escapeHtml(cfg.fromName)}</div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px;">${escapeHtml(cfg.siteUrl.replace(/^https?:\/\//, ''))}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">${bodyHtml}</td>
          </tr>
          <tr>
            <td style="padding:16px 24px 22px;border-top:1px solid #e5e7eb;background:#fafafa;">
              <div style="font-size:12px;line-height:1.5;color:#6b7280;">
                This message was sent by ${escapeHtml(cfg.fromName)}. Reply to <a href="mailto:${escapeHtml(cfg.replyTo)}" style="color:#2563eb;">${escapeHtml(cfg.replyTo)}</a> if you need help.
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

function buildOtpEmailContent(name, otp, subject, data) {
  const config = resolveEmailConfig(data);
  const displayName = String(name || 'there').trim() || 'there';
  const title = String(subject || 'Your RashadTech verification code').trim();
  const text = [
    `Hello ${displayName},`,
    '',
    `Your verification code is ${otp}.`,
    'It expires in 10 minutes. Do not share this code with anyone.',
    '',
    'If you did not request this, you can ignore this email.',
    '',
    config.fromName
  ].join('\n');
  const bodyHtml = `
    <p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Hello ${escapeHtml(displayName)},</p>
    <p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Use this verification code to continue on ${escapeHtml(config.siteUrl.replace(/^https?:\/\//, ''))}:</p>
    <div style="margin:18px 0 20px;padding:16px 18px;background:#111827;color:#ffffff;border-radius:10px;font-size:28px;letter-spacing:6px;font-weight:700;text-align:center;">${escapeHtml(otp)}</div>
    <p style="margin:0 0 14px;line-height:1.6;color:#6b7280;font-size:14px;">This code expires in 10 minutes. Never share it with anyone.</p>`;
  const html = wrapEmailHtml({ title, bodyHtml, preheader: `Your code is ${otp}`, config });
  return { subject: title, text, html, config };
}

function buildMarketingEmailContent(name, subject, message, data) {
  const config = resolveEmailConfig(data);
  const displayName = String(name || 'Customer').trim() || 'Customer';
  const title = String(subject || `Message from ${config.fromName}`).trim();
  const body = String(message || '').trim();
  const text = body.toLowerCase().startsWith(title.toLowerCase()) ? body : `${title}\n\n${body}`;
  const greeting = `<p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Hello ${escapeHtml(displayName)},</p>`;
  const bodyHtml = greeting + textToHtmlParagraphs(text.replace(new RegExp(`^${title}\\s*`, 'i'), '').trim() || text);
  const html = wrapEmailHtml({ title, bodyHtml, preheader: title, config });
  return { subject: title, text, html, config };
}

function buildTestEmailContent(name, data) {
  const config = resolveEmailConfig(data);
  const displayName = String(name || 'Admin').trim() || 'Admin';
  const subject = 'RashadTech inbox test — delivery OK';
  const message = [
    'This is a test email from your RashadTech admin panel.',
    '',
    'If you received this in your normal inbox (not spam), your email delivery is configured correctly.',
    '',
    `Sender: ${config.fromName} <${config.fromAddress}>`,
    `Reply-to: ${config.replyTo}`,
    `Provider: ${config.resendApiKey ? 'Resend' : 'EmailJS'}`
  ].join('\n');
  return buildMarketingEmailContent(displayName, subject, message, data);
}

function formatFromAddress(config) {
  const cfg = config || resolveEmailConfig();
  return `${cfg.fromName} <${cfg.fromAddress}>`;
}

function isServerEmailConfigured(data) {
  const config = resolveEmailConfig(data);
  return Boolean(config.resendApiKey || normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY));
}

function getActiveEmailProvider(data) {
  const config = resolveEmailConfig(data);
  if (config.resendApiKey) return 'resend';
  if (normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY)) return 'emailjs';
  return 'none';
}

function getEmailDeliverabilityStatus(extra = {}, data) {
  const config = resolveEmailConfig(data);
  const provider = getActiveEmailProvider(data);
  const resendFromSettings = Boolean(normalizeEnvSecret((data && data.siteSettings && data.siteSettings.resendApiKey) || ''));
  return {
    provider,
    resendConfigured: Boolean(config.resendApiKey),
    resendFromEnv: Boolean(normalizeEnvSecret(process.env.RESEND_API_KEY)),
    resendFromSettings,
    resendApiKeyMasked: maskSecret(config.resendApiKey),
    emailjsConfigured: Boolean(normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY)),
    serverEmailConfigured: isServerEmailConfigured(data),
    fromName: config.fromName,
    fromAddress: config.fromAddress,
    replyTo: config.replyTo,
    dnsSteps: [
      'Sign up at resend.com and add domain rashadtech.tv',
      'Copy the SPF and DKIM DNS records from Resend into your domain DNS',
      'Wait until Resend shows the domain as Verified',
      'Paste your Resend API key below (starts with re_) and click Save',
      'Send a test email to yourself and check inbox + spam folder'
    ],
    inboxTips: [
      provider === 'resend'
        ? 'Resend is active. Make sure rashadtech.tv is Verified in Resend (green check).'
        : 'Add your Resend API key in Admin → Dashboard for best inbox delivery.',
      `Sender: ${config.fromName} <${config.fromAddress}> · Reply: ${config.replyTo}`,
      'EmailJS OTP template subject must be {{subject}}. Marketing body can use {{{html_message}}}.',
      'Avoid spam words in broadcasts: FREE, URGENT, WIN, ALL CAPS.',
      'Ask a few customers to mark your email as Not spam once.'
    ],
    ...extra
  };
}

function sharedTemplateFields(email, name, data) {
  const config = resolveEmailConfig(data);
  const recipient = String(email || '').trim().toLowerCase();
  const displayName = String(name || recipient || 'Customer').trim() || 'Customer';
  return {
    to_email: recipient,
    email: recipient,
    user_email: recipient,
    recipient,
    to_name: displayName,
    user_name: displayName,
    from_name: config.fromName,
    reply_to: config.replyTo,
    support_email: config.replyTo,
    site_url: config.siteUrl
  };
}

function otpTemplateParams(email, otp, name, subject, data) {
  const content = buildOtpEmailContent(name, otp, subject, data);
  return {
    ...sharedTemplateFields(email, name, data),
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

function marketingTemplateParams(email, name, subject, message, data) {
  const content = buildMarketingEmailContent(name, subject, message, data);
  return {
    ...sharedTemplateFields(email, name, data),
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

async function sendViaResend({ to, subject, text, html, headers, config }) {
  const cfg = config || resolveEmailConfig();
  if (!cfg.resendApiKey) throw new Error('Resend API key is not configured');
  const payload = {
    from: formatFromAddress(cfg),
    to: [String(to || '').trim().toLowerCase()],
    subject: String(subject || '').trim(),
    text: String(text || '').trim(),
    html: String(html || '').trim(),
    reply_to: cfg.replyTo
  };
  if (headers && Object.keys(headers).length) payload.headers = headers;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend failed: ${r.status}${body ? ` — ${body}` : ''}`);
  }
  const json = await r.json().catch(() => ({}));
  return json;
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

async function deliverOtpEmail({ email, otp, name, subject, emailJs, data }) {
  const content = buildOtpEmailContent(name, otp, subject, data);
  if (content.config.resendApiKey) {
    await sendViaResend({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: { 'X-Entity-Ref-ID': `otp-${Date.now()}` },
      config: content.config
    });
    return { provider: 'resend' };
  }
  await sendViaEmailJS({
    templateId: emailJs.otpTemplateId,
    templateParams: otpTemplateParams(email, otp, name, subject, data),
    emailJs
  });
  return { provider: 'emailjs' };
}

async function deliverMarketingEmail({ email, name, subject, message, templateId, emailJs, data }) {
  const content = buildMarketingEmailContent(name, subject, message, data);
  if (content.config.resendApiKey) {
    await sendViaResend({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: {
        'List-Unsubscribe': `<mailto:${content.config.replyTo}?subject=unsubscribe>`,
        'X-Entity-Ref-ID': `marketing-${Date.now()}`
      },
      config: content.config
    });
    return { provider: 'resend' };
  }
  await sendViaEmailJS({
    templateId,
    templateParams: marketingTemplateParams(email, name, subject, message, data),
    emailJs
  });
  return { provider: 'emailjs' };
}

async function deliverTestEmail({ email, name, emailJs, data }) {
  const content = buildTestEmailContent(name, data);
  if (content.config.resendApiKey) {
    await sendViaResend({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: { 'X-Entity-Ref-ID': `test-${Date.now()}` },
      config: content.config
    });
    return { provider: 'resend' };
  }
  const templateId = emailJs.marketingTemplateId || emailJs.otpTemplateId;
  await sendViaEmailJS({
    templateId,
    templateParams: marketingTemplateParams(email, name || 'Admin', content.subject, content.text, data),
    emailJs
  });
  return { provider: 'emailjs' };
}

module.exports = {
  buildMarketingEmailContent,
  buildOtpEmailContent,
  buildTestEmailContent,
  deliverMarketingEmail,
  deliverOtpEmail,
  deliverTestEmail,
  getActiveEmailProvider,
  getEmailDeliverabilityStatus,
  isServerEmailConfigured,
  marketingTemplateParams,
  maskSecret,
  otpTemplateParams,
  resolveEmailConfig,
  DEFAULT_FROM_ADDRESS,
  DEFAULT_FROM_NAME,
  DEFAULT_REPLY_TO
};
