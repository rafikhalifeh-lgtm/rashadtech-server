const crypto = require('crypto');
const {
  PRICE_CATALOG_KEY,
  RETAIL_PRICE_CATALOG_KEY,
  RETAIL_DEFAULTS_VERSION,
  getMergedCatalog,
  getResellerCatalog,
  mergeRetailPriceCatalog,
  getCatalogForUser,
  userIsReseller,
  mergePriceCatalog,
  buildCatalogPayload,
  clearStaleRetailPriceCatalog
} = require('./priceCatalog');
const {
  markLinkedStockSold,
  stockAccountsForPlan,
  stampOrderDelivery,
  pushStatusHistory,
  findOwnerForStockAccount,
  collectLowStockItems,
  diffPriceCatalog,
  pendingAgeMs,
  formatBeirutTime
} = require('./orderHelpers');
const {
  deliverSupportEscalationEmail,
  resolveSupportInbox
} = require('./emailDelivery');
const { getPublicSmsCatalogFromData } = require('./smsCatalogPublic');

const PRICE_CHANGE_LOG_KEY = 'priceChangeLog';
const LOW_STOCK_THRESHOLD = 2;

const SESSIONS_KEY = 'sessions';
const ACTIVITY_LOG_KEY = 'activityLog';
const SITE_SETTINGS_KEY = 'siteSettings';
const REVOKED_LINKS_KEY = 'revokedLinks';

