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
const RASHADTECH_DNS_DOMAIN = 'rashadtech.tv';

const RASHADTECH_RESEND_DNS_RECORDS = [
  {
    type: 'TXT',
    name: 'resend._domainkey',
    value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDKJlzx9E/vlYEkaPCoTCMvm4ExngnMs914M5KxRuHuH2PocIxroHV7wBeMoAlfhP2gX4UWfV4MZ2zdpiwKPYkAY5kKK/IVcyHC3pgVVz71Zp9D2u+zxXvOk1RTTNoB5cCtCDANw+Ctfesn+y4wv4D9z0t9Z5TgFufsPLlz9Ix5kQIDAQAB',
    note: 'DKIM — copy the full value'
  },
  {
    type: 'MX',
    name: 'send',
    value: 'feedback-smtp.eu-west-1.amazonses.com',
    priority: '10',
    note: 'Sending — EU region'
  },
  {
    type: 'TXT',
    name: 'send',
    value: 'v=spf1 include:amazonses.com ~all',
    note: 'SPF for sending'
  },
  {
    type: 'TXT',
    name: '_dmarc',
    value: 'v=DMARC1; p=none;',
    note: 'DMARC (recommended)'
  }
];

function getRashadtechDnsRecords() {
  return RASHADTECH_RESEND_DNS_RECORDS.map(row => ({ ...row }));
}

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

function buildSubscriptionEmailContent({
  name,
  productName,
  planLabel,
  order,
  subLink,
  assignedCustomerName,
  kind = 'fulfilled'
}, data) {
  const config = resolveEmailConfig(data);
  const displayName = String(name || 'Customer').trim() || 'Customer';
  const product = String(productName || order?.product || 'Subscription').trim();
  const plan = String(planLabel || order?.plan || '').trim();
  const isPending = kind === 'pending';
  const subject = isPending
    ? `Purchase confirmed — ${product}`
    : `Your ${product} subscription is ready`;
  const lines = [];
  lines.push(`Hello ${displayName},`);
  lines.push('');
  if (isPending) {
    lines.push(`Your purchase of ${product}${plan ? ` (${plan})` : ''} is confirmed.`);
    lines.push('We are preparing your subscription and will send your credentials shortly.');
  } else {
    lines.push(`Your ${product}${plan ? ` (${plan})` : ''} subscription is ready.`);
    if (assignedCustomerName) lines.push(`Assigned to: ${assignedCustomerName}`);
    lines.push('');
    if (order?.serviceLink) {
      lines.push(`Activation link: ${order.serviceLink}`);
    } else if (order?.phone && !order?.pass) {
      lines.push(`Phone (with country code): ${order.phone}`);
      lines.push('Open the Disney+ app, enter this phone, then use Request Sign-in Code on your subscription link.');
    } else if (order?.email) {
      lines.push(`Email: ${order.email}`);
      if (order.pass) lines.push(`Password: ${order.pass}`);
      else lines.push('Sign in with email + one-time code on your subscription link.');
    }
    if (order?.profileName) lines.push(`Profile: ${order.profileName}`);
    if (order?.profilePin) lines.push(`PIN: ${order.profilePin}`);
    if (order?.expiryDate) lines.push(`Expires: ${order.expiryDate}`);
    if (subLink) {
      lines.push('');
      lines.push(`Subscription link (codes & support): ${subLink}`);
    }
  }
  lines.push('');
  lines.push(`Sign in at ${config.siteUrl} anytime to view your subscriptions.`);
  lines.push('');
  lines.push(`— ${config.fromName}`);
  const text = lines.join('\n');

  const credRows = [];
  if (!isPending) {
    if (order?.serviceLink) {
      credRows.push(`<tr><td style="padding:8px 0;color:#6b7280;width:110px">Activation</td><td style="padding:8px 0"><a href="${escapeHtml(order.serviceLink)}" style="color:#2563eb;word-break:break-all">${escapeHtml(order.serviceLink)}</a></td></tr>`);
    }
    if (order?.phone) {
      credRows.push(`<tr><td style="padding:8px 0;color:#6b7280">Phone</td><td style="padding:8px 0;font-family:monospace;font-size:15px">${escapeHtml(order.phone)}</td></tr>`);
    }
    if (order?.email) {
      credRows.push(`<tr><td style="padding:8px 0;color:#6b7280">Email</td><td style="padding:8px 0;font-family:monospace;font-size:15px">${escapeHtml(order.email)}</td></tr>`);
    }
    if (order?.pass) {
      credRows.push(`<tr><td style="padding:8px 0;color:#6b7280">Password</td><td style="padding:8px 0;font-family:monospace;font-size:15px">${escapeHtml(order.pass)}</td></tr>`);
    }
    if (order?.profilePin) {
      credRows.push(`<tr><td style="padding:8px 0;color:#6b7280">PIN</td><td style="padding:8px 0;font-family:monospace;font-size:15px">${escapeHtml(order.profilePin)}</td></tr>`);
    }
    if (order?.expiryDate) {
      credRows.push(`<tr><td style="padding:8px 0;color:#6b7280">Expires</td><td style="padding:8px 0">${escapeHtml(order.expiryDate)}</td></tr>`);
    }
  }
  const bodyHtml = `
    <p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Hello ${escapeHtml(displayName)},</p>
    <p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">${isPending ? escapeHtml(`Your purchase of ${product}${plan ? ` (${plan})` : ''} is confirmed.`) : `Your <strong>${escapeHtml(product)}</strong>${plan ? ` · ${escapeHtml(plan)}` : ''} subscription is ready.`}</p>
    ${isPending ? '<p style="margin:0 0 14px;line-height:1.6;color:#6b7280;">We are preparing your subscription. You will receive another email when credentials are ready, or check My Subscriptions on the site.</p>' : ''}
    ${assignedCustomerName && !isPending ? `<p style="margin:0 0 14px;line-height:1.6;color:#1f2937;">Assigned to: <strong>${escapeHtml(assignedCustomerName)}</strong></p>` : ''}
    ${credRows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0 18px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px">${credRows.join('')}</table>` : ''}
    ${subLink && !isPending ? `<p style="margin:0 0 14px;line-height:1.6;color:#1f2937;"><a href="${escapeHtml(subLink)}" style="display:inline-block;background:#e50914;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Open subscription link</a></p><p style="margin:0 0 14px;line-height:1.5;color:#6b7280;font-size:13px;word-break:break-all">${escapeHtml(subLink)}</p>` : ''}
    <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">You can always sign in at <a href="${escapeHtml(config.siteUrl)}" style="color:#2563eb">${escapeHtml(config.siteUrl.replace(/^https?:\/\//, ''))}</a> to view your subscriptions.</p>`;
  const html = wrapEmailHtml({ title: subject, bodyHtml, preheader: isPending ? 'Purchase confirmed' : 'Your subscription credentials', config });
  return { subject, text, html, config };
}

