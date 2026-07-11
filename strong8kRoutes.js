const strong8k = require('./strong8k');
const {
  computeIptvPackageSelectionPrice,
  resolvePurchasePrice
} = require('./priceCatalog');

const STRONG8K_CONFIG_KEY = 'strong8kConfig';
const IPTV_TRIALS_KEY = 'iptvTrials';
const activeStrong8kPurchases = new Set();

function defaultIptvTrials() {
  return { emails: {}, phones: {}, resellerSubPhones: {} };
}

function readIptvTrials(data) {
  const raw = data && data[IPTV_TRIALS_KEY];
  if (!raw || typeof raw !== 'object') return defaultIptvTrials();
  return {
    emails: raw.emails && typeof raw.emails === 'object' ? raw.emails : {},
    phones: raw.phones && typeof raw.phones === 'object' ? raw.phones : {},
    resellerSubPhones: raw.resellerSubPhones && typeof raw.resellerSubPhones === 'object' ? raw.resellerSubPhones : {}
  };
}

function readStrong8kConfig(data) {
  return strong8k.sanitizeStrong8kConfig((data && data[STRONG8K_CONFIG_KEY]) || strong8k.defaultStrong8kConfig());
}

function trialBlockReason(trials, { email, phone, isReseller, subCustomerPhone }) {
  const normEmail = String(email || '').trim().toLowerCase();
  const normPhone = strong8k.normalizePhoneDigits(phone);
  const normSubPhone = strong8k.normalizePhoneDigits(subCustomerPhone);

  if (isReseller) {
    if (!normSubPhone || normSubPhone.length < 8) {
      return null;
    }
    if (trials.resellerSubPhones[normSubPhone]) {
      return 'This sub-customer phone number already used a free trial';
    }
    return null;
  }

  if (!normEmail) return 'Account email is required for a free trial';
  if (!normPhone || normPhone.length < 8) {
    return null;
  }
  if (trials.emails[normEmail]) return 'This email already used a free trial';
  if (trials.phones[normPhone]) return 'This phone number already used a free trial';
  return null;
}

function trialEligibilityDetails(trials, { email, phone, isReseller, subCustomerPhone }) {
  const normEmail = String(email || '').trim().toLowerCase();
  const normPhone = strong8k.normalizePhoneDigits(phone);
  const normSubPhone = strong8k.normalizePhoneDigits(subCustomerPhone);
  const hardReason = trialBlockReason(trials, { email, phone, isReseller, subCustomerPhone });
  if (hardReason) {
    return { eligible: false, hardBlocked: true, reason: hardReason, needsSubPhone: false, needsProfilePhone: false };
  }
  if (isReseller) {
    const needsSubPhone = !normSubPhone || normSubPhone.length < 8;
    return {
      eligible: !needsSubPhone,
      hardBlocked: false,
      needsSubPhone,
      needsProfilePhone: false,
      reason: needsSubPhone ? 'Enter your sub-customer phone number below' : null
    };
  }
  const needsProfilePhone = !normPhone || normPhone.length < 8;
  return {
    eligible: !needsProfilePhone,
    hardBlocked: false,
    needsSubPhone: false,
    needsProfilePhone,
    reason: needsProfilePhone ? 'Add your phone number in Profile before the free trial' : null
  };
}

