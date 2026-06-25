const grizzlySms = require('./grizzlySms');

const SMS_CONFIG_KEY = 'smsConfig';
const SMS_STARTER_CATALOG = [
  { service: 'wa', serviceName: 'WhatsApp', country: '73', countryName: 'Brazil' },
  { service: 'tg', serviceName: 'Telegram', country: '73', countryName: 'Brazil' },
  { service: 'wa', serviceName: 'WhatsApp', country: '16', countryName: 'United Kingdom' },
  { service: 'ig', serviceName: 'Instagram', country: '73', countryName: 'Brazil' },
  { service: 'go', serviceName: 'Google', country: '73', countryName: 'Brazil' },
  { service: 'fb', serviceName: 'Facebook', country: '73', countryName: 'Brazil' }
];

const POPULAR_SMS_COUNTRIES = ['73', '16', '187', '22', '6', '12', '4', '1', '2', '63', '15', '48'];

const activeSmsPurchases = new Set();

function readSmsConfig(data) {
  const raw = (data && data[SMS_CONFIG_KEY]) || grizzlySms.defaultSmsConfig();
  return {
    ...grizzlySms.defaultSmsConfig(),
    ...raw,
    catalog: Array.isArray(raw.catalog) ? raw.catalog : []
  };
}

function findSmsCatalogItem(config, catalogId) {
  return (config.catalog || []).find(item => item.id === catalogId && item.enabled !== false) || null;
}

function findUserSmsOrder(user, orderId, orderIdsMatch) {
  return (user.orders || []).find(order => orderIdsMatch(order.id, orderId) && order.productId === 'sms') || null;
}