async function deliverSubscriptionEmail({ email, name, productName, planLabel, order, subLink, assignedCustomerName, kind, data, emailJs }) {
  const content = buildSubscriptionEmailContent({
    name,
    productName,
    planLabel,
    order,
    subLink,
    assignedCustomerName,
    kind
  }, data);
  if (content.config.resendApiKey) {
    await sendViaResend({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: { 'X-Entity-Ref-ID': `subscription-${Date.now()}` },
      config: content.config
    });
    return { provider: 'resend' };
  }
  const baseParams = marketingTemplateParams(email, name, content.subject, content.text, data);
  await sendViaEmailJS({
    templateId: emailJs.marketingTemplateId || emailJs.otpTemplateId,
    templateParams: {
      ...baseParams,
      subscription_link: subLink || '',
      sub_link: subLink || '',
      link: subLink || '',
      subscription_url: subLink || ''
    },
    emailJs
  });
  return { provider: 'emailjs' };
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
    dnsRecords: getRashadtechDnsRecords(),
    dnsDomain: RASHADTECH_DNS_DOMAIN,
    dnsSteps: [
      'Add the 4 DNS records below in your rashadtech.tv DNS panel (copy each value)',
      'Do NOT add inbound-smtp unless you want to receive mail on @rashadtech.tv',
      'Wait until Resend shows rashadtech.tv as Verified (5–30 min)',
      'Resend → API Keys → create key → paste below and Save',
      'Send test email — check inbox; if spam once, mark Not spam'
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

async function sendViaResend({ to, subject, text, html, headers, config, replyTo }) {
  const cfg = config || resolveEmailConfig();
  if (!cfg.resendApiKey) throw new Error('Resend API key is not configured');
  const payload = {
    from: formatFromAddress(cfg),
    to: [String(to || '').trim().toLowerCase()],
    subject: String(subject || '').trim(),
    text: String(text || '').trim(),
    html: String(html || '').trim(),
    reply_to: replyTo || cfg.replyTo
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

function resolveSupportInbox(data, tier) {
  const settings = (data && data.siteSettings) || {};
  const retail = normalizeEnvSecret(settings.retailSupportEmail) || DEFAULT_REPLY_TO;
  const reseller = normalizeEnvSecret(settings.resellerSupportEmail) || retail;
  return tier === 'reseller' ? reseller : retail;
}

async function deliverSupportEscalationEmail({
  to,
  subject,
  message,
  customerEmail,
  customerName,
  tier,
  data
}) {
  const config = resolveEmailConfig(data);
  const inbox = to || resolveSupportInbox(data, tier);
  const who = customerName || customerEmail || 'Customer';
  const tierLabel = tier === 'reseller' ? 'Reseller' : 'Retail';
  const text = [
    `${tierLabel} support request`,
    '',
    `From: ${who}`,
    customerEmail ? `Email: ${customerEmail}` : '',
    '',
    String(message || '').trim()
  ].filter(Boolean).join('\n');
  const html = wrapEmailHtml({
    title: `${tierLabel} support request`,
    preheader: `${who} needs help`,
    bodyHtml: `
      <p style="margin:0 0 10px;font-size:13px;color:#6b7280;">Account type: <strong>${escapeHtml(tierLabel)}</strong></p>
      <p style="margin:0 0 10px;"><strong>${escapeHtml(who)}</strong>${customerEmail ? `<br><a href="mailto:${escapeHtml(customerEmail)}">${escapeHtml(customerEmail)}</a>` : ''}</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-top:12px;white-space:pre-wrap;font-size:14px;line-height:1.6;color:#111827;">${escapeHtml(String(message || '').trim())}</div>
    `,
    config
  });
  if (config.resendApiKey) {
    await sendViaResend({
      to: inbox,
      subject: subject || `[${tierLabel}] Support — ${who}`,
      text,
      html,
      headers: { 'X-Entity-Ref-ID': `support-${Date.now()}` },
      config,
      replyTo: customerEmail || config.replyTo
    });
    return { provider: 'resend', inbox };
  }
  return { provider: 'none', inbox, text };
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

async function fetchResendDomainStatus(data) {
  const config = resolveEmailConfig(data);
  if (!config.resendApiKey) {
    return { configured: false, domain: RASHADTECH_DNS_DOMAIN, status: 'no_api_key' };
  }
  const r = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${config.resendApiKey}` }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend domains check failed: ${r.status}${body ? ` — ${body}` : ''}`);
  }
  const json = await r.json().catch(() => ({}));
  const list = Array.isArray(json.data) ? json.data : [];
  const match = list.find(d => String(d.name || '').toLowerCase() === RASHADTECH_DNS_DOMAIN)
    || list.find(d => String(d.name || '').toLowerCase().includes('rashadtech'));
  if (!match) {
    return {
      configured: true,
      domain: RASHADTECH_DNS_DOMAIN,
      status: 'not_found',
      message: 'Domain rashadtech.tv not found in Resend — add it at resend.com/domains'
    };
  }
  let status = String(match.status || 'unknown').toLowerCase();
  if (status === 'pending' || status === 'not_started') {
    try {
      await fetch(`https://api.resend.com/domains/${match.id}/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}` }
      });
      const r2 = await fetch('https://api.resend.com/domains/' + match.id, {
        headers: { Authorization: `Bearer ${config.resendApiKey}` }
      });
      if (r2.ok) {
        const fresh = await r2.json().catch(() => ({}));
        if (fresh && fresh.status) status = String(fresh.status).toLowerCase();
      }
    } catch (e) {}
  }
  return {
    configured: true,
    domain: match.name || RASHADTECH_DNS_DOMAIN,
    status,
    verified: status === 'verified',
    region: match.region || 'eu-west-1',
    id: match.id || null,
    message: status === 'verified'
      ? 'Domain verified — you can send from noreply@rashadtech.tv'
      : status === 'failed'
        ? 'DNS verification failed — double-check all 4 records in your DNS panel'
        : 'Waiting for DNS — add records below and check again in a few minutes'
  };
}

module.exports = {
  buildMarketingEmailContent,
  buildOtpEmailContent,
  buildSubscriptionEmailContent,
  buildTestEmailContent,
  deliverMarketingEmail,
  deliverOtpEmail,
  deliverSubscriptionEmail,
  deliverSupportEscalationEmail,
  deliverTestEmail,
  resolveSupportInbox,
  fetchResendDomainStatus,
  getActiveEmailProvider,
  getEmailDeliverabilityStatus,
  getRashadtechDnsRecords,
  isServerEmailConfigured,
  marketingTemplateParams,
  maskSecret,
  otpTemplateParams,
  resolveEmailConfig,
  DEFAULT_FROM_ADDRESS,
  DEFAULT_FROM_NAME,
  DEFAULT_REPLY_TO
};