function registerEnhancements(app, deps) {
  const {
    requireSession,
    getSession,
    readJsonBinRaw,
    writeJsonBinRaw,
    writeDbFast,
    normalizeEmail,
    hashPassword,
    verifyPassword,
    sanitizeUser,
    safeDataForSession,
    slimMutationData,
    readDbForWrite,
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
    countStockStats,
    sessions,
    SESSION_TTL_MS,
    findUserOrderRecord,
    notifyPurchaseFulfilled,
    pickAvailableAccount,
    enqueueDbWrite,
    repairGmailMonitorFromStock
  } = deps;

  const activeFulfillOrders = new Set();

  async function persistOrderDeliveryStamp(user, orderId, deliveryChannel) {
    if (!deliveryChannel || !user || !orderId) return;
    await enqueueDbWrite(async () => {
      const fresh = await readDbForWrite();
      const liveUser = (fresh.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(user.email));
      if (liveUser) {
        const { order: liveOrder } = findUserOrderRecord(liveUser, orderId);
        if (liveOrder) stampOrderDelivery(liveOrder, deliveryChannel);
      }
      await writeDbFast(fresh);
    }).catch(() => {});
  }

  async function appendActivity(action, details, actor = 'system') {
    try {
      const data = await readJsonBinRaw();
      const log = Array.isArray(data[ACTIVITY_LOG_KEY]) ? data[ACTIVITY_LOG_KEY] : [];
      log.unshift({
        action,
        details,
        actor,
        ts: Date.now(),
        time: formatBeirutTime()
      });
      data[ACTIVITY_LOG_KEY] = log.slice(0, 500);
      await writeJsonBinRaw(data, { backupReason: 'activity-log' });
    } catch (e) {
      console.error('Activity log error:', e.message);
    }
  }

  async function readDataWithRetailMigration(options = {}) {
    const data = await readJsonBinRaw(options);
    if (clearStaleRetailPriceCatalog(data)) {
      await writeJsonBinRaw(data, { backupReason: 'retail-catalog-migration' });
      await appendActivity('Retail prices migrated', `Cleared stale overrides (v${RETAIL_DEFAULTS_VERSION})`);
    }
    return data;
  }

  async function persistSessions() {
    try {
      const data = await readJsonBinRaw({ fast: true });
      const stored = {};
      const now = Date.now();
      for (const [token, item] of sessions.entries()) {
        if (item && now < Number(item.expiresAt || 0)) stored[token] = item;
      }
      data[SESSIONS_KEY] = stored;
      await writeDbFast(data, { backupReason: 'session-sync' });
    } catch (e) {
      console.error('Session persist error:', e.message);
    }
  }

  async function loadPersistedSessions() {
    try {
      const data = await readJsonBinRaw({ fast: true });
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

  function placeExternalFulfilledOrder(user, pendingOrder, details = {}) {
    const assignedCustomer = pendingOrder.assignCustId !== null && pendingOrder.assignCustId !== undefined
      ? (user.myCustomers || []).find(c => c.id === pendingOrder.assignCustId)
      : null;
    const email = String(details.email || pendingOrder.customerCanvaEmail || '').trim();
    const pass = String(details.pass || '').trim();
    const serviceLink = String(details.serviceLink || pendingOrder.serviceLink || '').trim();
    const expiryDate = String(details.expiryDate || pendingOrder.expiryDate || '').trim() || null;
    const order = {
      id: pendingOrder.id,
      product: pendingOrder.product,
      short: pendingOrder.short,
      color: pendingOrder.color,
      tc: pendingOrder.tc,
      productId: pendingOrder.productId,
      plan: pendingOrder.plan,
      price: pendingOrder.price,
      email,
      pass,
      date: pendingOrder.date,
      expiryDate,
      profileName: pendingOrder.profileName || '',
      profilePin: '',
      serviceLink,
      accKey: '',
      mainEmail: '',
      fulfilledExternally: true,
      externalNote: String(details.note || '').trim() || undefined
    };
    if (assignedCustomer) {
      order.profileName = order.profileName || assignedCustomer.fname;
      assignedCustomer.subs = Array.isArray(assignedCustomer.subs) ? assignedCustomer.subs : [];
      assignedCustomer.subs.unshift(order);
      return order;
    }
    user.orders = Array.isArray(user.orders) ? user.orders : [];
    user.orders.unshift(order);
    return order;
  }

  function placeFulfilledOrder(user, pendingOrder, account, stock) {
    const assignedCustomer = pendingOrder.assignCustId !== null && pendingOrder.assignCustId !== undefined
      ? (user.myCustomers || []).find(c => c.id === pendingOrder.assignCustId)
      : null;
    markLinkedStockSold(stock, account, {
      userEmail: user.email,
      userName: user.name,
      orderId: pendingOrder.id,
      assignCustId: assignedCustomer ? assignedCustomer.id : null,
      assignCustName: assignedCustomer ? `${assignedCustomer.fname || ''} ${assignedCustomer.lname || ''}`.trim() : ''
    }, pendingOrder.skey);
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
      ...(account.phone ? { phone: account.phone } : {}),
      date: pendingOrder.date,
      expiryDate: account.expiryDate || null,
      profileName: pendingOrder.profileName || account.profileName || account.extra || '',
      profilePin: account.profilePin || '',
      serviceLink: pendingOrder.serviceLink || account.serviceLink || '',
      accKey: account.accKey || '',
      mainEmail: account.mainEmail || ''
    };
    if (assignedCustomer) {
      order.profileName = order.profileName || assignedCustomer.fname;
      assignedCustomer.subs = Array.isArray(assignedCustomer.subs) ? assignedCustomer.subs : [];
      assignedCustomer.subs.unshift(order);
      return order;
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
    const session = getSession(req);
    const { issueType, details, subscription, customerEmail, customerName } = req.body || {};
    if (!issueType) return res.status(400).json({ error: 'Issue type required' });
    try {
      const data = await readJsonBinRaw({ fast: true });
      const user = session && session.role === 'user'
        ? (data.users || []).find(u => normalizeEmail(u.email) === session.email)
        : null;
      const tier = user ? (userIsReseller(user) ? 'reseller' : 'retail') : 'retail';
      const tierEmoji = tier === 'reseller' ? '🏪' : '🛍';
      const email = customerEmail || (user && user.email) || '';
      const name = customerName || (user && user.name) || email || 'Customer';
      const lines = [
        `${tierEmoji} <b>${tier === 'reseller' ? 'Reseller' : 'Retail'} issue report</b>`,
        `Type: <b>${issueType}</b>`,
        name ? `Customer: ${name}` : '',
        email ? `Email: ${email}` : '',
        subscription && subscription.product ? `Product: ${subscription.product} · ${subscription.plan || ''}` : '',
        subscription && subscription.email ? `Sub email: <code>${subscription.email}</code>` : '',
        details ? `Details: ${details}` : ''
      ].filter(Boolean);
      const inbox = resolveSupportInbox(data, tier);
      await deliverSupportEscalationEmail({
        to: inbox,
        subject: `[${tier === 'reseller' ? 'Reseller' : 'Retail'}] Issue — ${issueType}`,
        message: lines.join('\n'),
        customerEmail: email,
        customerName: name,
        tier,
        data
      }).catch(e => console.error('Report issue email error:', e.message));
      await sendTG(TG_ADMIN, lines.join('\n') + `\n📥 Inbox: <code>${inbox}</code>`, 'HTML').catch(() => {});
      await appendActivity('Issue reported', `${tier} — ${issueType}${email ? ' — ' + email : ''}`, email || 'guest');
      res.json({ success: true, tier });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not report issue' });
    }
  });

  app.get('/site-settings', async (req, res) => {
    try {
      const data = await readJsonBinRaw();
      const settings = { ...(data[SITE_SETTINGS_KEY] || {}) };
      delete settings.resendApiKey;
      res.json({ success: true, settings });
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
      const settings = { ...data[SITE_SETTINGS_KEY] };
      delete settings.resendApiKey;
      await writeJsonBinRaw(data);
      await appendActivity('Site settings updated', Object.keys(req.body || {}).join(', '), session.email);
      res.json({ success: true, settings });
    } catch (e) {
      res.status(500).json({ error: 'Could not save settings' });
    }
  });

  app.get('/catalog/prices', async (req, res) => {
    try {
      const data = await readDataWithRetailMigration({ fast: true, skipRecoverWrite: true });
      const tier = String(req.query.tier || '').toLowerCase();
      if (tier === 'reseller') {
        const header = req.get('authorization') || '';
        const match = header.match(/^Bearer\s+(.+)$/i);
        const token = match ? match[1] : '';
        const session = token ? sessions.get(token) : null;
        if (!session || (session.role !== 'admin' && session.role !== 'user')) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        if (session.role === 'user') {
          const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
          if (!user || !userIsReseller(user)) {
            return res.status(403).json({ error: 'Reseller catalog requires a reseller account' });
          }
        }
        return res.json({ success: true, catalog: getResellerCatalog(data), tier: 'reseller' });
      }
      if (tier === 'retail') {
        return res.json({ success: true, catalog: mergeRetailPriceCatalog(data), tier: 'retail' });
      }
      const header = req.get('authorization') || '';
      const match = header.match(/^Bearer\s+(.+)$/i);
      const token = match ? match[1] : '';
      const session = token ? sessions.get(token) : null;
      if (session && session.role === 'user') {
        const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
        const catalog = getCatalogForUser(data, user);
        return res.json({ success: true, catalog, tier: catalog.tier || (userIsReseller(user) ? 'reseller' : 'retail'), isReseller: userIsReseller(user) });
      }
      res.json({ success: true, catalog: mergeRetailPriceCatalog(data), tier: 'retail', isReseller: false });
    } catch (e) {
      res.status(500).json({ error: 'Could not load prices' });
    }
  });

  app.get('/catalog/storefront', async (req, res) => {
    try {
      const data = await readDataWithRetailMigration({ fast: true });
      const stockCounts = {};
      for (const [key, accounts] of Object.entries(data.stock || {})) {
        stockCounts[key] = (accounts || []).filter(acc => acc && !acc.used).length;
      }
      res.json({
        success: true,
        catalog: mergeRetailPriceCatalog(data),
        catalogVersion: RETAIL_DEFAULTS_VERSION,
        tier: 'retail',
        stockCounts,
        stockBlocks: data.retailStockBlocks || {},
        retailStockBlocks: data.retailStockBlocks || {},
        sms: getPublicSmsCatalogFromData(data)
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not load storefront' });
    }
  });

  app.get('/admin/prices', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readDataWithRetailMigration();
      res.json({
        success: true,
        catalog: getResellerCatalog(data),
        retailCatalog: mergeRetailPriceCatalog(data),
        tier: 'reseller'
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not load prices' });
    }
  });

  app.post('/admin/retail-prices', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const payload = buildCatalogPayload(req.body || {});
      const data = await readJsonBinRaw();
      data[RETAIL_PRICE_CATALOG_KEY] = {
        ...payload,
        defaultsVersion: RETAIL_DEFAULTS_VERSION,
        updatedAt: Date.now(),
        updatedBy: session.email
      };
      await writeJsonBinRaw(data);
      await appendActivity('Retail prices updated', `${Object.keys(payload.prices).length} override(s)`, session.email);
      res.json({ success: true, catalog: mergeRetailPriceCatalog(data) });
    } catch (e) {
      res.status(500).json({ error: 'Could not save retail prices' });
    }
  });

  app.post('/admin/retail-prices/reset', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      delete data[RETAIL_PRICE_CATALOG_KEY];
      await writeJsonBinRaw(data);
      await appendActivity('Retail prices reset', `Official Lebanon defaults (v${RETAIL_DEFAULTS_VERSION}, Netflix +40%)`, session.email);
      res.json({ success: true, catalog: mergeRetailPriceCatalog(data) });
    } catch (e) {
      res.status(500).json({ error: 'Could not reset retail prices' });
    }
  });

  app.post('/admin/toggle-reseller', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { email, isReseller } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail || typeof isReseller !== 'boolean') {
      return res.status(400).json({ error: 'email and isReseller are required' });
    }
    try {
      const data = await readJsonBinRaw();
      const user = (data.users || []).find(u => normalizeEmail(u.email) === cleanEmail);
      if (!user) return res.status(404).json({ error: 'Customer not found' });
      user.isReseller = isReseller;
      await writeJsonBinRaw(data);
      await appendActivity(
        isReseller ? 'Reseller approved' : 'Reseller removed',
        cleanEmail,
        session.email
      );
      if (user.tgChatId) {
        const msg = isReseller
          ? '🏪 <b>Reseller account activated!</b>\n\nYou now see wholesale prices on rashadtech.tv. Sign out and sign in again if prices do not update.'
          : '🛍 <b>Account updated</b>\n\nYour account now uses retail customer prices on rashadtech.tv.';
        await sendTG(user.tgChatId, msg, 'HTML').catch(() => {});
      }
      res.json({ success: true, user: sanitizeUser(user, { admin: true }), data: safeDataForSession(data, { role: 'admin' }) });
    } catch (e) {
      res.status(500).json({ error: 'Could not update reseller status' });
    }
  });

  app.post('/admin/bulk-tier', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { isReseller, onlyLegacy, emails } = req.body || {};
    if (typeof isReseller !== 'boolean') {
      return res.status(400).json({ error: 'isReseller (true/false) is required' });
    }
    try {
      const data = await readJsonBinRaw();
      const emailSet = Array.isArray(emails) && emails.length
        ? new Set(emails.map(e => normalizeEmail(e)).filter(Boolean))
        : null;
      let updated = 0;
      for (const user of data.users || []) {
        const clean = normalizeEmail(user.email);
        if (!clean) continue;
        if (emailSet && !emailSet.has(clean)) continue;
        if (onlyLegacy && user.isReseller !== undefined) continue;
        if (user.isReseller === isReseller) continue;
        user.isReseller = isReseller;
        updated += 1;
      }
      await writeJsonBinRaw(data);
      await appendActivity(
        isReseller ? 'Bulk reseller tier' : 'Bulk retail tier',
        `${updated} account${updated !== 1 ? 's' : ''}${onlyLegacy ? ' (legacy only)' : ''}`,
        session.email
      );
      res.json({
        success: true,
        updated,
        data: safeDataForSession(data, { role: 'admin' })
      });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not update account tiers' });
    }
  });

  app.post('/admin/prices', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const payload = buildCatalogPayload(req.body || {});
      const data = await readJsonBinRaw();
      const previous = getMergedCatalog(data);
      const changes = diffPriceCatalog(previous, payload);
      data[PRICE_CATALOG_KEY] = {
        ...payload,
        updatedAt: Date.now(),
        updatedBy: session.email
      };
      if (changes.length) {
        const log = Array.isArray(data[PRICE_CHANGE_LOG_KEY]) ? data[PRICE_CHANGE_LOG_KEY] : [];
        log.unshift({
          ts: Date.now(),
          actor: session.email,
          changes: changes.slice(0, 200)
        });
        data[PRICE_CHANGE_LOG_KEY] = log.slice(0, 100);
      }
      await writeJsonBinRaw(data);
      await appendActivity('Prices updated', `${changes.length || Object.keys(payload.prices).length} price change(s)`, session.email);
      res.json({ success: true, catalog: getMergedCatalog(data), changes: changes.length });
    } catch (e) {
      res.status(500).json({ error: 'Could not save prices' });
    }
  });

  app.get('/admin/price-change-log', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      res.json({ success: true, log: (data[PRICE_CHANGE_LOG_KEY] || []).slice(0, 50) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/admin/assign-stock', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { skey, accKey, userEmail, assignCustId, notifyTelegram } = req.body || {};
    if (!skey || !accKey || !userEmail) return res.status(400).json({ error: 'skey, accKey, and userEmail are required' });
    try {
      const data = await readJsonBinRaw();
      data.stock = data.stock || {};
      data.users = Array.isArray(data.users) ? data.users : [];
      const accounts = data.stock[skey] || [];
      const acc = accounts.find(a => a && a.accKey === accKey && !a.used);
      if (!acc) return res.status(404).json({ error: 'Available stock account not found' });
      if (isNetflixStockKey(skey) && !acc.email) {
        return res.status(400).json({ error: 'Netflix stock must have an email before assignment' });
      }
      const aliasError = validateNetflixAliasPurchase(data, skey, acc);
      if (aliasError) return res.status(409).json({ error: aliasError });
      const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(userEmail));
      if (!user) return res.status(404).json({ error: 'Customer not found' });
      const assignedCustomer = assignCustId != null
        ? (user.myCustomers || []).find(c => c.id === assignCustId)
        : null;
      const parts = String(skey).split('__');
      const prod = productsLabelFromKey(parts);
      const dateStr = formatBeirutTime();
      const orderId = '#' + (Math.floor(Math.random() * 90000 + 10000));
      markLinkedStockSold(data.stock, acc, {
        userEmail: user.email,
        userName: user.name,
        orderId,
        assignCustId: assignedCustomer ? assignedCustomer.id : null,
        assignCustName: assignedCustomer ? `${assignedCustomer.fname || ''} ${assignedCustomer.lname || ''}`.trim() : ''
      }, skey);
      const order = {
        id: orderId,
        product: prod.name,
        short: prod.short,
        color: prod.color,
        tc: prod.tc,
        productId: prod.id,
        plan: prod.plan,
        price: 0,
        email: acc.email,
        pass: acc.pass,
        date: dateStr,
        expiryDate: acc.expiryDate || null,
        profileName: accountProfileName(acc) || (assignedCustomer ? assignedCustomer.fname : ''),
        profilePin: acc.profilePin || '',
        accKey: acc.accKey || '',
        mainEmail: acc.mainEmail || '',
        assignedByAdmin: true
      };
      if (assignedCustomer) {
        assignedCustomer.subs = Array.isArray(assignedCustomer.subs) ? assignedCustomer.subs : [];
        assignedCustomer.subs.unshift(order);
      } else {
        user.orders = Array.isArray(user.orders) ? user.orders : [];
        user.orders.unshift(order);
      }
      let deliveryChannel = false;
      if (notifyTelegram !== false && user) {
        const product = {
          name: order.product,
          short: order.short,
          color: order.color,
          tc: order.tc,
          id: order.productId
        };
        if (typeof notifyPurchaseFulfilled === 'function') {
          deliveryChannel = await notifyPurchaseFulfilled(
            user,
            product,
            order.plan,
            order.price || 0,
            order,
            assignedCustomer ? assignedCustomer.id : null,
            { skipAdminNotify: true, data }
          );
        } else if (user.tgChatId) {
          deliveryChannel = 'telegram';
          await sendTG(user.tgChatId, `✅ <b>Subscription assigned</b>\n\n📦 ${order.product} · ${order.plan}\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>${order.expiryDate ? `\n📅 Expires: ${order.expiryDate}` : ''}`, 'HTML').catch(() => {});
        }
      }
      stampOrderDelivery(order, deliveryChannel || false);
      await writeJsonBinRaw(data);
      await appendActivity('Stock assigned', `${user.email} · ${order.product}`, session.email);
      res.json({ success: true, order, user: sanitizeUser(user), data: safeDataForSession(data, session) });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not assign stock' });
    }
  });

  function productsLabelFromKey(parts) {
    const id = parts[0] || 'subscription';
    const names = {
      netflix: { name: 'Netflix', short: 'N', color: '#E50914', tc: '#fff', id: 'netflix' },
      shahid: { name: 'Shahid VIP', short: 'ش', color: '#1B75BC', tc: '#fff', id: 'shahid' },
      osn: { name: 'OSN+', short: 'OSN', color: '#111', tc: '#fff', id: 'osn' },
      disney: { name: 'Disney+', short: 'D+', color: '#113CCF', tc: '#fff', id: 'disney' },
      ytpremium: { name: 'YouTube Premium', short: 'YT+', color: '#FF0000', tc: '#fff', id: 'ytpremium' },
      chatgpt: { name: 'ChatGPT Plus', short: 'GPT', color: '#10A37F', tc: '#fff', id: 'chatgpt' },
      canva: { name: 'Canva Pro', short: 'CV', color: '#00C4CC', tc: '#fff', id: 'canva' },
      linkedin: { name: 'LinkedIn Premium', short: 'in', color: '#0A66C2', tc: '#fff', id: 'linkedin' },
      watchit: { name: 'Watchit', short: 'W+', color: '#6C2BD9', tc: '#fff', id: 'watchit' },
      roblox: { name: 'Roblox', short: 'RBL', color: '#E2231A', tc: '#fff', id: 'roblox' },
      freefire: { name: 'Free Fire', short: 'FF', color: '#FF6B00', tc: '#fff', id: 'freefire' },
      itunes: { name: 'iTunes / App Store', short: '', color: '#555', tc: '#fff', id: 'itunes' },
      googleplay: { name: 'Google Play', short: 'GP', color: '#34A853', tc: '#fff', id: 'googleplay' }
    };
    const base = names[id] || { name: id, short: id.slice(0, 2).toUpperCase(), color: '#555', tc: '#fff', id };
    let plan = parts.slice(1).join(' · ').replace(/__/g, ' · ') || 'Assigned';
    return { ...base, plan };
  }

  function accountProfileName(acc) {
    return String(acc?.profileName || acc?.extra || '').trim();
  }

  app.post('/admin/game-order-status', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { orderId, status } = req.body || {};
    const allowed = ['pending', 'processing', 'done', 'cancelled'];
    if (!orderId || !allowed.includes(status)) return res.status(400).json({ error: 'Invalid order or status' });
    try {
      const data = await readJsonBinRaw();
      data.gameorders = Array.isArray(data.gameorders) ? data.gameorders : [];
      const order = data.gameorders.find(o => o && o.id === orderId);
      if (!order) return res.status(404).json({ error: 'Game order not found' });
      pushStatusHistory(order, status);
      if (status === 'done') order.fulfilledAt = Date.now();
      const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(order.userEmail));
      if (user && Array.isArray(user.transactions)) {
        user.transactions.forEach(t => {
          if (t.orderId === order.id) t.pending = status !== 'done';
        });
      }
      const credLine = order.playerPassword
        ? `👤 ${order.playerId}\n🔑 ${order.playerPassword}`
        : `🆔 ${order.playerId}`;
      if (status === 'processing' && user?.tgChatId) {
        await sendTG(user.tgChatId, `🎮 <b>Order processing</b>\n\n${order.product} · ${order.plan}\n${credLine}\n\nWe are working on your order now.`, 'HTML').catch(() => {});
      }
      if (status === 'done' && user?.tgChatId) {
        await sendTG(user.tgChatId, `✅ <b>Order complete!</b>\n\n${order.product} · ${order.plan}\n${credLine}\n\nThank you for your order! 🎉`, 'HTML').catch(() => {});
      }
      await writeJsonBinRaw(data);
      await appendActivity('Game order updated', `${orderId} → ${status}`, session.email);
      res.json({ success: true, order, data: safeDataForSession(data, session) });
    } catch (e) {
      res.status(500).json({ error: e.message });
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
      let oldestPendingMs = 0;
      let oldestPending = null;
      pending.forEach(po => {
        const age = pendingAgeMs(po);
        if (age > oldestPendingMs) {
          oldestPendingMs = age;
          oldestPending = { id: po.id, product: po.product, plan: po.plan, userName: po.userName, ageMs: age };
        }
      });
      const lowStock = collectLowStockItems(stock, LOW_STOCK_THRESHOLD);
      const productRequestsOpen = (Array.isArray(data.requests) ? data.requests : []).filter(r => r && !r.resolved).length;
      res.json({
        success: true,
        analytics: {
          users: users.length,
          purchases,
          revenue,
          pending: pending.length,
          productRequestsOpen,
          oldestPendingMs,
          oldestPending,
          pendingSlaBreached: oldestPendingMs > 24 * 60 * 60 * 1000,
          lowStockCount: lowStock.length,
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
      await loadGmailMonitors(true);
      let creds = monitoredEmails[email];
      if (!creds) {
        const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
        const repaired = repairGmailMonitorFromStock(data, email);
        if (repaired) {
          monitoredEmails[email] = repaired;
          creds = repaired;
          await persistGmailMonitors();
        }
      }
      if (!creds) {
        return res.status(404).json({
          error: 'Gmail monitor not found. Open the stock account, re-enter the Gmail app password in Main Gmail, and save again.'
        });
      }
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
          profileName: row.profileName || row.profile || row.extra || '',
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

  app.get('/admin/pending', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
      res.json({ success: true, pending: Array.isArray(data.pending) ? data.pending : [] });
    } catch (e) {
      res.status(500).json({ error: 'Could not load pending orders' });
    }
  });

  app.post('/admin/fulfill-pending-batch', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { skey, orderIds } = req.body || {};
    const idList = Array.isArray(orderIds) ? orderIds.filter(Boolean) : [];
    if (!skey && !idList.length) {
      return res.status(400).json({ error: 'skey or orderIds required' });
    }
    try {
      const outcome = await enqueueDbWrite(async () => {
        const data = await readDbForWrite();
        data.pending = Array.isArray(data.pending) ? data.pending : [];
        data.users = Array.isArray(data.users) ? data.users : [];
        data.stock = data.stock || {};
        const queue = data.pending.filter(po => {
          if (idList.length) return idList.includes(po.id);
          return String(po.skey || '') === String(skey || '');
        });
        const fulfilled = [];
        for (const po of queue) {
          const idx = data.pending.findIndex(o => o.id === po.id);
          if (idx < 0) continue;
          const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(po.userEmail));
          const existing = user ? findUserOrderRecord(user, po.id).order : null;
          if (existing && existing.email && !existing.pending) {
            data.pending.splice(idx, 1);
            continue;
          }
          const hasCharge = user && Array.isArray(user.transactions) && user.transactions.some(t => t.orderId === po.id);
          if (!hasCharge) {
            data.pending.splice(idx, 1);
            continue;
          }
          const isCanvaOwn = /^canva__own__/.test(String(po.skey || ''));
          let acc = null;
          if (isCanvaOwn) {
            const customerCanvaEmail = String(po.customerCanvaEmail || '').trim();
            if (!customerCanvaEmail) break;
            acc = { email: customerCanvaEmail, pass: '', expiryDate: po.expiryDate || null };
          } else {
            acc = typeof pickAvailableAccount === 'function'
              ? pickAvailableAccount(data, po.skey)
              : stockAccountsForPlan(data.stock, po.skey).find(a => !a.used);
            if (!acc) break;
          }
          const aliasError = isCanvaOwn ? null : validateNetflixAliasPurchase(data, po.skey, acc);
          if (aliasError) break;
          const order = user ? placeFulfilledOrder(user, po, acc, data.stock) : null;
          pushStatusHistory(po, 'fulfilled');
          data.pending.splice(idx, 1);
          if (user && Array.isArray(user.transactions)) {
            user.transactions.forEach(t => {
              if (t.orderId === po.id) t.pending = false;
            });
          }
          fulfilled.push({ user, order, po, acc });
        }
        if (!queue.length) {
          return { error: 'No matching pending orders', status: 404 };
        }
        await writeDbFast(data);
        return { data, fulfilled };
      });
      if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
      const { data, fulfilled } = outcome;
      res.json({
        success: true,
        fulfilledCount: fulfilled.length,
        data: slimMutationData(session, data, { pending: true, stock: true })
      });
      if (fulfilled.length) {
        setImmediate(async () => {
          for (const item of fulfilled) {
            const { user, order, po, acc } = item;
            if (!user || !order) continue;
            let deliveryChannel = false;
            if (!order.telegramDeliveredAt && !order.emailDeliveredAt) {
              const product = { name: po.product, short: po.short, color: po.color, tc: po.tc, id: po.productId };
              if (typeof notifyPurchaseFulfilled === 'function') {
                deliveryChannel = await notifyPurchaseFulfilled(user, product, po.plan, po.price, order, po.assignCustId, { data });
              }
            }
            if (order && deliveryChannel) stampOrderDelivery(order, deliveryChannel);
            if (deliveryChannel) await persistOrderDeliveryStamp(user, order.id, deliveryChannel);
          }
          await appendActivity('Batch pending fulfilled', `${fulfilled.length} order(s)`, session.email);
        });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/admin/fulfill-pending', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });
    if (activeFulfillOrders.has(orderId)) {
      return res.status(409).json({ error: 'This order is already being fulfilled' });
    }
    activeFulfillOrders.add(orderId);
    try {
      const outcome = await enqueueDbWrite(async () => {
        const data = await readDbForWrite();
        data.pending = Array.isArray(data.pending) ? data.pending : [];
        data.users = Array.isArray(data.users) ? data.users : [];
        data.stock = data.stock || {};
        const idx = data.pending.findIndex(o => o.id === orderId);
        if (idx < 0) return { error: 'Pending order not found', status: 404 };
        const po = data.pending[idx];
        const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(po.userEmail));
        const existing = user ? findUserOrderRecord(user, po.id).order : null;
        if (existing && existing.email && !existing.pending) {
          data.pending.splice(idx, 1);
          await writeDbFast(data);
          return { alreadyFulfilled: true, data, user, order: existing };
        }
        const hasCharge = user && Array.isArray(user.transactions) && user.transactions.some(t => t.orderId === po.id);
        if (!hasCharge) {
          data.pending.splice(idx, 1);
          await writeDbFast(data);
          return { removedOrphan: true, data, user };
        }
        const isCanvaOwn = /^canva__own__/.test(String(po.skey || ''));
        let acc = null;
        if (isCanvaOwn) {
          const customerCanvaEmail = String(po.customerCanvaEmail || '').trim();
          if (!customerCanvaEmail) return { error: 'Canva email missing on pending order', status: 400 };
          acc = { email: customerCanvaEmail, pass: '', expiryDate: po.expiryDate || null };
        } else {
          acc = typeof pickAvailableAccount === 'function'
            ? pickAvailableAccount(data, po.skey)
            : stockAccountsForPlan(data.stock, po.skey).find(a => !a.used);
          if (!acc) return { error: 'No stock available for this plan', status: 409 };
        }
        const aliasError = isCanvaOwn ? null : validateNetflixAliasPurchase(data, po.skey, acc);
        if (aliasError) return { error: aliasError, status: 409 };
        const order = user ? placeFulfilledOrder(user, po, acc, data.stock) : null;
        pushStatusHistory(po, 'fulfilled');
        data.pending.splice(idx, 1);
        if (user && Array.isArray(user.transactions)) {
          user.transactions.forEach(t => {
            if (t.orderId === po.id) t.pending = false;
          });
        }
        await writeDbFast(data);
        return { data, user, order, po, acc };
      });
      if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
      if (outcome.alreadyFulfilled) {
        return res.json({ success: true, order: outcome.order, alreadyFulfilled: true, user: sanitizeUser(outcome.user), data: slimMutationData(session, outcome.data, { pending: true, stock: true }) });
      }
      if (outcome.removedOrphan) {
        await appendActivity('Removed orphan pending order', orderId, session.email);
        return res.json({ success: true, removedOrphan: true, alreadyFulfilled: true, user: sanitizeUser(outcome.user), data: slimMutationData(session, outcome.data, { pending: true }) });
      }
      const { data, user, order, po, acc } = outcome;
      res.json({ success: true, order, user: sanitizeUser(user), data: slimMutationData(session, data, { pending: true, stock: true }) });
      setImmediate(async () => {
        let deliveryChannel = false;
        if (user && order && !order.telegramDeliveredAt && !order.emailDeliveredAt) {
          const product = { name: po.product, short: po.short, color: po.color, tc: po.tc, id: po.productId };
          if (typeof notifyPurchaseFulfilled === 'function') {
            deliveryChannel = await notifyPurchaseFulfilled(user, product, po.plan, po.price, order, po.assignCustId, { data });
          } else {
            const tgId = String(user.tgChatId || po.userTgChatId || '').trim();
            if (tgId) {
              deliveryChannel = 'telegram';
              await sendTG(tgId, `✅ <b>Your ${po.product} is ready!</b>\n\n📋 ${po.plan}\n📧 <code>${acc.email}</code>\n🔑 <code>${acc.pass}</code>${acc.profilePin ? `\n🔢 PIN: <code>${acc.profilePin}</code>` : ''}`, 'HTML').catch(() => {});
              if (!user.tgChatId) user.tgChatId = tgId;
            }
          }
        }
        if (order && deliveryChannel) stampOrderDelivery(order, deliveryChannel);
        if (deliveryChannel) await persistOrderDeliveryStamp(user, order.id, deliveryChannel);
        await appendActivity('Pending order fulfilled', orderId, session.email);
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      activeFulfillOrders.delete(orderId);
    }
  });

  app.post('/admin/activate-pending-external', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { orderId, email, pass, serviceLink, expiryDate, note, sendNotification } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });
    if (activeFulfillOrders.has(orderId)) {
      return res.status(409).json({ error: 'This order is already being processed' });
    }
    activeFulfillOrders.add(orderId);
    try {
      const outcome = await enqueueDbWrite(async () => {
        const data = await readDbForWrite();
        data.pending = Array.isArray(data.pending) ? data.pending : [];
        data.users = Array.isArray(data.users) ? data.users : [];
        const idx = data.pending.findIndex(o => o.id === orderId);
        if (idx < 0) return { error: 'Pending order not found', status: 404 };
        const po = data.pending[idx];
        const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(po.userEmail));
        const existing = user ? findUserOrderRecord(user, po.id).order : null;
        if (existing && existing.email && !existing.pending) {
          data.pending.splice(idx, 1);
          await writeDbFast(data);
          return { alreadyFulfilled: true, data, user, order: existing };
        }
        const hasCharge = user && Array.isArray(user.transactions) && user.transactions.some(t => t.orderId === po.id);
        if (!hasCharge) {
          data.pending.splice(idx, 1);
          await writeDbFast(data);
          return { removedOrphan: true, data, user };
        }
        const resolvedEmail = String(email || po.customerCanvaEmail || '').trim();
        if (/^canva__own__/.test(String(po.skey || '')) && !resolvedEmail) {
          return { error: 'Canva email is required for this order', status: 400 };
        }
        const order = user ? placeExternalFulfilledOrder(user, po, {
          email: resolvedEmail,
          pass,
          serviceLink,
          expiryDate,
          note
        }) : null;
        pushStatusHistory(po, 'fulfilled_externally', { note: String(note || '').trim() || undefined });
        data.pending.splice(idx, 1);
        if (user && Array.isArray(user.transactions)) {
          user.transactions.forEach(t => {
            if (t.orderId === po.id) t.pending = false;
          });
        }
        await writeDbFast(data);
        return { data, user, order, po, sendNotification: Boolean(sendNotification) };
      });
      if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
      if (outcome.alreadyFulfilled) {
        return res.json({
          success: true,
          order: outcome.order,
          alreadyFulfilled: true,
          user: sanitizeUser(outcome.user),
          data: slimMutationData(session, outcome.data, { pending: true, stock: true })
        });
      }
      if (outcome.removedOrphan) {
        await appendActivity('Removed orphan pending order', orderId, session.email);
        return res.json({
          success: true,
          removedOrphan: true,
          alreadyFulfilled: true,
          user: sanitizeUser(outcome.user),
          data: slimMutationData(session, outcome.data, { pending: true })
        });
      }
      const { data, user, order, po, sendNotification: notify } = outcome;
      const externalNote = String((req.body && req.body.note) || '').trim();
      res.json({
        success: true,
        order,
        user: sanitizeUser(user),
        data: slimMutationData(session, data, { pending: true, stock: true })
      });
      setImmediate(async () => {
        if (user && order && notify) {
          const tgId = String(user.tgChatId || po.userTgChatId || '').trim();
          if (tgId) {
            await sendTG(
              tgId,
              `✅ <b>Your ${po.product} is active!</b>\n\n📋 ${po.plan}\n\nOpen rashadtech.tv → <b>My Subscriptions</b> to view your subscription.`,
              'HTML'
            ).catch(() => {});
            stampOrderDelivery(order, 'telegram');
            await persistOrderDeliveryStamp(user, order.id, 'telegram');
          }
        }
        await appendActivity('Pending order activated externally', `${orderId}${externalNote ? ` · ${externalNote.slice(0, 80)}` : ''}`, session.email);
        await sendTG(
          TG_ADMIN,
          `✅ <b>Pending order closed (external delivery)</b>\n📦 ${po.product} · ${po.plan}\n👤 ${po.userName} (${po.userEmail})\n🆔 ${orderId}`,
          'HTML'
        ).catch(() => {});
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      activeFulfillOrders.delete(orderId);
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
  let lastLowStockAlertDay = '';

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

  async function runLowStockAlerts() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (lastLowStockAlertDay === today) return;
      const data = await readJsonBinRaw();
      const items = collectLowStockItems(data.stock, LOW_STOCK_THRESHOLD);
      if (!items.length) return;
      const lines = items.slice(0, 20).map(item => {
        const label = item.key.replace(/__/g, ' · ');
        return item.empty ? `❌ ${label} — OUT OF STOCK` : `⚠️ ${label} — ${item.available} left`;
      });
      await sendTG(TG_ADMIN, `📦 <b>Low stock alert</b>\n\n${lines.join('\n')}\n\nAdd stock in Admin → Stock.`, 'HTML').catch(() => {});
      lastLowStockAlertDay = today;
    } catch (e) {
      console.error('Low stock alert error:', e.message);
    }
  }

  async function runDailyBackupSummary() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (lastBackupNotifyDay === today) return;
      const data = await readJsonBinRaw();
      const backup = await createBackupSnapshot(data, 'daily-auto').catch(() => null);
      const backups = await readBackupManifest().catch(() => []);
      const stock = (typeof countStockStats === 'function' ? countStockStats : () => ({ available: 0, sold: 0, total: 0 }))(data.stock);
      const stockLine = stock.sold
        ? `Stock available: ${stock.available} (${stock.sold} sold · ${stock.total} total)`
        : `Stock available: ${stock.available}`;
      await sendTG(TG_ADMIN, `🛡️ <b>Daily backup OK</b>\nUsers: ${(data.users || []).length}\n${stockLine}\nPending: ${(data.pending || []).length}\nBackups stored: ${backups.length}${backup ? `\nLatest: ${backup.id}` : ''}`, 'HTML').catch(() => {});
      lastBackupNotifyDay = today;
    } catch (e) {
      console.error('Daily backup summary error:', e.message);
    }
  }

  setInterval(() => {
    runRenewalAlerts().catch(() => {});
    runCustomerExpiryAlerts().catch(() => {});
    runDailyBackupSummary().catch(() => {});
    runLowStockAlerts().catch(() => {});
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