function registerSmsRoutes(app, deps) {
  const {
    requireSession,
    readJsonBinRaw,
    writeJsonBinRaw,
    normalizeEmail,
    sanitizeUser,
    safeDataForSession,
    sendTG,
    TG_ADMIN,
    orderIdsMatch
  } = deps;

  async function getGrizzlyApiKeyFromDb() {
    const data = await readJsonBinRaw().catch(() => ({}));
    const config = readSmsConfig(data);
    return String(config.apiKey || '').trim();
  }

  app.get('/admin/sms/config', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      res.json({
        success: true,
        config: grizzlySms.sanitizeSmsConfigForClient(config, true),
        orders: Array.isArray(data.smsorders) ? data.smsorders.length : 0
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not load SMS settings' });
    }
  });

  app.post('/admin/sms/config', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const body = req.body || {};
    try {
      const data = await readJsonBinRaw();
      const current = readSmsConfig(data);
      const next = {
        ...current,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
        storeEnabled: body.storeEnabled !== undefined ? Boolean(body.storeEnabled) : current.storeEnabled,
        markupPercent: body.markupPercent !== undefined ? Number(body.markupPercent) : current.markupPercent,
        usdPerCredit: body.usdPerCredit !== undefined ? Number(body.usdPerCredit) : current.usdPerCredit,
        catalog: Array.isArray(body.catalog) ? body.catalog : current.catalog
      };
      if (body.apiKey !== undefined) {
        const trimmed = String(body.apiKey || '').trim();
        if (trimmed) next.apiKey = trimmed;
        else if (body.clearApiKey) next.apiKey = '';
      }
      data[SMS_CONFIG_KEY] = next;
      await writeJsonBinRaw(data);
      res.json({ success: true, config: grizzlySms.sanitizeSmsConfigForClient(next, true) });
    } catch (e) {
      console.error('Save SMS config error:', e.message);
      res.status(500).json({ error: 'Could not save SMS settings' });
    }
  });

  app.post('/admin/sms/test', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const apiKey = String(req.body?.apiKey || '').trim() || await getGrizzlyApiKeyFromDb();
      const result = await grizzlySms.getBalance(apiKey);
      if (!result.success) return res.status(400).json(result);
      res.json({ success: true, balance: result.balance });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not test Grizzly SMS connection' });
    }
  });

  app.get('/admin/sms/services', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const result = await grizzlySms.getServices(await getGrizzlyApiKeyFromDb());
      if (!result.success) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not load Grizzly services' });
    }
  });

  app.get('/admin/sms/countries', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const result = await grizzlySms.getCountries(await getGrizzlyApiKeyFromDb());
      if (!result.success) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not load Grizzly countries' });
    }
  });

  app.get('/admin/sms/prices', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const service = String(req.query.service || '').trim();
    const country = String(req.query.country || '').trim();
    if (!service || !country) return res.status(400).json({ error: 'service and country are required' });
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const result = await grizzlySms.getPrices(String(config.apiKey || '').trim(), { service, country });
      if (!result.success) return res.status(400).json(result);
      const cost = grizzlySms.extractGrizzlyCost(result.prices, service, country);
      const sellPrice = cost === null
        ? null
        : grizzlySms.computeSellPrice(cost, config.markupPercent, config.usdPerCredit);
      res.json({ success: true, prices: result.prices, cost, sellPrice, markupPercent: config.markupPercent });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not load Grizzly prices' });
    }
  });

  app.post('/admin/sms/catalog-add', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const { service, serviceName, country, countryName, sellPrice, enabled } = req.body || {};
    if (!service || !country) return res.status(400).json({ error: 'service and country are required' });
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const apiKey = String(config.apiKey || '').trim();
      const priceResult = await grizzlySms.getPrices(apiKey, { service, country });
      const cost = priceResult.success
        ? grizzlySms.extractGrizzlyCost(priceResult.prices, service, country)
        : null;
      const item = {
        id: `${service}__${country}`,
        service: String(service).trim(),
        serviceName: String(serviceName || service).trim(),
        country: String(country).trim(),
        countryName: String(countryName || country).trim(),
        cost,
        sellPrice: sellPrice !== undefined && sellPrice !== null && sellPrice !== ''
          ? Number(sellPrice)
          : grizzlySms.computeSellPrice(cost, config.markupPercent, config.usdPerCredit),
        enabled: enabled !== false,
        updatedAt: Date.now()
      };
      config.catalog = (config.catalog || []).filter(row => row.id !== item.id);
      config.catalog.unshift(item);
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({ success: true, item, config: grizzlySms.sanitizeSmsConfigForClient(config, true) });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not add SMS catalog item' });
    }
  });

  app.post('/admin/sms/catalog-remove', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      config.catalog = (config.catalog || []).filter(row => row.id !== id);
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({ success: true, config: grizzlySms.sanitizeSmsConfigForClient(config, true) });
    } catch (e) {
      res.status(500).json({ error: 'Could not remove SMS catalog item' });
    }
  });

  app.post('/admin/sms/catalog-update', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    const id = String(req.body?.id || '').trim();
    const sellPrice = Number(req.body?.sellPrice);
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
      return res.status(400).json({ error: 'Enter a valid sell price greater than 0' });
    }
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const item = (config.catalog || []).find(row => row.id === id);
      if (!item) return res.status(404).json({ error: 'Catalog item not found' });
      item.sellPrice = Math.round(sellPrice * 100) / 100;
      item.updatedAt = Date.now();
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({ success: true, item, config: grizzlySms.sanitizeSmsConfigForClient(config, true) });
    } catch (e) {
      res.status(500).json({ error: 'Could not update SMS price' });
    }
  });

  app.post('/admin/sms/catalog-refresh-costs', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const apiKey = String(config.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ error: 'Save your Grizzly API key first' });
      let updated = 0;
      for (const item of config.catalog || []) {
        const priceResult = await grizzlySms.getPrices(apiKey, { service: item.service, country: item.country });
        const cost = priceResult.success
          ? grizzlySms.extractGrizzlyCost(priceResult.prices, item.service, item.country)
          : null;
        if (cost == null) continue;
        item.cost = cost;
        item.updatedAt = Date.now();
        updated += 1;
      }
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({ success: true, updated, config: grizzlySms.sanitizeSmsConfigForClient(config, true) });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not refresh Grizzly costs' });
    }
  });

  app.post('/admin/sms/catalog-reprice-all', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const apiKey = String(config.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ error: 'Save your Grizzly API key first' });
      let updated = 0;
      for (const item of config.catalog || []) {
        const priceResult = await grizzlySms.getPrices(apiKey, { service: item.service, country: item.country });
        const cost = priceResult.success
          ? grizzlySms.extractGrizzlyCost(priceResult.prices, item.service, item.country)
          : item.cost;
        if (cost != null) item.cost = cost;
        item.sellPrice = grizzlySms.computeSellPrice(cost, config.markupPercent, config.usdPerCredit);
        item.updatedAt = Date.now();
        updated += 1;
      }
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({ success: true, updated, config: grizzlySms.sanitizeSmsConfigForClient(config, true) });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not reprice catalog' });
    }
  });

  app.post('/admin/sms/catalog-import-available', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const apiKey = String(config.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ error: 'Save your Grizzly API key first' });

      const [servicesResult, countriesResult] = await Promise.all([
        grizzlySms.getServices(apiKey),
        grizzlySms.getCountries(apiKey)
      ]);
      const serviceNames = Object.fromEntries(
        (servicesResult.services || []).map(s => [String(s.code), String(s.name || s.code)])
      );
      const countryNames = Object.fromEntries(
        (countriesResult.countries || []).map(c => [String(c.code), String(c.name || c.code)])
      );

      const countries = Array.isArray(req.body?.countries) && req.body.countries.length
        ? req.body.countries.map(c => String(c).trim()).filter(Boolean)
        : POPULAR_SMS_COUNTRIES;
      const maxItems = Math.min(Math.max(Number(req.body?.maxItems) || 300, 1), 500);

      const catalog = Array.isArray(config.catalog) ? [...config.catalog] : [];
      const byId = new Map(catalog.map(item => [item.id, item]));
      let added = 0;
      let updated = 0;
      let scanned = 0;

      for (const country of countries) {
        if (added + updated >= maxItems) break;
        const priceResult = await grizzlySms.getPrices(apiKey, { country });
        if (!priceResult.success) continue;
        const rows = grizzlySms.flattenGrizzlyPrices(priceResult.prices, { countryHint: country });
        for (const row of rows) {
          if (added + updated >= maxItems) break;
          scanned += 1;
          const id = `${row.service}__${row.country}`;
          const item = {
            id,
            service: row.service,
            serviceName: serviceNames[row.service] || row.service,
            country: row.country,
            countryName: countryNames[row.country] || row.country,
            cost: row.cost,
            sellPrice: grizzlySms.computeSellPrice(row.cost, config.markupPercent, config.usdPerCredit),
            enabled: true,
            updatedAt: Date.now()
          };
          if (byId.has(id)) {
            const prev = byId.get(id);
            byId.set(id, { ...prev, ...item, sellPrice: prev.sellPrice || item.sellPrice });
            updated += 1;
          } else {
            byId.set(id, item);
            added += 1;
          }
        }
      }

      config.catalog = [...byId.values()].sort((a, b) => {
        const an = `${a.serviceName || a.service} ${a.countryName || a.country}`;
        const bn = `${b.serviceName || b.service} ${b.countryName || b.country}`;
        return an.localeCompare(bn);
      });
      config.enabled = true;
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({
        success: true,
        added,
        updated,
        scanned,
        total: config.catalog.length,
        config: grizzlySms.sanitizeSmsConfigForClient(config, true)
      });
    } catch (e) {
      console.error('SMS catalog import error:', e.message);
      res.status(500).json({ error: e.message || 'Could not import available SMS services' });
    }
  });

  app.post('/admin/sms/seed-starter', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const apiKey = String(config.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ error: 'Save your Grizzly API key first' });
      const added = [];
      for (const row of SMS_STARTER_CATALOG) {
        const priceResult = await grizzlySms.getPrices(apiKey, { service: row.service, country: row.country });
        const cost = priceResult.success
          ? grizzlySms.extractGrizzlyCost(priceResult.prices, row.service, row.country)
          : null;
        const item = {
          id: `${row.service}__${row.country}`,
          service: row.service,
          serviceName: row.serviceName,
          country: row.country,
          countryName: row.countryName,
          cost,
          sellPrice: grizzlySms.computeSellPrice(cost, config.markupPercent, config.usdPerCredit),
          enabled: true,
          updatedAt: Date.now()
        };
        config.catalog = (config.catalog || []).filter(existing => existing.id !== item.id);
        config.catalog.unshift(item);
        added.push(item);
      }
      config.enabled = true;
      config.storeEnabled = true;
      data[SMS_CONFIG_KEY] = config;
      await writeJsonBinRaw(data);
      res.json({ success: true, added: added.length, config: grizzlySms.sanitizeSmsConfigForClient(config, true) });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not seed starter catalog' });
    }
  });

  app.get('/admin/sms/orders', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readJsonBinRaw();
      res.json({ success: true, orders: (data.smsorders || []).slice(0, 100) });
    } catch (e) {
      res.status(500).json({ error: 'Could not load SMS orders' });
    }
  });

  app.get('/sms/catalog', async (req, res) => {
    try {
      const data = await readJsonBinRaw().catch(() => ({}));
      const config = readSmsConfig(data);
      if (!config.storeEnabled) return res.json({ success: true, enabled: false, catalog: [] });
      const catalog = (config.catalog || [])
        .filter(item => item.enabled !== false)
        .map(item => ({
          id: item.id,
          service: item.service,
          serviceName: item.serviceName,
          country: item.country,
          countryName: item.countryName,
          sellPrice: Number(item.sellPrice || 0)
        }));
      res.json({ success: true, enabled: true, catalog });
    } catch (e) {
      res.status(500).json({ error: 'Could not load SMS catalog' });
    }
  });

  app.post('/purchase/sms', async (req, res) => {
    const session = requireSession(req, res, ['user']);
    if (!session) return;
    const catalogId = String(req.body?.catalogId || '').trim();
    if (!catalogId) return res.status(400).json({ error: 'catalogId is required' });
    const lockKey = `${session.email}::${catalogId}`;
    if (activeSmsPurchases.has(lockKey)) return res.status(409).json({ error: 'Purchase already in progress' });
    activeSmsPurchases.add(lockKey);
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      if (!config.storeEnabled) return res.status(403).json({ error: 'SMS store is not enabled yet' });
      const apiKey = String(config.apiKey || '').trim();
      if (!apiKey) return res.status(503).json({ error: 'SMS service is not configured. Please contact support.' });
      const catalogItem = findSmsCatalogItem(config, catalogId);
      if (!catalogItem) return res.status(404).json({ error: 'SMS service not found in catalog' });
      const sellPrice = Number(catalogItem.sellPrice || 0);
      if (!sellPrice) return res.status(400).json({ error: 'Invalid sell price for this SMS service' });

      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.banned) return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
      if (Number(user.balance || 0) < sellPrice) return res.status(400).json({ error: 'Insufficient balance' });

      const grizzlyBalance = await grizzlySms.getBalance(apiKey);
      if (!grizzlyBalance.success) return res.status(503).json({ error: 'Could not reach Grizzly SMS. Try again shortly.' });
      const estimatedCost = Number(catalogItem.cost || 0);
      if (estimatedCost && Number(grizzlyBalance.balance || 0) < estimatedCost) {
        await sendTG(TG_ADMIN, `⚠️ <b>Grizzly SMS balance low</b>\nBalance: ${grizzlyBalance.balance}\nNeeded about: ${estimatedCost}`, 'HTML').catch(() => {});
        return res.status(503).json({ error: 'SMS supplier balance is low. Please try again later or contact support.' });
      }

      const numberResult = await grizzlySms.requestNumber(apiKey, {
        service: catalogItem.service,
        country: catalogItem.country,
        maxPrice: estimatedCost ? Number((estimatedCost * 1.15).toFixed(2)) : undefined
      });
      if (!numberResult.success) {
        return res.status(400).json({ error: numberResult.error || 'Could not rent a number right now. Try another country.' });
      }

      const dateStr = new Date().toLocaleString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const orderId = '#' + (Math.floor(Math.random() * 90000 + 10000));
      user.balance = Number(user.balance || 0) - sellPrice;
      user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
      user.orders = Array.isArray(user.orders) ? user.orders : [];
      const order = {
        id: orderId,
        productId: 'sms',
        product: catalogItem.serviceName || catalogItem.service,
        short: 'SMS',
        color: '#7c3aed',
        tc: '#fff',
        plan: catalogItem.countryName || catalogItem.country,
        price: sellPrice,
        date: dateStr,
        phone: numberResult.phoneNumber,
        phoneNumber: numberResult.phoneNumber,
        activationId: numberResult.activationId,
        smsService: catalogItem.service,
        smsCountry: catalogItem.country,
        smsCatalogId: catalogItem.id,
        smsStatus: 'waiting',
        smsCode: '',
        supplierCost: numberResult.activationCost || catalogItem.cost || null
      };
      user.orders.unshift(order);
      user.transactions.unshift({
        type: 'purchase',
        label: `SMS ${order.product} · ${order.plan}`,
        amount: sellPrice,
        balance: user.balance,
        date: dateStr,
        orderId
      });
      data.smsorders = Array.isArray(data.smsorders) ? data.smsorders : [];
      data.smsorders.unshift({
        id: orderId,
        activationId: numberResult.activationId,
        phoneNumber: numberResult.phoneNumber,
        service: catalogItem.service,
        serviceName: catalogItem.serviceName,
        country: catalogItem.country,
        countryName: catalogItem.countryName,
        sellPrice,
        supplierCost: numberResult.activationCost || catalogItem.cost || null,
        userEmail: user.email,
        userName: user.name,
        userTgChatId: user.tgChatId || '',
        status: 'waiting',
        smsCode: '',
        date: dateStr
      });
      await writeJsonBinRaw(data);
      await sendTG(
        TG_ADMIN,
        `📱 <b>New SMS Purchase</b>\n\n${order.product} · ${order.plan}\n📞 <code>${order.phone}</code>\n💵 ${sellPrice.toFixed(2)}\n👤 ${user.name} (${user.email})`,
        'HTML'
      ).catch(() => {});
      res.json({ success: true, order, user: sanitizeUser(user), data: safeDataForSession(data, session) });
    } catch (e) {
      console.error('SMS purchase error:', e.message);
      res.status(500).json({ error: 'SMS purchase failed' });
    } finally {
      activeSmsPurchases.delete(lockKey);
    }
  });

  app.post('/sms/status', async (req, res) => {
    const session = requireSession(req, res, ['user']);
    if (!session) return;
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    try {
      const data = await readJsonBinRaw();
      const config = readSmsConfig(data);
      const apiKey = String(config.apiKey || '').trim();
      if (!apiKey) return res.status(503).json({ error: 'SMS service is not configured' });
      const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const order = findUserSmsOrder(user, orderId, orderIdsMatch);
      if (!order) return res.status(404).json({ error: 'SMS order not found' });
      if (order.smsStatus === 'ok' && order.smsCode) {
        return res.json({ success: true, status: 'ok', code: order.smsCode, phone: order.phoneNumber || order.phone });
      }
      const statusResult = await grizzlySms.getStatus(apiKey, order.activationId);
      if (statusResult.cancelled) {
        order.smsStatus = 'cancelled';
        const smsRow = (data.smsorders || []).find(row => orderIdsMatch(row.id, orderId));
        if (smsRow) smsRow.status = 'cancelled';
        await writeJsonBinRaw(data);
        return res.json({ success: false, status: 'cancelled', message: 'Activation cancelled or expired' });
      }
      if (statusResult.status === 'ok' && statusResult.code) {
        order.smsCode = statusResult.code;
        order.smsStatus = 'ok';
        const smsRow = (data.smsorders || []).find(row => orderIdsMatch(row.id, orderId));
        if (smsRow) {
          smsRow.smsCode = statusResult.code;
          smsRow.status = 'ok';
        }
        await grizzlySms.setStatus(apiKey, order.activationId, 6).catch(() => {});
        await writeJsonBinRaw(data);
        return res.json({
          success: true,
          status: 'ok',
          code: statusResult.code,
          phone: order.phoneNumber || order.phone
        });
      }
      res.json({
        success: true,
        status: statusResult.status || 'waiting',
        phone: order.phoneNumber || order.phone,
        message: 'Waiting for SMS code — try again in a few seconds'
      });
    } catch (e) {
      console.error('SMS status error:', e.message);
      res.status(500).json({ error: 'Could not check SMS status' });
    }
  });
}

module.exports = {
  SMS_CONFIG_KEY,
  grizzlySms,
  readSmsConfig,
  registerSmsRoutes
};
