const strong8k = require('./strong8k');

const STRONG8K_CONFIG_KEY = 'strong8kConfig';
const activeStrong8kPurchases = new Set();

function readStrong8kConfig(data) {
  return strong8k.sanitizeStrong8kConfig((data && data[STRONG8K_CONFIG_KEY]) || strong8k.defaultStrong8kConfig());
}

function registerStrong8kRoutes(app, deps) {
  const {
    requireSession,
    readJsonBinRaw,
    writeJsonBinRaw,
    writeDbFast,
    getDbCache,
    normalizeEmail,
    sanitizeUser,
    safeDataForSession,
    sendTG,
    TG_ADMIN,
    enqueueDbWrite,
    readDbForWrite,
    getCatalogForUser,
    pricesMatch,
    notifyPurchaseFulfilled,
    sendPurchaseReceiptEmail,
    formatBeirutTime
  } = deps;

  async function readDbFast() {
    const cached = typeof getDbCache === 'function' ? getDbCache() : null;
    if (cached) return cached;
    return readJsonBinRaw({ fast: true, skipRecoverWrite: true, noClone: true });
  }

  async function saveStrong8kConfig(mutator) {
    const data = await readJsonBinRaw();
    const current = readStrong8kConfig(data);
    const next = strong8k.sanitizeStrong8kConfig(mutator({ ...current }));
    if (!String(next.apiKey || '').trim() && String(current.apiKey || '').trim()) {
      next.apiKey = current.apiKey;
    }
    data[STRONG8K_CONFIG_KEY] = next;
    await writeJsonBinRaw(data);
    return next;
  }

  app.get('/strong8k/store', async (req, res) => {
    try {
      const data = await readDbFast().catch(() => ({}));
      const payload = strong8k.sanitizeStrong8kConfigForClient(readStrong8kConfig(data), false);
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ success: true, ...payload });
    } catch (e) {
      res.status(500).json({ error: 'Could not load Strong8K store' });
    }
  });

  app.get('/admin/strong8k/config', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readDbFast();
      res.json({
        success: true,
        config: strong8k.sanitizeStrong8kConfigForClient(readStrong8kConfig(data), true)
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not load Strong8K settings' });
    }
  });

  app.post('/admin/strong8k/config', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const body = req.body || {};
    try {
      const next = await saveStrong8kConfig(current => ({
        ...current,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
        storeEnabled: body.storeEnabled !== undefined ? Boolean(body.storeEnabled) : current.storeEnabled,
        panelUrl: body.panelUrl !== undefined ? body.panelUrl : current.panelUrl,
        packageId: body.packageId !== undefined ? body.packageId : current.packageId,
        plans: Array.isArray(body.plans) ? body.plans : current.plans,
        apiKey: body.apiKey !== undefined ? String(body.apiKey || '').trim() : current.apiKey
      }));
      res.json({
        success: true,
        config: strong8k.sanitizeStrong8kConfigForClient(next, true)
      });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not save Strong8K settings' });
    }
  });

  app.post('/admin/strong8k/test', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readDbFast();
      const config = readStrong8kConfig(data);
      const draft = { ...config };
      if (req.body && req.body.panelUrl !== undefined) draft.panelUrl = req.body.panelUrl;
      if (req.body && req.body.apiKey) draft.apiKey = String(req.body.apiKey).trim();
      const info = await strong8k.getResellerInfo(draft);
      res.json({ success: true, ...info });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Strong8K connection failed' });
    }
  });

  app.get('/admin/strong8k/bouquets', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readDbFast();
      const result = await strong8k.getBouquets(readStrong8kConfig(data));
      res.json({ success: true, bouquets: result.bouquets || [] });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not load bouquets' });
    }
  });

  app.post('/purchase/strong8k', async (req, res) => {
    const session = requireSession(req, res, ['user']);
    if (!session) return;
    const lockKey = normalizeEmail(session.email);
    if (activeStrong8kPurchases.has(lockKey)) {
      return res.status(409).json({ error: 'Purchase already in progress. Please wait.' });
    }
    activeStrong8kPurchases.add(lockKey);

    const months = Number(req.body?.months);
    const price = Number(req.body?.price);
    const planLabel = String(req.body?.planLabel || '').trim();

    try {
      const outcome = await enqueueDbWrite(async () => {
        const data = await readDbForWrite();
        const config = readStrong8kConfig(data);
        if (!config.storeEnabled) return { error: 'Strong8K is not available right now', status: 403 };
        if (!config.panelUrl || !strong8k.resolveApiKey(config)) {
          return { error: 'Strong8K is not configured yet. Contact support.', status: 503 };
        }

        const plan = strong8k.findPlan(config, months);
        if (!plan) return { error: 'Invalid plan selected', status: 400 };
        if (!pricesMatch(plan.sellPrice, price)) {
          return { error: 'Price has changed. Refresh the store and try again.', status: 400 };
        }

        data.users = Array.isArray(data.users) ? data.users : [];
        const user = data.users.find(u => normalizeEmail(u.email) === session.email);
        if (!user) return { error: 'User not found', status: 404 };
        if (user.banned) return { error: 'Your account has been suspended.', status: 403 };
        if (Number(user.balance || 0) < price) return { error: 'Insufficient balance', status: 400 };

        const catalog = getCatalogForUser(data, user);
        const skey = `strong8k__${Math.max(0, config.plans.findIndex(p => Number(p.months) === months))}`;
        const catalogPrice = catalog && catalog.prices ? Number(catalog.prices[skey]) : null;
        if (catalogPrice != null && !pricesMatch(catalogPrice, price)) {
          return { error: 'Price has changed. Refresh the store and try again.', status: 400 };
        }

        const panelResult = await strong8k.createM3uLine(config, {
          months,
          note: `rashadtech.tv · ${user.email}`
        });

        user.balance = Number(user.balance || 0) - price;
        const dateStr = formatBeirutTime();
        const orderId = '#' + (Math.floor(Math.random() * 90000) + 10000);
        const order = {
          id: orderId,
          productId: 'strong8k',
          product: 'RashadTech IPTV',
          short: 'RTV',
          color: '#5C1F7A',
          tc: '#fff',
          plan: planLabel || plan.name,
          price,
          date: dateStr,
          email: panelResult.username,
          pass: panelResult.password,
          serviceLink: panelResult.url,
          strong8kUserId: panelResult.userId,
          strong8kMonths: months,
          expiryDate: ''
        };

        user.orders = Array.isArray(user.orders) ? user.orders : [];
        user.orders.unshift(order);
        user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
        user.transactions.unshift({
          type: 'purchase',
          label: `RashadTech IPTV · ${order.plan}`,
          amount: price,
          balance: user.balance,
          date: dateStr,
          orderId
        });

        await writeDbFast(data);
        return { data, user, order, dateStr, panelResult };
      });

      if (outcome.error) {
        return res.status(outcome.status || 400).json({ error: outcome.error });
      }

      const { data, user, order, dateStr, panelResult } = outcome;
      res.json({
        success: true,
        order,
        user: sanitizeUser(user),
        data: safeDataForSession(data, session)
      });

      if (typeof notifyPurchaseFulfilled === 'function') {
        notifyPurchaseFulfilled(user, { name: order.product }, order.plan, order.price, order, null, { data }).catch(() => {});
      }
      if (typeof sendPurchaseReceiptEmail === 'function') {
        sendPurchaseReceiptEmail(user, { name: order.product }, order.plan, order.price, order, {
          data,
          date: dateStr
        }).catch(() => {});
      }
      sendTG(
        TG_ADMIN,
        `📺 <b>New RashadTech IPTV purchase</b>\n\n${order.plan}\n👤 <code>${panelResult.username}</code>\n🔗 M3U delivered\n💵 ${price.toFixed(2)}\n🛒 ${user.name} (${user.email})`,
        'HTML'
      ).catch(() => {});
    } catch (e) {
      console.error('Strong8K purchase error:', e.message);
      res.status(500).json({ error: e.message || 'Strong8K purchase failed' });
    } finally {
      activeStrong8kPurchases.delete(lockKey);
    }
  });
}

module.exports = {
  STRONG8K_CONFIG_KEY,
  strong8k,
  readStrong8kConfig,
  registerStrong8kRoutes
};
