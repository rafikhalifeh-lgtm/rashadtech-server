/**
 * RashadTech WhatsApp Business router bot (+961 03 915 355).
 * Flow: language → name → Mr/Ms → main menu → route / wait / wa.me links.
 *
 * Env: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN
 */
'use strict';

const WA_API = 'https://graph.facebook.com/v21.0';

const PHONES = {
  feedbackSales: '96171901132',
  maintenance: '96179306701',
  streamFast1: '96179306701',
  streamFast2: '96179375295',
};

const RESELLER_URL = 'https://rashadtech.tv';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function waLink(digits, text) {
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${digits}${q}`;
}

function registerWhatsAppBot(app, { getEnv, rateLimit }) {
  const token = () => String(getEnv('WHATSAPP_ACCESS_TOKEN') || '').trim();
  const phoneId = () => String(getEnv('WHATSAPP_PHONE_NUMBER_ID') || '').trim();
  const verifyToken = () => String(getEnv('WHATSAPP_VERIFY_TOKEN') || '').trim();
  const enabled = () => Boolean(token() && phoneId() && verifyToken());

  const sessions = new Map();

  function getSession(waId) {
    const s = sessions.get(waId);
    if (!s) return null;
    if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
      sessions.delete(waId);
      return null;
    }
    return s;
  }

  function setSession(waId, patch) {
    const prev = getSession(waId) || { waId, step: 'language', lang: null, name: '', title: '', updatedAt: 0 };
    const next = { ...prev, ...patch, waId, updatedAt: Date.now() };
    sessions.set(waId, next);
    return next;
  }

  function t(lang, en, ar) {
    return lang === 'ar' ? ar : en;
  }

  function displayName(s) {
    if (!s.name) return '';
    const title = s.title === 'ms'
      ? (s.lang === 'ar' ? 'السيدة' : 'Ms')
      : s.title === 'mr'
        ? (s.lang === 'ar' ? 'السيد' : 'Mr')
        : '';
    return title ? `${title} ${s.name}` : s.name;
  }

  async function apiSend(payload) {
    if (!enabled()) throw new Error('WhatsApp bot not configured');
    const r = await fetch(`${WA_API}/${phoneId()}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('WhatsApp send error:', j.error || j);
      throw new Error(j.error?.message || `WhatsApp HTTP ${r.status}`);
    }
    return j;
  }

  async function sendText(to, body) {
    return apiSend({ to, type: 'text', text: { body } });
  }

  async function sendButtons(to, body, buttons) {
    return apiSend({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  async function sendList(to, body, buttonLabel, rows) {
    return apiSend({
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [{ title: 'Options', rows: rows.slice(0, 10).map(r => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })) }],
        },
      },
    });
  }

  async function sendLanguagePrompt(to) {
    await sendButtons(to,
      'Welcome to RashadTech 👋\nأهلاً بك في RashadTech\n\nChoose your language | اختر اللغة:',
      [
        { id: 'lang_en', title: '🇬🇧 English' },
        { id: 'lang_ar', title: '🇸🇦 العربية' },
      ]
    );
  }

  async function sendNamePrompt(to, lang) {
    await sendText(to, t(lang,
      'Thank you! 😊\nMay we know your name please?\n(This helps our team assist you better.)',
      'شكراً! 😊\nممكن نعرف اسمك من فضلك؟\n(لتسهيل مساعدتك من فريقنا.)'
    ));
  }

  async function sendTitlePrompt(to, s) {
    await sendButtons(to, t(s.lang,
      `Nice to meet you, ${s.name}! 🙏\nHow should we address you?`,
      `تشرفنا ${s.name}! 🙏\nكيف منحكّي؟`
    ), [
      { id: 'title_mr', title: t(s.lang, '👨 Mr', '👨 سيد') },
      { id: 'title_ms', title: t(s.lang, '👩 Ms', '👩 سيدة') },
    ]);
  }

  async function sendMainMenu(to, s) {
    const who = displayName(s);
    const body = t(s.lang,
      `Hello ${who}! 👋\nWelcome to RashadTech.\nPlease choose:`,
      `أهلاً ${who}! 👋\nمرحباً بك في RashadTech.\nاختر:`
    );
    await sendList(to, body, t(s.lang, 'Menu', 'القائمة'), [
      { id: 'main_sales', title: t(s.lang, '📱 Sales', '📱 مبيعات'), description: t(s.lang, 'Phones & accessories', 'موبايلات وإكسسوارات') },
      { id: 'main_maint', title: t(s.lang, '🔧 Maintenance', '🔧 صيانة'), description: t(s.lang, 'Repair service', 'تصليح') },
      { id: 'main_stream', title: t(s.lang, '🎬 Streaming & gaming', '🎬 بث وألعاب'), description: t(s.lang, 'Retail — Netflix, PUBG…', 'للزبون — نتفليكس، ببجي…') },
      { id: 'main_reseller', title: t(s.lang, '🏪 Become reseller', '🏪 صير موزّع'), description: 'rashadtech.tv' },
      { id: 'main_lang', title: t(s.lang, '🌐 Change language', '🌐 تغيير اللغة'), description: t(s.lang, 'English / Arabic', 'إنجليزي / عربي') },
    ]);
    setSession(to, { step: 'main_menu' });
  }

  async function sendSalesMenu(to, s) {
    await sendList(to, t(s.lang,
      '📱 Sales — how can we help?',
      '📱 المبيعات — كيف نساعدك؟'
    ), t(s.lang, 'Sales options', 'خيارات المبيعات'), [
      { id: 'sales_order', title: t(s.lang, 'Order now', 'اطلب الآن'), description: t(s.lang, 'Speak with sales agent', 'تحدث مع موظف مبيعات') },
      { id: 'sales_info', title: t(s.lang, 'Phones & accessories info', 'معلومات موبايلات'), description: t(s.lang, 'Prices & availability', 'أسعار وتوفر') },
      { id: 'sales_feedback', title: t(s.lang, 'Feedback / complaint', 'شكوى / ملاحظة'), description: t(s.lang, 'Past order or agent issue', 'طلب سابق أو موظف') },
      { id: 'back_main', title: t(s.lang, '⬅ Main menu', '⬅ القائمة'), description: '' },
    ]);
    setSession(to, { step: 'sales_menu' });
  }

  async function sendWaitForAgent(to, s, context) {
    const who = displayName(s);
    await sendText(to, t(s.lang,
      `✅ Request received, ${who}!\n\nOur team will reply shortly on this chat.\nPlease stay here — a real agent will continue with you.\n\n⏳ Context: ${context}\n\nThank you for your patience! 🙏`,
      `✅ تم استلام طلبك، ${who}!\n\nفريقنا سيرد قريباً على هذه المحادثة.\nابقَ هنا — موظف حقيقي سيكمل معك.\n\n⏳ ${context}\n\nشكراً لصبرك! 🙏`
    ));
    setSession(to, { step: 'waiting_agent', agentContext: context });
  }

  async function sendSalesInfo(to, s) {
    const who = displayName(s);
    await sendText(to, t(s.lang,
      `📱 Phones & accessories at RashadTech\n\nHello ${who}!\n\nWe offer:\n• New & used smartphones (iPhone, Samsung, Xiaomi…)\n• Chargers, cables, cases, screen protectors\n• Earphones, power banks, memory cards\n• Other hardware — ask our team\n\nOur agent will reply here with prices and availability.\n\n⏳ Please wait — a team member will answer soon.`,
      `📱 موبايلات وإكسسوارات في RashadTech\n\nأهلاً ${who}!\n\nنوفر:\n• موبايلات جديدة ومستعملة (آيفون، سامسونج، شاومي…)\n• شواحن، كفرات، حمايات شاشة\n• سماعات، power bank، ذاكرة\n• قطع أخرى — اسأل فريقنا\n\nموظفنا سيرد هنا بالأسعار والتوفر.\n\n⏳ انتظر قليلاً — أحد الفريق سيجيبك قريباً.`
    ));
    setSession(to, { step: 'waiting_agent', agentContext: 'sales_info' });
  }

  async function sendSalesFeedback(to, s) {
    const who = displayName(s);
    const link = waLink(PHONES.feedbackSales, `FEEDBACK-SALES- ${s.name || who}`);
    await sendText(to, t(s.lang,
      `We're sorry you had a bad experience, ${who}. 🙏\n\nYour feedback matters. Please contact our dedicated line:\n\n👉 Tap to chat:\n${link}\n\nOr save this number:\n+961 71 901 132\n\nTell us what happened — we will review it carefully.`,
      `نعتذر عن أي تجربة سيئة، ${who}. 🙏\n\nرأيك مهم. تواصل مع خط الشكاوى:\n\n👉 اضغط للمحادثة:\n${link}\n\nأو احفظ الرقم:\n+961 71 901 132\n\nأخبرنا ما حصل — سنراجع الأمر بعناية.`
    ));
    setSession(to, { step: 'sales_feedback_done' });
  }

  async function sendMaintenance(to, s) {
    const who = displayName(s);
    const link = waLink(PHONES.maintenance, `REPAIR- ${s.name || who}`);
    await sendText(to, t(s.lang,
      `🔧 Maintenance & repair\n\nHello ${who}!\n\nFor repair quotes, status, or booking:\n\n👉 Tap to open repair WhatsApp:\n${link}\n\nOr dial manually:\n+961 79 306 701\n\nPlease send: phone model + problem + photo.`,
      `🔧 صيانة وتصليح\n\nأهلاً ${who}!\n\nلعرض سعر التصليح أو المتابعة:\n\n👉 افتح واتساب الصيانة:\n${link}\n\nأو اتصل:\n+961 79 306 701\n\nأرسل: نوع الموبايل + المشكلة + صورة.`
    ));
    setSession(to, { step: 'maintenance_done' });
  }

  async function sendStreamGamingMenu(to, s) {
    await sendList(to, t(s.lang,
      '🎬🎮 Streaming & gaming — retail prices\n(Not for resellers)',
      '🎬🎮 بث وألعاب — أسعار الزبون\n(ليس للموزّعين)'
    ), t(s.lang, 'Choose', 'اختر'), [
      { id: 'sg_stream', title: t(s.lang, '🎬 Streaming', '🎬 بث'), description: 'Netflix, Shahid…' },
      { id: 'sg_gaming', title: t(s.lang, '🎮 Gaming', '🎮 ألعاب'), description: 'PUBG, Jawaker…' },
      { id: 'sg_other', title: t(s.lang, 'Other service', 'خدمة أخرى'), description: t(s.lang, 'Type any name', 'اكتب أي اسم') },
      { id: 'back_main', title: t(s.lang, '⬅ Main menu', '⬅ القائمة'), description: '' },
    ]);
    setSession(to, { step: 'stream_gaming_menu' });
  }

  async function sendStreamingMenu(to, s) {
    await sendList(to, t(s.lang, '🎬 Streaming services', '🎬 خدمات البث'), t(s.lang, 'Services', 'الخدمات'), [
      { id: 'str_netflix', title: 'Netflix', description: t(s.lang, '1 user, full…', 'مستخدم، كامل…') },
      { id: 'str_shahid', title: 'Shahid VIP', description: t(s.lang, 'Arabic streaming', 'شاهد') },
      { id: 'str_disney', title: 'Disney+', description: '' },
      { id: 'str_osn', title: 'OSN+', description: '' },
      { id: 'str_spotify', title: 'Spotify / Anghami', description: t(s.lang, 'Music', 'موسيقى') },
      { id: 'str_other', title: t(s.lang, 'Other streaming', 'بث آخر'), description: t(s.lang, 'Type name', 'اكتب الاسم') },
      { id: 'str_feedback', title: t(s.lang, 'Streaming feedback', 'شكوى بث'), description: t(s.lang, 'Order issue', 'مشكلة طلب') },
      { id: 'back_sg', title: t(s.lang, '⬅ Back', '⬅ رجوع'), description: '' },
    ]);
    setSession(to, { step: 'streaming_menu' });
  }

  async function sendGamingMenu(to, s) {
    await sendList(to, t(s.lang, '🎮 Gaming', '🎮 ألعاب'), t(s.lang, 'Games', 'الألعاب'), [
      { id: 'gam_pubg', title: 'PUBG Mobile', description: 'UC' },
      { id: 'gam_jawaker', title: 'Jawaker', description: '' },
      { id: 'gam_roblox', title: 'Roblox', description: '' },
      { id: 'gam_freefire', title: 'Free Fire', description: 'Diamonds' },
      { id: 'gam_other', title: t(s.lang, 'Other game', 'لعبة أخرى'), description: '' },
      { id: 'gam_feedback', title: t(s.lang, 'Gaming feedback', 'شكوى ألعاب'), description: '' },
      { id: 'back_sg', title: t(s.lang, '⬅ Back', '⬅ رجوع'), description: '' },
    ]);
    setSession(to, { step: 'gaming_menu' });
  }

  async function sendRetailOrderWait(to, s, serviceLabel, category) {
    const who = displayName(s);
    const tag = category === 'gaming' ? 'GAMING' : 'STREAM';
    const link1 = waLink(PHONES.streamFast1, `${tag}-${serviceLabel}-${s.name || who}`);
    const link2 = waLink(PHONES.streamFast2, `${tag}-${serviceLabel}-${s.name || who}`);
    await sendText(to, t(s.lang,
      `✅ ${serviceLabel} — retail order\n\n${who}, an agent will help you complete your order here.\n\n⏳ Please wait on this chat…\n\n⚡ Faster order? Chat now:\n• ${link1}\n• ${link2}\n\n+961 79 306 701\n+961 79 375 295`,
      `✅ ${serviceLabel} — طلب زبون\n\n${who}، موظف سيساعدك لإتمام الطلب هنا.\n\n⏳ انتظر على هذه المحادثة…\n\n⚡ أسرع؟ تواصل:\n• ${link1}\n• ${link2}\n\n+961 79 306 701\n+961 79 375 295`
    ));
    setSession(to, { step: 'waiting_agent', agentContext: `${category}:${serviceLabel}` });
  }

  async function sendCustomServiceWait(to, s, typed) {
    const who = displayName(s);
    const link1 = waLink(PHONES.streamFast1, `CUSTOM-${typed}-${s.name || who}`);
    const link2 = waLink(PHONES.streamFast2, `CUSTOM-${typed}-${s.name || who}`);
    await sendText(to, t(s.lang,
      `Thanks, ${who}! 🙏\n\nWe'll check if we offer "${typed}".\nAn agent will reply here shortly.\n\n⏳ Please wait…\n\n⚡ Faster help:\n• ${link1}\n• ${link2}`,
      `شكراً ${who}! 🙏\n\nسنتحقق إذا نوفر "${typed}".\nموظف سيرد هنا قريباً.\n\n⏳ انتظر…\n\n⚡ أسرع:\n• ${link1}\n• ${link2}`
    ));
    setSession(to, { step: 'waiting_agent', agentContext: `custom:${typed}` });
  }

  async function sendStreamGamingFeedback(to, s, category) {
    const who = displayName(s);
    const tag = category === 'gaming' ? 'GAMING-FEEDBACK' : 'STREAM-FEEDBACK';
    const link1 = waLink(PHONES.streamFast1, `${tag}-${s.name || who}`);
    const link2 = waLink(PHONES.streamFast2, `${tag}-${s.name || who}`);
    await sendButtons(to, t(s.lang,
      `We're sorry for the trouble with your ${category} order, ${who}. 🙏\n\nChoose:`,
      `نعتذر عن مشكلة طلب ${category === 'gaming' ? 'الألعاب' : 'البث'}، ${who}. 🙏\n\nاختر:`
    ), [
      { id: 'fb_wait_here', title: t(s.lang, 'Wait for agent', 'انتظر موظف') },
      { id: 'fb_fast_chat', title: t(s.lang, 'Fast chat links', 'روابط سريعة') },
    ]);
    setSession(to, { step: 'feedback_choice', feedbackCategory: category });
  }

  async function sendFastChatLinks(to, s) {
    const who = displayName(s);
    const link1 = waLink(PHONES.streamFast1, `HELP-${s.name || who}`);
    const link2 = waLink(PHONES.streamFast2, `HELP-${s.name || who}`);
    await sendText(to, t(s.lang,
      `⚡ Chat faster, ${who}:\n\n• ${link1}\n• ${link2}\n\n+961 79 306 701\n+961 79 375 295`,
      `⚡ تواصل أسرع ${who}:\n\n• ${link1}\n• ${link2}\n\n+961 79 306 701\n+961 79 375 295`
    ));
  }

  async function sendReseller(to, s) {
    const who = displayName(s);
    await sendText(to, t(s.lang,
      `🏪 Become a streaming & gaming reseller\n\nHello ${who}!\n\nResellers get special prices on our platform.\n\n👉 Register here:\n${RESELLER_URL}\n\nAfter signup, our team will activate your account.\n\nQuestions? Reply here or WhatsApp:\n${waLink(PHONES.streamFast1, 'RESELLER-')}`,
      `🏪 صير موزّع بث وألعاب\n\nأهلاً ${who}!\n\nالموزّعون يحصلون على أسعار خاصة.\n\n👉 سجّل هنا:\n${RESELLER_URL}\n\nبعد التسجيل، فريقنا يفعّل حسابك.\n\nأسئلة؟ رد هنا أو واتساب:\n${waLink(PHONES.streamFast1, 'RESELLER-')}`
    ));
    setSession(to, { step: 'reseller_done' });
  }

  async function promptOtherServiceName(to, s, kind) {
    await sendText(to, t(s.lang,
      `Please type the name of the ${kind} service you need:`,
      `اكتب اسم خدمة ${kind === 'streaming' ? 'البث' : kind === 'gaming' ? 'الألعاب' : ''} التي تريدها:`
    ));
    setSession(to, { step: 'awaiting_custom_service', customKind: kind });
  }

  const SERVICE_MAP = {
    str_netflix: ['Netflix', 'streaming'],
    str_shahid: ['Shahid VIP', 'streaming'],
    str_disney: ['Disney+', 'streaming'],
    str_osn: ['OSN+', 'streaming'],
    str_spotify: ['Spotify / Anghami', 'streaming'],
    gam_pubg: ['PUBG Mobile', 'gaming'],
    gam_jawaker: ['Jawaker', 'gaming'],
    gam_roblox: ['Roblox', 'gaming'],
    gam_freefire: ['Free Fire', 'gaming'],
  };

  async function handleInteractive(to, replyId, s) {
    if (replyId === 'lang_en') {
      setSession(to, { step: 'awaiting_name', lang: 'en' });
      return sendNamePrompt(to, 'en');
    }
    if (replyId === 'lang_ar') {
      setSession(to, { step: 'awaiting_name', lang: 'ar' });
      return sendNamePrompt(to, 'ar');
    }
    if (replyId === 'title_mr') {
      setSession(to, { step: 'main_menu', title: 'mr' });
      return sendMainMenu(to, getSession(to));
    }
    if (replyId === 'title_ms') {
      setSession(to, { step: 'main_menu', title: 'ms' });
      return sendMainMenu(to, getSession(to));
    }
    if (replyId === 'main_sales') return sendSalesMenu(to, s);
    if (replyId === 'main_maint') return sendMaintenance(to, s);
    if (replyId === 'main_stream') return sendStreamGamingMenu(to, s);
    if (replyId === 'main_reseller') return sendReseller(to, s);
    if (replyId === 'main_lang') {
      setSession(to, { step: 'language', lang: null, name: '', title: '' });
      return sendLanguagePrompt(to);
    }
    if (replyId === 'sales_order') return sendWaitForAgent(to, s, t(s.lang, 'New sales order', 'طلب مبيعات جديد'));
    if (replyId === 'sales_info') return sendSalesInfo(to, s);
    if (replyId === 'sales_feedback') return sendSalesFeedback(to, s);
    if (replyId === 'sg_stream') return sendStreamingMenu(to, s);
    if (replyId === 'sg_gaming') return sendGamingMenu(to, s);
    if (replyId === 'sg_other') return promptOtherServiceName(to, s, 'any');
    if (replyId === 'str_other') return promptOtherServiceName(to, s, 'streaming');
    if (replyId === 'gam_other') return promptOtherServiceName(to, s, 'gaming');
    if (replyId === 'str_feedback') return sendStreamGamingFeedback(to, s, 'streaming');
    if (replyId === 'gam_feedback') return sendStreamGamingFeedback(to, s, 'gaming');
    if (replyId === 'fb_wait_here') return sendWaitForAgent(to, s, t(s.lang, 'Feedback — waiting', 'شكوى — انتظار'));
    if (replyId === 'fb_fast_chat') return sendFastChatLinks(to, s);
    if (replyId === 'back_main') return sendMainMenu(to, s);
    if (replyId === 'back_sg') return sendStreamGamingMenu(to, s);

    if (SERVICE_MAP[replyId]) {
      const [label, cat] = SERVICE_MAP[replyId];
      return sendRetailOrderWait(to, s, label, cat);
    }
    return sendText(to, t(s.lang, 'Please choose from the menu options.', 'اختر من القائمة من فضلك.'));
  }

  function normalizeTextInput(text) {
    const x = String(text || '').trim();
    const low = x.toLowerCase();
    if (low === 'en' || low === 'english' || x === '1') return { type: 'lang_en' };
    if (low === 'ar' || low === 'arabic' || x === '2' || x === 'عربي') return { type: 'lang_ar' };
    if (low === 'mr' || low === 'سيد') return { type: 'title_mr' };
    if (low === 'ms' || low === 'سيدة') return { type: 'title_ms' };
    if (/^(menu|start|help|قائمة|بداية)$/i.test(low)) return { type: 'reset' };
    return { type: 'text', value: x };
  }

  async function handleText(to, text, s) {
    const input = normalizeTextInput(text);

    if (input.type === 'reset' || !s || s.step === 'language') {
      setSession(to, { step: 'language', lang: null, name: '', title: '' });
      return sendLanguagePrompt(to);
    }

    if (input.type === 'lang_en') return handleInteractive(to, 'lang_en', s);
    if (input.type === 'lang_ar') return handleInteractive(to, 'lang_ar', s);

    if (s.step === 'awaiting_name') {
      if (input.type !== 'text' || input.value.length < 2) {
        return sendText(to, t(s.lang, 'Please type your name (at least 2 characters).', 'اكتب اسمك (حرفين على الأقل).'));
      }
      setSession(to, { step: 'awaiting_title', name: input.value.slice(0, 80) });
      return sendTitlePrompt(to, getSession(to));
    }

    if (s.step === 'awaiting_title') {
      if (input.type === 'title_mr') return handleInteractive(to, 'title_mr', getSession(to));
      if (input.type === 'title_ms') return handleInteractive(to, 'title_ms', getSession(to));
      return sendTitlePrompt(to, s);
    }

    if (s.step === 'awaiting_custom_service') {
      if (input.type === 'text' && input.value.length >= 2) {
        return sendCustomServiceWait(to, s, input.value);
      }
      return sendText(to, t(s.lang, 'Please type the service name.', 'اكتب اسم الخدمة.'));
    }

    if (s.step === 'waiting_agent') {
      await sendText(to, t(s.lang,
        `Thanks ${displayName(s)}! Your message was received. An agent will reply soon. 🙏\n\nType MENU anytime for the main menu.`,
        `شكراً ${displayName(s)}! وصلت رسالتك. موظف سيرد قريباً. 🙏\n\nاكتب MENU للقائمة الرئيسية.`
      ));
      return;
    }

    // Free text outside menu — treat as custom streaming/gaming inquiry if on retail flow
    if (s.step === 'main_menu' || s.step === 'stream_gaming_menu') {
      return sendCustomServiceWait(to, s, text);
    }

    return sendMainMenu(to, s);
  }

  async function processMessage(from, message) {
    if (!enabled()) return;
    const to = String(from || '').replace(/\D/g, '');
    if (!to) return;

    let s = getSession(to);

    if (message.type === 'interactive') {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      const id = reply?.id;
      if (!id) return;
      if (!s || s.step === 'language') {
        if (id.startsWith('lang_')) return handleInteractive(to, id, s || {});
      }
      s = getSession(to) || s;
      return handleInteractive(to, id, s || { lang: 'en' });
    }

    if (message.type === 'text') {
      const body = message.text?.body || '';
      return handleText(to, body, s);
    }

    // Any other message type — start flow
    if (!s) {
      setSession(to, { step: 'language' });
      return sendLanguagePrompt(to);
    }
  }

  app.get('/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === verifyToken()) {
      console.log('WhatsApp webhook verified');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  const waLimiter = rateLimit ? rateLimit('whatsapp-webhook', 120, 60_000) : (req, res, next) => next();

  app.get('/whatsapp/status', (req, res) => {
    const base = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    res.json({
      ok: true,
      enabled: enabled(),
      webhookUrl: base ? `${base}/whatsapp` : null,
      hasAccessToken: Boolean(token()),
      hasPhoneNumberId: Boolean(phoneId()),
      hasVerifyToken: Boolean(verifyToken()),
      sessions: sessions.size,
    });
  });

  app.post('/whatsapp', waLimiter, async (req, res) => {
    res.sendStatus(200);
    if (!enabled()) return;
    try {
      const body = req.body;
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;
      if (!messages?.length) return;

      for (const msg of messages) {
        const from = msg.from;
        await processMessage(from, msg).catch(e => {
          console.error('WhatsApp processMessage error:', e.message);
        });
      }
    } catch (e) {
      console.error('WhatsApp webhook error:', e.message);
    }
  });

  return {
    enabled,
    sendText: (to, body) => sendText(String(to).replace(/\D/g, ''), body),
    sessionCount: () => sessions.size,
  };
}

module.exports = { registerWhatsAppBot };
