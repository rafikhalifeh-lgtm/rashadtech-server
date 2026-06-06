const crypto = require('crypto');

const SESSIONS_KEY = 'sessions';
const ACTIVITY_LOG_KEY = 'activityLog';
const SITE_SETTINGS_KEY = 'siteSettings';
const REVOKED_LINKS_KEY = 'revokedLinks';

function registerEnhancements(app, deps) {
  const {
    requireSession,
    readJsonBinRaw,
    writeJsonBinRaw,
    normalizeEmail,
    hashPassword,
    verifyPassword,
    sanitizeUser,
    safeDataForSession,
    sendTG,
    TG_ADMIN,
    encodeLinkToken,
    decodeLinkToken,
    LINK_TTL_MS,
    validateNetflixAliasPurchase,
    isNetflixStockKey,
    isNetflixFullStockKey,
    isNetflixOneUserStockKey,
    netflixAliasUsage,
    loadGmailMonitors,
    monitoredEmails,
    persistGmailMonitors,
    getInboxMaxUid,
    normalizeGmailPassword,
    describeGmailError,
    createGmailClient,
    readBackupManifest,
    createBackupSnapshot,
    sessions,
    SESSION_TTL_MS
  } = deps;

  async function appendActivity(action, details, actor = 'system') {
    try {
      const data = await readJsonBinRaw();
      const log = Array.isArray(data[ACTIVITY_LOG_KEY]) ? data[ACTIVITY_LOG_KEY] : [];
      log.unshift({
        action,
        details,
        actor,
        ts: Date.now(),
        time: new Date().toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      });
      data[ACTIVITY_LOG_KEY] = log.slice(0, 500);
      await writeJsonBinRaw(data, { backupReason: 'activity-log' });
    } catch (e) {
      console.error('Activity log error:', e.message);
    }
  }

  async function persistSessions() {
    try {
      const data = await readJsonBinRaw();
      const stored = {};
      const now = Date.now();
      for (const [token, item] of sessions.entries()) {
        if (item && now < Number(item.expiresAt || 0)) stored[token] = item;
      }
      data[SESSIONS_KEY] = stored;
      await writeJsonBinRaw(data, { backupReason: 'session-sync' });
    } catch (e) {
      console.error('Session persist error:', e.message);
    }
  }

  async function loadPersistedSessions() {
    try {
      const data = await readJsonBinRaw();
      const stored = data[SESSIONS_KEY] || {};
      const now = Date.now();
      let loaded = 0;
      for (const [token, item] of Object.entries(stored)) {
        if (item && now < Number(item.expiresAt || 0)) {
          sessions.set(token, item);
          loaded += 1;
        }
      }
      if (loaded) console.log(`Loaded ${loaded} persisted session(s)`);
    } catch (e) {
      console.error('Session load error:', e.message);
    }
  }

  function daysLeft(expiryDateStr) {
    if (!expiryDateStr) return null;
    const parts = String(expiryDateStr).split('/');
    if (parts.length !== 3) return null;
    const exp = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    exp.setHours(0, 0, 0, 0);
    return Math.round((exp - now) / (1000 * 60 * 60 * 24));
  }

  function isNetflixRenewalTarget(order) {
    if (!order || order.productId !== 'netflix' || !order.expiryDate) return false;
    const d = daysLeft(order.expiryDate);
    if (d !== 1 && d !== 2) return false;
    const plan = String(order.plan || '').toLowerCase();
    if (plan.includes('custom') || plan.includes('day')) return false;
    return !(/\b1\s*month\b/.test(plan));
  }

  function collectRenewalAlerts(data) {
    const alerts = [];
    for (const user of Array.isArray(data.users) ? data.users : []) {
      for (const order of Array.isArray(user.orders) ? user.orders : []) {
        if (isNetflixRenewalTarget(order)) alerts.push({ user, order, customer: null, days: daysLeft(order.expiryDate) });
      }
      for (const customer of Array.isArray(user.myCustomers) ? user.myCustomers : []) {
        for (const order of Array.isArray(customer.subs) ? customer.subs : []) {
          if (isNetflixRenewalTarget(order)) alerts.push({ user, order, customer, days: daysLeft(order.expiryDate) });
        }
      }
    }
    return alerts.sort((a, b) => a.days - b.days);
  }

  function placeFulfilledOrder(user, pendingOrder, account) {
    const order = {
      id: pendingOrder.id,
      product: pendingOrder.product,
      short: pendingOrder.short,
      color: pendingOrder.color,
      tc: pendingOrder.tc,
      productId: pendingOrder.productId,
      plan: pendingOrder.plan,
      price: pendingOrder.price,
      email: account.email,
      pass: account.pass,
      date: pendingOrder.date,
      expiryDate: account.expiryDate || null,
      profileName: pendingOrder.profileName || '',
      profilePin: account.profilePin || '',
      accKey: account.accKey || '',
      mainEmail: account.mainEmail || '',
      ...(account.extra ? { extra: account.extra } : {})
    };
    if (pendingOrder.assignCustId !== null && pendingOrder.assignCustId !== undefined) {
      const customer = (user.myCustomers || []).find(c => c.id === pendingOrder.assignCustId);
      if (customer) {
        order.profileName = order.profileName || customer.fname;
        customer.subs = Array.isArray(customer.subs) ? customer.subs : [];
        customer.subs.unshift(order);
        return order;
      }
    }
    user.orders = Array.isArray(user.orders) ? user.orders : [];
    user.orders.unshift(order);
    return order;
  }

  app.get('/status', async (req, res) => {
    try {
      const data = await readJsonBinRaw().catch(() => null);
      const backups = await readBackupManifest().catch(() => []);
      await loadGmailMonitors();
      res.json({
        ok: true,
        ts: Date.now(),
        storage: data && data.emergencyDb ? 'fallback' : 'primary',
        users: Array.isArray(data && data.users) ? data.users.length : 0,
        stockKeys: data && data.stock ? Object.keys(data.stock).length : 0,
        pending: Array.isArray(data && data.pending) ? data.pending.length : 0,
        gmailMonitors: Object.keys(monitoredEmails).length,
        activeSessions: sessions.size,
        backups: backups.length,
        emailjsServer: Boolean(process.env.EMAILJS_PRIVATE_KEY)
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/auth/change-password', async (req, res) => {
    const session = requireSession(req, res, ['user']);
    if (!session) return;
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Enter current password and a new password (min 6 chars).' });
    }
    try {
      const data = await readJsonBinRaw();
      const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
      if (!user || !verifyPassword(currentPassword, user.pass)) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
      user.pass = hashPassword(newPassword);
      await writeJsonBinRaw(data);
      await appendActivity('Password changed', user.email, user.email);
      res.json({ success: true });
    } catch (e) {
      res.status(503).json({ error: 'Could not change password.' });
    }
  });

  app.post('/links/revoke', async (req, res) => {
    const session = requireSession(req, res, ['admin', 'user']);
    if (!session) return;
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token required' });
    try {
      const data = await readJsonBinRaw();
      data[REVOKED_LINKS_KEY] = data[REVOKED_LINKS_KEY] || {};
      data[REVOKED_LINKS_KEY][String(token)] = { revokedAt: Date.now(), by: session.email };
      await writeJsonBinRaw(data);
      await appendActivity('Subscription link revoked', token.slice(0, 12) + '…', session.email);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Could not revoke link' });
    }
  });

  app.post('/report-issue', async (req, res) => {
    const { issueType, details, subscription, customerEmail, customerName } = req.body || {};
    if (!issueType) return res.status(400).json({ error: 'Issue type required' });
    const lines = [
      '⚠️ <b>Customer Issue Report</b>',
      `Type: <b>${issueType}</b>`,
      customerName ? `Customer: ${customerName}` : '',
      customerEmail ? `Email: ${customerEmail}` : '',
      subscription && subscription.product ? `Product: ${subscription.product} · ${subscription.plan || ''}` : '',
      subscription && subscription.email ? `Sub email: <code>${subscription.email}</code>` : '',
      details ? `Details: ${details}` : ''
    ].filter(Boolean);
    await sendTG(TG_ADMIN, lines.join('\n'), 'HTML').catch(() => {});
    await appendActivity('Issue reported', `${issueType}${customerEmail ? ' — ' + customerEmail : ''}`, customerEmail || 'guest');
    res.json({ success: true });
  });

  app.get('/site-settings', async (req, res) => {
    try {
      const data = await readJsonBinRaw();
      res.json({ success: true, settings: data[SITE_SETTINGS_KEY] || {} });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/admin/site-settings', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      data[SITE_SETTINGS_KEY] = { ...(data[SITE_SETTINGS_KEY] || {}), ...(req.body || {}) };
      await writeJsonBinRaw(data);
      await appendActivity('Site settings updated', Object.keys(req.body || {}).join(', '), session.email);
      res.json({ success: true, settings: data[SITE_SETTINGS_KEY] });
    } catch (e) {
      res.status(500).json({ error: 'Could not save settings' });
    }
  });

  app.get('/admin/activity', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      res.json({ success: true, activity: (data[ACTIVITY_LOG_KEY] || []).slice(0, 200) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/admin/analytics', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const users = Array.isArray(data.users) ? data.users : [];
      const pending = Array.isArray(data.pending) ? data.pending : [];
      const stock = data.stock || {};
      let stockAccounts = 0;
      let stockAvailable = 0;
      for (const accounts of Object.values(stock)) {
        for (const account of Array.isArray(accounts) ? accounts : []) {
          stockAccounts += 1;
          if (!account.used) stockAvailable += 1;
        }
      }
      const purchases = users.reduce((sum, u) => sum + (Array.isArray(u.orders) ? u.orders.length : 0), 0);
      const revenue = users.reduce((sum, u) => sum + (Array.isArray(u.transactions) ? u.transactions.filter(t => t.type === 'purchase').reduce((s, t) => s + Number(t.amount || 0), 0) : 0), 0);
      res.json({
        success: true,
        analytics: {
          users: users.length,
          purchases,
          revenue,
          pending: pending.length,
          stockAccounts,
          stockAvailable,
          topupRequests: Array.isArray(data.topupreqs) ? data.topupreqs.length : 0,
          gameOrders: Array.isArray(data.gameorders) ? data.gameorders.length : 0
        }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/admin/netflix-aliases', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const map = {};
      for (const [key, accounts] of Object.entries(data.stock || {})) {
        if (!isNetflixStockKey(key)) continue;
        for (const account of Array.isArray(accounts) ? accounts : []) {
          const alias = normalizeEmail(account.email);
          if (!alias) continue;
          if (!map[alias]) map[alias] = { alias, oneUser: 0, full: 0, usedOneUser: 0, usedFull: 0 };
          if (isNetflixFullStockKey(key)) {
            map[alias].full += 1;
            if (account.used) map[alias].usedFull += 1;
          }
          if (isNetflixOneUserStockKey(key)) {
            map[alias].oneUser += 1;
            if (account.used) map[alias].usedOneUser += 1;
          }
        }
      }
      res.json({ success: true, aliases: Object.values(map).sort((a, b) => a.alias.localeCompare(b.alias)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/admin/gmail-test', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
      await loadGmailMonitors();
      const creds = monitoredEmails[email];
      if (!creds) return res.status(404).json({ error: 'Gmail monitor not found' });
      await getInboxMaxUid(creds.user || email, creds.pass);
      creds.lastCheckedAt = Date.now();
      await persistGmailMonitors();
      res.json({ success: true, message: 'Gmail connection OK', email, lastCheckedAt: creds.lastCheckedAt });
    } catch (e) {
      res.status(400).json({ success: false, error: describeGmailError(e) });
    }
  });

  app.post('/admin/bulk-stock', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { skey, rows } = req.body || {};
    if (!skey || !Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Stock key and rows required' });
    try {
      const data = await readJsonBinRaw();
      data.stock = data.stock || {};
      data.stock[skey] = Array.isArray(data.stock[skey]) ? data.stock[skey] : [];
      let added = 0;
      const errors = [];
      for (const row of rows) {
        const email = String(row.email || '').trim();
        const pass = String(row.pass || '').trim();
        if (!email || !pass) continue;
        const usage = netflixAliasUsage(data, email);
        if (isNetflixOneUserStockKey(skey) && usage.oneUser >= 5) {
          errors.push(`${email}: alias already has 5 one-user slots`);
          continue;
        }
        if (isNetflixFullStockKey(skey) && (usage.full > 0 || usage.oneUser > 0)) {
          errors.push(`${email}: alias already reserved`);
          continue;
        }
        const aliasError = validateNetflixAliasPurchase(data, skey, { email });
        if (aliasError) {
          errors.push(`${email}: ${aliasError}`);
          continue;
        }
        const acc = {
          email,
          pass,
          extra: row.extra || '',
          expiryDate: row.expiryDate || '',
          used: false,
          accKey: `${skey}__${Date.now()}_${added}`,
          profilePin: row.profilePin || '',
          mainEmail: row.mainEmail || ''
        };
        data.stock[skey].push(acc);
        added += 1;
      }
      await writeJsonBinRaw(data);
      await appendActivity('Bulk stock import', `${added} added to ${skey}`, session.email);
      res.json({ success: true, added, errors });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/admin/export-orders', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const rows = [['type', 'id', 'customer', 'email', 'product', 'plan', 'price', 'date', 'status']];
      for (const user of Array.isArray(data.users) ? data.users : []) {
        for (const order of Array.isArray(user.orders) ? user.orders : []) {
          rows.push(['order', order.id || '', user.name || '', user.email || '', order.product || '', order.plan || '', order.price || '', order.date || '', 'delivered']);
        }
      }
      for (const po of Array.isArray(data.pending) ? data.pending : []) {
        rows.push(['pending', po.id || '', po.userName || '', po.userEmail || '', po.product || '', po.plan || '', po.price || '', po.date || '', 'pending']);
      }
      const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="rashadtech-orders.csv"');
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/admin/fulfill-pending', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });
    try {
      const data = await readJsonBinRaw();
      data.pending = Array.isArray(data.pending) ? data.pending : [];
      data.users = Array.isArray(data.users) ? data.users : [];
      data.stock = data.stock || {};
      const idx = data.pending.findIndex(o => o.id === orderId);
      if (idx < 0) return res.status(404).json({ error: 'Pending order not found' });
      const po = data.pending[idx];
      const accounts = data.stock[po.skey] || [];
      const acc = accounts.find(a => !a.used);
      if (!acc) return res.status(409).json({ error: 'No stock available for this plan' });
      const aliasError = validateNetflixAliasPurchase(data, po.skey, acc);
      if (aliasError) return res.status(409).json({ error: aliasError });
      acc.used = true;
      const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(po.userEmail));
      const order = user ? placeFulfilledOrder(user, po, acc) : null;
      data.pending.splice(idx, 1);
      await writeJsonBinRaw(data);
      if (user && user.tgChatId) {
        await sendTG(user.tgChatId, `✅ <b>Your ${po.product} is ready!</b>\n\n📋 ${po.plan}\n📧 <code>${acc.email}</code>\n🔑 <code>${acc.pass}</code>${acc.profilePin ? `\n🔢 PIN: <code>${acc.profilePin}</code>` : ''}`, 'HTML').catch(() => {});
      }
      await appendActivity('Pending order fulfilled', orderId, session.email);
      res.json({ success: true, order, user: sanitizeUser(user), data: safeDataForSession(data, { role: 'admin' }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/customer/renew-request', async (req, res) => {
    const session = requireSession(req, res, ['user']);
    if (!session) return;
    const { orderId, product, plan, expiryDate } = req.body || {};
    try {
      const data = await readJsonBinRaw();
      const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
      await sendTG(TG_ADMIN, `🔄 <b>Renewal Request</b>\n👤 ${user && user.name || session.email}\n📧 ${session.email}\n📦 ${product || ''} · ${plan || ''}\n📅 Expires: ${expiryDate || '—'}\nOrder: ${orderId || '—'}`, 'HTML');
      if (user && user.tgChatId) {
        await sendTG(user.tgChatId, `✅ Your renewal request for <b>${product || 'subscription'}</b> was sent to support.`, 'HTML').catch(() => {});
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  let lastRenewalAlertDay = '';
  let lastExpiryCustomerDay = '';
  let lastBackupNotifyDay = '';

  async function runRenewalAlerts() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (lastRenewalAlertDay === today) return;
      const data = await readJsonBinRaw();
      const alerts = collectRenewalAlerts(data);
      if (!alerts.length) return;
      const lines = alerts.slice(0, 15).map(a => {
        const who = a.customer ? `${a.customer.fname} (${a.user.name})` : `${a.user.name}`;
        return `• ${a.days}d — ${who} — ${a.order.plan} — ${a.order.email}`;
      });
      await sendTG(TG_ADMIN, `🍿 <b>Netflix renewals due (1-2 days)</b>\n\n${lines.join('\n')}`, 'HTML');
      lastRenewalAlertDay = today;
    } catch (e) {
      console.error('Renewal alert error:', e.message);
    }
  }

  async function runCustomerExpiryAlerts() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (lastExpiryCustomerDay === today) return;
      const data = await readJsonBinRaw();
      for (const user of Array.isArray(data.users) ? data.users : []) {
        if (!user.tgChatId) continue;
        const soon = (user.orders || []).filter(o => {
          const d = daysLeft(o.expiryDate);
          return d !== null && d >= 0 && d <= 3;
        });
        if (!soon.length) continue;
        const lines = soon.map(o => `• ${o.product} · ${o.plan} — ${daysLeft(o.expiryDate)} day(s) left`).join('\n');
        await sendTG(user.tgChatId, `⏰ <b>Subscription expiring soon</b>\n\n${lines}\n\nOpen rashadtech.tv to renew.`, 'HTML').catch(() => {});
      }
      lastExpiryCustomerDay = today;
    } catch (e) {
      console.error('Customer expiry alert error:', e.message);
    }
  }

  async function runDailyBackupSummary() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (lastBackupNotifyDay === today) return;
      const data = await readJsonBinRaw();
      const backup = await createBackupSnapshot(data, 'daily-auto').catch(() => null);
      const backups = await readBackupManifest().catch(() => []);
      await sendTG(TG_ADMIN, `🛡️ <b>Daily backup OK</b>\nUsers: ${(data.users || []).length}\nStock accounts: ${Object.values(data.stock || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0)}\nPending: ${(data.pending || []).length}\nBackups stored: ${backups.length}${backup ? `\nLatest: ${backup.id}` : ''}`, 'HTML').catch(() => {});
      lastBackupNotifyDay = today;
    } catch (e) {
      console.error('Daily backup summary error:', e.message);
    }
  }

  setInterval(() => {
    runRenewalAlerts().catch(() => {});
    runCustomerExpiryAlerts().catch(() => {});
    runDailyBackupSummary().catch(() => {});
  }, 60 * 60 * 1000);

  setInterval(() => {
    persistSessions().catch(() => {});
  }, 5 * 60 * 1000);

  return {
    loadPersistedSessions,
    persistSessions,
    appendActivity,
    isLinkRevoked: async token => {
      const data = await readJsonBinRaw().catch(() => ({}));
      return Boolean(data[REVOKED_LINKS_KEY] && data[REVOKED_LINKS_KEY][token]);
    },
    REVOKED_LINKS_KEY,
    SESSIONS_KEY,
    SITE_SETTINGS_KEY,
    ACTIVITY_LOG_KEY
  };
}

module.exports = { registerEnhancements };