function recordTrial(trials, { email, phone, isReseller, subCustomerPhone, orderId, resellerEmail }) {
  const ts = Date.now();
  const normEmail = String(email || '').trim().toLowerCase();
  const normPhone = strong8k.normalizePhoneDigits(phone);
  const normSubPhone = strong8k.normalizePhoneDigits(subCustomerPhone);
  if (isReseller) {
    trials.resellerSubPhones[normSubPhone] = { ts, orderId, resellerEmail: normEmail };
    return;
  }
  trials.emails[normEmail] = { ts, orderId, phone: normPhone };
  trials.phones[normPhone] = { ts, orderId, email: normEmail };
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
    formatBeirutTime,
    userIsReseller
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
      res.status(500).json({ error: 'Could not load IPTV store' });
    }
  });

  app.get('/strong8k/trial-eligibility', async (req, res) => {
    const session = requireSession(req, res, ['user']);
    if (!session) return;
    try {
      const data = await readDbFast();
      const config = readStrong8kConfig(data);
      const trials = readIptvTrials(data);
      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const reseller = userIsReseller(user);
      const subCustomerPhone = String(req.query.subCustomerPhone || '').trim();
      if (!config.trialEnabled) {
        return res.json({
          success: true,
          eligible: false,
          hardBlocked: true,
          needsSubPhone: false,
          needsProfilePhone: false,
          reason: 'Free trials are not available right now',
          isReseller: reseller,
          trialEnabled: false
        });
      }
      const details = trialEligibilityDetails(trials, {
        email: user.email,
        phone: user.phone,
        isReseller: reseller,
        subCustomerPhone: reseller ? subCustomerPhone : ''
      });
      res.json({
        success: true,
        ...details,
        isReseller: reseller,
        trialEnabled: Boolean(config.trialEnabled)
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not check trial eligibility' });
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
      let next = await saveStrong8kConfig(current => ({
        ...current,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
        storeEnabled: body.storeEnabled !== undefined ? Boolean(body.storeEnabled) : current.storeEnabled,
        trialEnabled: body.trialEnabled !== undefined ? Boolean(body.trialEnabled) : current.trialEnabled,
        panelUrl: body.panelUrl !== undefined ? body.panelUrl : current.panelUrl,
        packageId: body.packageId !== undefined ? body.packageId : current.packageId,
        regions: body.regions !== undefined ? body.regions : current.regions,
        plans: Array.isArray(body.plans) ? body.plans : current.plans,
        sellPackages: Array.isArray(body.sellPackages) ? body.sellPackages : current.sellPackages,
        apiKey: body.apiKey !== undefined ? String(body.apiKey || '').trim() : current.apiKey
      }));
      if (next.panelUrl && strong8k.resolveApiKey(next)) {
        try {
          const bouquetResult = await strong8k.getBouquets(next);
          next = await saveStrong8kConfig(() => strong8k.applyPanelBouquetsToConfig(next, bouquetResult.bouquets));
        } catch {
          // keep saved config if live bouquet sync fails
        }
      }
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
      const draft = { ...readStrong8kConfig(data) };
      if (req.query.panelUrl) draft.panelUrl = String(req.query.panelUrl).trim();
      const result = await strong8k.getBouquets(draft);
      res.json({ success: true, bouquets: result.bouquets || [] });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not load bouquets' });
    }
  });

  app.post('/admin/strong8k/bouquets', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readDbFast();
      const draft = { ...readStrong8kConfig(data) };
      if (req.body && req.body.panelUrl !== undefined) draft.panelUrl = String(req.body.panelUrl || '').trim();
      if (req.body && req.body.apiKey) draft.apiKey = String(req.body.apiKey || '').trim();
      const result = await strong8k.getBouquets(draft);
      const synced = strong8k.applyPanelBouquetsToConfig(draft, result.bouquets || []);
      const saved = await saveStrong8kConfig(() => synced);
      res.json({
        success: true,
        bouquets: result.bouquets || [],
        synced: true,
        config: strong8k.sanitizeStrong8kConfigForClient(saved, true)
      });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not load bouquets' });
    }
  });

  app.post('/admin/strong8k/test-trial', async (req, res) => {
    const session = requireSession(req, res, ['admin']);
    if (!session) return;
    try {
      const data = await readDbFast();
      const draft = { ...readStrong8kConfig(data) };
      if (req.body && req.body.panelUrl !== undefined) draft.panelUrl = String(req.body.panelUrl || '').trim();
      if (req.body && req.body.apiKey) draft.apiKey = String(req.body.apiKey || '').trim();
      if (!draft.panelUrl || !strong8k.resolveApiKey(draft)) {
        return res.status(400).json({ error: 'Strong8K panel is not configured' });
      }
      const region = String(req.body?.region || 'me').toLowerCase();
      if (!strong8k.IPTV_TRIAL_REGIONS.has(region)) {
        return res.status(400).json({ error: 'Test trial supports Middle East (me) or United States (us) only' });
      }
      const attempts = await strong8k.buildTrialPackAttempts(draft, region);
      const result = await strong8k.createLine(draft, {
        months: 1,
        note: `rashadtech.tv admin trial test · ${session.email}`,
        region,
        isTrial: true,
        lineType: 'stable'
      });
      res.json({
        success: true,
        region,
        packAttempts: attempts,
        username: result.username,
        password: result.password,
        host: result.host,
        url: result.url,
        message: result.message || 'Trial line created on panel'
      });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Trial test failed' });
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
    const lineType = String(req.body?.lineType || 'stable').toLowerCase() === 'm3u' ? 'm3u' : 'stable';
    const region = String(req.body?.region || 'me').toLowerCase();
    const isTrial = Boolean(req.body?.trial);
    const subCustomerPhone = String(req.body?.subCustomerPhone || '').trim();
    const selectedPackages = strong8k.normalizeSellPackageIds(req.body?.selectedPackages);

    try {
      const outcome = await enqueueDbWrite(async () => {
        const data = await readDbForWrite();
        const config = readStrong8kConfig(data);
        if (!config.storeEnabled) return { error: 'IPTV is not available right now', status: 403 };
        if (!config.panelUrl || !strong8k.resolveApiKey(config)) {
          return { error: 'IPTV is not configured yet. Contact support.', status: 403 };
        }
        if (!strong8k.sanitizeRegions(config.regions)[region]) {
          return { error: 'Please select a valid region', status: 400 };
        }
        if (isTrial && !strong8k.IPTV_TRIAL_REGIONS.has(region)) {
          return { error: 'Free trial is only available for Middle East or United States', status: 400 };
        }

        const sellPackages = strong8k.getEnabledSellPackages(config);
        const usesSellPackages = sellPackages.length > 0;
        if (usesSellPackages && !selectedPackages.length && !isTrial) {
          return { error: 'Select at least one channel package', status: 400 };
        }
        if (usesSellPackages && selectedPackages.length) {
          const valid = strong8k.resolveSelectedSellPackages(selectedPackages, config);
          if (!valid.length) return { error: 'Invalid channel package selection', status: 400 };
        }

        data.users = Array.isArray(data.users) ? data.users : [];
        const user = data.users.find(u => normalizeEmail(u.email) === session.email);
        if (!user) return { error: 'User not found', status: 404 };
        if (user.banned) return { error: 'Your account has been suspended.', status: 403 };

        const reseller = userIsReseller(user);
        const trials = readIptvTrials(data);
        let plan = null;
        const packageIds = isTrial
          ? []
          : (selectedPackages.length
            ? selectedPackages
            : (usesSellPackages && sellPackages[0] ? [sellPackages[0].id] : []));
        const packageLabel = packageIds.length
          ? strong8k.describeSellPackageSelection(packageIds, config)
          : '';

        if (isTrial) {
          if (!config.trialEnabled) return { error: 'Free trials are not available right now', status: 403 };
          const trialDetails = trialEligibilityDetails(trials, {
            email: user.email,
            phone: user.phone,
            isReseller: reseller,
            subCustomerPhone
          });
          if (trialDetails.hardBlocked) return { error: trialDetails.reason, status: 403 };
          if (reseller && (!subCustomerPhone || strong8k.normalizePhoneDigits(subCustomerPhone).length < 8)) {
            return { error: 'Enter your sub-customer phone number for the free trial', status: 400 };
          }
          if (!reseller && strong8k.normalizePhoneDigits(user.phone).length < 8) {
            return { error: 'Add your phone number in Profile before requesting a free trial', status: 400 };
          }
          if (!trialDetails.eligible) return { error: trialDetails.reason || 'Free trial not available', status: 403 };
          if (price !== 0) return { error: 'Invalid trial price', status: 400 };
        } else {
          plan = strong8k.findPlan(config, months);
          if (!plan) return { error: 'Invalid plan selected', status: 400 };
          const catalog = getCatalogForUser(data, user);
          let expectedPrice = null;
          if (usesSellPackages && packageIds.length) {
            expectedPrice = computeIptvPackageSelectionPrice(catalog, packageIds, months, sellPackages);
          } else {
            const planIndex = Math.max(0, config.plans.findIndex(p => Number(p.months) === months));
            expectedPrice = resolvePurchasePrice(catalog, { skey: `strong8k__${planIndex}` });
            if (expectedPrice == null) expectedPrice = Number(plan.sellPrice);
          }
          if (expectedPrice == null || expectedPrice <= 0 || !pricesMatch(expectedPrice, price)) {
            return { error: 'Price has changed. Refresh the store and try again.', status: 400 };
          }
          if (Number(user.balance || 0) < price) return { error: 'Insufficient balance', status: 400 };
        }

        const regionName = strong8k.sanitizeRegions(config.regions)[region]?.name || region;
        const panelResult = await strong8k.createLine(config, {
          months: isTrial ? 1 : months,
          note: `rashadtech.tv · ${user.email}${reseller && subCustomerPhone ? ` · sub ${subCustomerPhone}` : ''} · ${regionName}${packageLabel ? ` · ${packageLabel}` : ''}`,
          region,
          isTrial,
          lineType,
          packageIds
        });

        if (!isTrial) user.balance = Number(user.balance || 0) - price;

        const dateStr = formatBeirutTime();
        const orderId = '#' + (Math.floor(Math.random() * 90000) + 10000);
        const finalPlanLabel = isTrial
          ? `1-Day Free Trial · ${packageLabel || regionName} · ${lineType === 'm3u' ? 'M3U' : 'Stable'}`
          : `${planLabel || plan.name}${packageLabel ? ` · ${packageLabel}` : ''}`;
        const order = {
          id: orderId,
          productId: 'strong8k',
          product: 'RashadTech IPTV',
          short: 'RTV',
          color: '#5C1F7A',
          tc: '#fff',
          plan: finalPlanLabel,
          price: isTrial ? 0 : price,
          date: dateStr,
          email: panelResult.username,
          pass: panelResult.password,
          serviceLink: panelResult.url,
          iptvHost: panelResult.host,
          iptvLineType: panelResult.lineType,
          iptvRegion: region,
          iptvPackages: packageIds,
          iptvTrial: isTrial,
          iptvSubPhone: reseller && subCustomerPhone ? strong8k.normalizePhoneDigits(subCustomerPhone) : '',
          strong8kUserId: panelResult.userId,
          strong8kMonths: isTrial ? 0 : months,
          expiryDate: ''
        };

        user.orders = Array.isArray(user.orders) ? user.orders : [];
        user.orders.unshift(order);
        if (!isTrial) {
          user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
          user.transactions.unshift({
            type: 'purchase',
            label: `RashadTech IPTV · ${order.plan}`,
            amount: price,
            balance: user.balance,
            date: dateStr,
            orderId
          });
        }

        if (isTrial) {
          recordTrial(trials, {
            email: user.email,
            phone: user.phone,
            isReseller: reseller,
            subCustomerPhone,
            orderId,
            resellerEmail: user.email
          });
          data[IPTV_TRIALS_KEY] = trials;
        }

        await writeDbFast(data);
        return { data, user, order, dateStr, panelResult, isTrial, reseller, regionName };
      });

      if (outcome.error) {
        return res.status(outcome.status || 400).json({ error: outcome.error });
      }

      const { data, user, order, dateStr, panelResult, reseller, regionName } = outcome;
      res.json({
        success: true,
        order,
        user: sanitizeUser(user),
        data: safeDataForSession(data, session)
      });

      if (!isTrial && typeof notifyPurchaseFulfilled === 'function') {
        notifyPurchaseFulfilled(user, { name: order.product }, order.plan, order.price, order, null, { data }).catch(() => {});
      }
      if (!isTrial && typeof sendPurchaseReceiptEmail === 'function') {
        sendPurchaseReceiptEmail(user, { name: order.product }, order.plan, order.price, order, {
          data,
          date: dateStr
        }).catch(() => {});
      }
      const lineInfo = panelResult.lineType === 'stable'
        ? `🌐 <code>${panelResult.host || 'host'}</code>\n👤 <code>${panelResult.username}</code>`
        : `🔗 M3U delivered`;
      sendTG(
        TG_ADMIN,
        `📺 <b>${isTrial ? 'IPTV free trial' : 'RashadTech IPTV purchase'}</b>\n\n${order.plan}\n${lineInfo}\n🌍 ${regionName}\n💵 ${isTrial ? 'FREE' : order.price.toFixed(2)}\n🛒 ${user.name} (${user.email})${reseller && order.iptvSubPhone ? `\n📱 Sub-customer: ${order.iptvSubPhone}` : ''}`,
        'HTML'
      ).catch(() => {});
    } catch (e) {
      console.error('Strong8K purchase error:', e.message);
      res.status(500).json({ error: e.message || 'IPTV purchase failed' });
    } finally {
      activeStrong8kPurchases.delete(lockKey);
    }
  });
}

module.exports = {
  STRONG8K_CONFIG_KEY,
  IPTV_TRIALS_KEY,
  strong8k,
  readStrong8kConfig,
  readIptvTrials,
  trialBlockReason,
  trialEligibilityDetails,
  registerStrong8kRoutes
};
