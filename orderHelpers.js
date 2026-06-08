function markStockSold(account, soldTo) {
  if (!account) return;
  account.used = true;
  if (soldTo) {
    account.soldTo = {
      userEmail: soldTo.userEmail || '',
      userName: soldTo.userName || '',
      orderId: soldTo.orderId || '',
      assignCustId: soldTo.assignCustId ?? null,
      assignCustName: soldTo.assignCustName || '',
      at: Date.now()
    };
  }
}

function stampOrderDelivery(order, telegramSent) {
  const now = Date.now();
  order.deliveredAt = now;
  if (telegramSent) order.telegramDeliveredAt = now;
  return order;
}

function pushStatusHistory(target, stage, extra) {
  if (!target) return;
  target.statusHistory = Array.isArray(target.statusHistory) ? target.statusHistory : [];
  target.statusHistory.push({ stage, at: Date.now(), ...(extra || {}) });
  target.status = stage;
}

function initPendingOrder(order) {
  const now = Date.now();
  order.createdAt = order.createdAt || now;
  order.status = order.status || 'awaiting_stock';
  order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  if (!order.statusHistory.length) {
    pushStatusHistory(order, 'placed');
    pushStatusHistory(order, 'awaiting_stock');
  }
  return order;
}

function initGameOrder(order) {
  order.createdAt = order.createdAt || Date.now();
  order.status = order.status || 'pending';
  order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  if (!order.statusHistory.length) pushStatusHistory(order, 'pending');
  return order;
}

function parseLocaleDateMs(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).split(/[\/,\s]/).filter(Boolean);
  if (parts.length < 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const year = parseInt(parts[2], 10);
  const hour = parts[3] !== undefined ? parseInt(parts[3].split(':')[0], 10) : 12;
  const minute = parts[3] !== undefined ? parseInt(parts[3].split(':')[1] || '0', 10) : 0;
  const dt = new Date(year, month, day, hour, minute);
  return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
}

function pendingAgeMs(order) {
  if (!order) return 0;
  if (order.createdAt) return Date.now() - Number(order.createdAt);
  const parsed = parseLocaleDateMs(order.date);
  return parsed ? Date.now() - parsed : 0;
}

function formatDeliveryTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return '';
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function findOwnerForStockAccount(data, account) {
  if (!account) return null;
  if (account.soldTo && account.soldTo.userEmail) return { ...account.soldTo, source: 'soldTo' };
  const targetEmail = normalizeEmail(account.email);
  const targetKey = String(account.accKey || '');
  for (const user of Array.isArray(data.users) ? data.users : []) {
    for (const order of Array.isArray(user.orders) ? user.orders : []) {
      if (targetKey && order.accKey && order.accKey === targetKey) {
        return { userEmail: user.email, userName: user.name, orderId: order.id, assignCustId: null, source: 'order' };
      }
      if (!targetKey && normalizeEmail(order.email) === targetEmail) {
        return { userEmail: user.email, userName: user.name, orderId: order.id, assignCustId: null, source: 'order' };
      }
    }
    for (const customer of Array.isArray(user.myCustomers) ? user.myCustomers : []) {
      for (const order of Array.isArray(customer.subs) ? customer.subs : []) {
        if (targetKey && order.accKey && order.accKey === targetKey) {
          return {
            userEmail: user.email,
            userName: user.name,
            orderId: order.id,
            assignCustId: customer.id,
            assignCustName: `${customer.fname || ''} ${customer.lname || ''}`.trim(),
            source: 'sub'
          };
        }
        if (!targetKey && normalizeEmail(order.email) === targetEmail) {
          return {
            userEmail: user.email,
            userName: user.name,
            orderId: order.id,
            assignCustId: customer.id,
            assignCustName: `${customer.fname || ''} ${customer.lname || ''}`.trim(),
            source: 'sub'
          };
        }
      }
    }
  }
  return null;
}

function collectLowStockItems(stock, threshold) {
  const limit = Number(threshold) > 0 ? Number(threshold) : 2;
  const items = [];
  for (const [key, accounts] of Object.entries(stock || {})) {
    const available = (accounts || []).filter(a => a && !a.used).length;
    if (available <= limit) items.push({ key, available, empty: available === 0 });
  }
  return items.sort((a, b) => a.available - b.available);
}

function diffPriceCatalog(previous, next) {
  const changes = [];
  const oldPrices = (previous && previous.prices) || {};
  const newPrices = (next && next.prices) || {};
  const keys = new Set([...Object.keys(oldPrices), ...Object.keys(newPrices)]);
  keys.forEach(key => {
    const oldVal = oldPrices[key];
    const newVal = newPrices[key];
    if (oldVal === undefined && newVal === undefined) return;
    if (Number(oldVal) !== Number(newVal)) changes.push({ key, old: oldVal ?? null, new: newVal ?? null });
  });
  const oldRates = (previous && previous.customDayRates) || {};
  const newRates = (next && next.customDayRates) || {};
  const rateKeys = new Set([...Object.keys(oldRates), ...Object.keys(newRates)]);
  rateKeys.forEach(key => {
    const oldVal = oldRates[key];
    const newVal = newRates[key];
    if (Number(oldVal) !== Number(newVal)) changes.push({ key: `${key} (per day)`, old: oldVal ?? null, new: newVal ?? null });
  });
  const oldJaw = (previous && previous.jawaker && previous.jawaker.basePerToken) || null;
  const newJaw = (next && next.jawaker && next.jawaker.basePerToken) || null;
  if (Number(oldJaw) !== Number(newJaw)) {
    changes.push({
      key: 'jawaker (per 12k tokens)',
      old: oldJaw != null ? Math.round(oldJaw * 12000 * 100) / 100 : null,
      new: newJaw != null ? Math.round(newJaw * 12000 * 100) / 100 : null
    });
  }
  return changes;
}

module.exports = {
  markStockSold,
  stampOrderDelivery,
  pushStatusHistory,
  initPendingOrder,
  initGameOrder,
  parseLocaleDateMs,
  pendingAgeMs,
  formatDeliveryTime,
  findOwnerForStockAccount,
  collectLowStockItems,
  diffPriceCatalog
};
