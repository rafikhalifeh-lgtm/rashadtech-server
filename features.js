/* rashadtech.tv feature enhancements */
(function(){
  const WA = 'https://wa.me/96179306701';

  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function daysLeft(exp){
    if(!exp)return null;
    const p=String(exp).split('/');
    if(p.length!==3)return null;
    const d=new Date(+p[2],+p[1]-1,+p[0]);const n=new Date();n.setHours(0,0,0,0);d.setHours(0,0,0,0);
    return Math.round((d-n)/86400000);
  }
  function expiryBadge(exp){
    const d=daysLeft(exp);if(d===null)return '';
    const lang=(typeof currentLang!=='undefined'&&currentLang==='ar')?'ar':'en';
    if(d<0)return `<span style="font-size:10px;color:var(--red);font-weight:700">${lang==='ar'?'منتهي':'Expired'}</span>`;
    if(d<=3)return `<span style="font-size:10px;color:var(--red);font-weight:700">${d}${lang==='ar'?' يوم':'d left'}</span>`;
    if(d<=7)return `<span style="font-size:10px;color:var(--orange);font-weight:700">${d}${lang==='ar'?' يوم':'d left'}</span>`;
    return `<span style="font-size:10px;color:var(--green);font-weight:700">${d}${lang==='ar'?' يوم':'d left'}</span>`;
  }

  window.rtShowLoading=function(msg){
    let el=document.getElementById('rt-loading');
    if(!el){el=document.createElement('div');el.id='rt-loading';el.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';document.body.appendChild(el);}
    el.innerHTML=`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px 22px;font-size:13px;color:var(--text)">${esc(msg||'Loading...')}</div>`;
    el.style.display='flex';
  };
  window.rtHideLoading=function(){const el=document.getElementById('rt-loading');if(el)el.style.display='none';};

  async function api(path,opts={}){
    if(typeof window.rtApi==='function')return window.rtApi(path,opts);
    opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
    if(typeof authHeaders==='function')Object.assign(opts.headers,authHeaders());
    const r=await fetch((window.RT_SERVER||'')+path,opts);
    const j=await r.json().catch(()=>({}));
    if(!r.ok||j.success===false)throw new Error(j.error||'Request failed');
    return j;
  }

  window.placeFulfilledOrder=function(u,po,acc){
    const order={id:po.id,product:po.product,short:po.short,color:po.color,tc:po.tc,productId:po.productId,plan:po.plan,price:po.price,email:acc.email,pass:acc.pass,date:po.date,expiryDate:acc.expiryDate||null,profileName:po.profileName||'',profilePin:acc.profilePin||'',accKey:acc.accKey||'',mainEmail:acc.mainEmail||'',...(acc.extra?{extra:acc.extra}:{})};
    if(po.assignCustId!=null&&po.assignCustId!==undefined){
      const c=(u.myCustomers||[]).find(x=>x.id===po.assignCustId);
      if(c){order.profileName=order.profileName||c.fname;(c.subs=c.subs||[]).unshift(order);return order;}
    }
    (u.orders=u.orders||[]).unshift(order);return order;
  };

  const _autoFulfill=window.autoFulfillPending;
  if(typeof _autoFulfill==='function'){
    window.autoFulfillPending=async function(skey){
      let pending=[];try{if(_jbCache&&_jbCache.pending)pending=_jbCache.pending;else{_jbCache=await jbRead();if(_jbCache.pending)pending=_jbCache.pending;}}catch(e){}
      const waiting=pending.filter(po=>po.skey===skey);if(!waiting.length)return;
      let fulfilled=0;
      for(const po of [...waiting]){
        const acc=getNextAcc(skey);if(!acc)break;
        const idx=getAccounts(skey).indexOf(acc);markUsed(skey,idx);
        const u=users.find(x=>x.email===po.userEmail);
        if(u)placeFulfilledOrder(u,po,acc);
        pending.splice(pending.findIndex(x=>x.id===po.id),1);fulfilled++;
        const tgId=u?.tgChatId||po.userTgChatId||'';
        if(tgId){
          const linkData={id:po.id,product:po.product,short:po.short,color:po.color,tc:po.tc,productId:po.productId,plan:po.plan,email:acc.email,pass:acc.pass,expiryDate:acc.expiryDate||'',profileName:po.profileName||'',profilePin:acc.profilePin||'',accKey:acc.accKey||'',mainEmail:acc.mainEmail||'',codeEmail:acc.email,inboxEmail:acc.mainEmail||acc.email};
          const subLink=await createSubLinkUrl(linkData);
          let msg=`✅ <b>Your ${po.product} is ready!</b>\n\n📋 ${po.plan}\n📧 <code>${acc.email}</code>\n🔑 <code>${acc.pass}</code>`;
          if(acc.profilePin)msg+=`\n🔢 PIN: <code>${acc.profilePin}</code>`;
          msg+=`\n\n🔗 ${subLink}`;
          await sendTelegramToUser(tgId,msg);
        }
      }
      if(fulfilled>0){try{if(!_jbCache)_jbCache=await jbRead();_jbCache.pending=pending;await jbWrite(_jbCache);}catch(e){}await saveData();showToast(`✓ Auto-fulfilled ${fulfilled} pending`);renderAdminPending();}
    };
  }

  const _manualFulfill=window.manualFulfillPending;
  window.manualFulfillPending=async function(i){
    try{
      rtShowLoading('Fulfilling order...');
      let pending=Array.isArray(_jbCache?.pending)?[..._jbCache.pending]:[];
      try{if(!pending.length){_jbCache=await jbRead();pending=_jbCache.pending||[];}}catch(e){}
      const po=pending[i];if(!po)throw new Error('Order not found');
      const j=await api('/admin/fulfill-pending',{method:'POST',body:JSON.stringify({orderId:po.id})});
      applyDataSnapshot(j.data||_jbCache);
      renderAdminPending();renderStockPanels();renderSubs();renderMyCustomers();
      showToast('✓ Order fulfilled');
    }catch(e){showToast('⚠️ '+e.message);}
    finally{rtHideLoading();}
  };

  const _activateTV=window.activateTV;
  window.activateTV=async function(){
    const code=document.getElementById('tv-code-input')?.value.trim().toUpperCase();
    const status=document.getElementById('tv-activate-status');
    if(!code||code.length<4){if(status){status.textContent='⚠️ Enter the 8-character code from your TV';status.style.color='var(--orange)';}return;}
    try{await navigator.clipboard.writeText(code);}catch(e){}
    const profile=_sublinkProfileName||'your profile';
    const pin=document.getElementById('sublink-profile-pin')?.textContent?.trim();
    const tvUrl=`https://www.netflix.com/tv8?code=${encodeURIComponent(code)}`;
    if(status){
      status.innerHTML=`✓ Code copied. Opening Netflix…<br>Log in with the email/password above, then confirm the code.<br>On TV choose <b>${esc(profile)}</b>${pin?` and enter PIN <b>${esc(pin)}</b>`:''}.`;
      status.style.color='var(--green)';
    }
    setTimeout(()=>window.open(tvUrl,'_blank'),400);
  };

  window.rtReportIssue=async function(issueType,details,subscription){
    try{
      await api('/report-issue',{method:'POST',body:JSON.stringify({issueType,details,subscription,customerEmail:currentUser?.email,customerName:currentUser?.name})});
      showToast(typeof currentLang!=='undefined'&&currentLang==='ar'?'✓ تم الإبلاغ عن المشكلة':'✓ Issue sent to support');
    }catch(e){showToast('⚠️ '+e.message);}
  };

  window.rtChangePassword=function(){
    if(typeof openChangePasswordModal==='function')return openChangePasswordModal();
    const cur=prompt('Current password:');if(!cur)return;
    const np=prompt('New password (min 6 chars):');if(!np||np.length<6){showToast('Password too short');return;}
    api('/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword:cur,newPassword:np})})
      .then(()=>showToast('✓ Password updated'))
      .catch(e=>showToast('⚠️ '+e.message));
  };

  window.rtRevokeCurrentLink=async function(){
    const token=new URLSearchParams(location.search).get('t');
    if(!token){showToast('No link token');return;}
    if(!confirm('Revoke this subscription link? Old links will stop working.'))return;
    try{await api('/links/revoke',{method:'POST',body:JSON.stringify({token})});showToast('✓ Link revoked');}
    catch(e){showToast('⚠️ '+e.message);}
  };

  async function loadPromoBanner(){
    try{
      const j=await api('/site-settings');
      const text=j.settings?.promoBanner;
      const el=document.getElementById('store-promo-banner');
      if(el&&text){el.style.display='block';el.textContent=text;}
    }catch(e){}
  }

  async function loadAdminEnhancements(){
    if(!isAdmin)return;
    try{
      const [analytics, aliases, activity, settings]=await Promise.all([
        api('/admin/analytics').catch(()=>({analytics:{}})),
        api('/admin/netflix-aliases').catch(()=>({aliases:[]})),
        api('/admin/activity').catch(()=>({activity:[]})),
        api('/site-settings').catch(()=>({settings:{}}))
      ]);
      const dash=document.getElementById('dashboard-analytics');
      if(dash&&analytics.analytics){
        const a=analytics.analytics;
        dash.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
          <div class="card card-pad"><div style="font-size:11px;color:var(--text3)">Users</div><div style="font-size:20px;font-weight:700">${a.users}</div></div>
          <div class="card card-pad"><div style="font-size:11px;color:var(--text3)">Revenue</div><div style="font-size:20px;font-weight:700">$${Number(a.revenue||0).toFixed(0)}</div></div>
          <div class="card card-pad"><div style="font-size:11px;color:var(--text3)">Pending</div><div style="font-size:20px;font-weight:700">${a.pending}</div></div>
          <div class="card card-pad"><div style="font-size:11px;color:var(--text3)">Stock free</div><div style="font-size:20px;font-weight:700">${a.stockAvailable}</div></div>
        </div>`;
      }
      const aliasEl=document.getElementById('netflix-alias-usage');
      if(aliasEl){
        aliasEl.innerHTML=(aliases.aliases||[]).length?(aliases.aliases||[]).map(a=>`<div style="font-size:12px;padding:8px 0;border-bottom:1px solid var(--border)"><b>${esc(a.alias)}</b> — 1-user ${a.usedOneUser}/${a.oneUser} · full ${a.usedFull}/${a.full}</div>`).join(''):'<div style="color:var(--text3);font-size:12px">No Netflix aliases in stock.</div>';
      }
      const actEl=document.getElementById('admin-activity-server');
      if(actEl){
        actEl.innerHTML=(activity.activity||[]).slice(0,20).map(x=>`<div style="font-size:11px;padding:6px 0;border-bottom:1px solid var(--border)"><b>${esc(x.action)}</b> — ${esc(x.details||'')} <span style="color:var(--text3)">${esc(x.time||'')}</span></div>`).join('')||'<div style="color:var(--text3)">No activity yet.</div>';
      }
      const promoInp=document.getElementById('admin-promo-banner');
      const refInp=document.getElementById('admin-referral-code');
      const refDisc=document.getElementById('admin-referral-discount');
      if(promoInp)promoInp.value=settings.settings?.promoBanner||'';
      if(refInp)refInp.value=settings.settings?.referralCode||'';
      if(refDisc)refDisc.value=settings.settings?.referralDiscount||'';
    }catch(e){console.warn('admin enhancements',e);}
  }

  window.rtSaveSiteSettings=async function(){
    try{
      await api('/admin/site-settings',{method:'POST',body:JSON.stringify({
        promoBanner:document.getElementById('admin-promo-banner')?.value||'',
        referralCode:document.getElementById('admin-referral-code')?.value||'',
        referralDiscount:Number(document.getElementById('admin-referral-discount')?.value||0)
      })});
      showToast('✓ Settings saved');loadPromoBanner();
    }catch(e){showToast('⚠️ '+e.message);}
  };

  window.rtBulkImportStock=async function(){
    const skey=curAccModalKey;const raw=prompt('Paste CSV rows: email,pass,expiry,pin,mainEmail');
    if(!raw||!skey)return;
    const rows=raw.split('\n').map(line=>{const p=line.split(',').map(x=>x.trim());return {email:p[0],pass:p[1],expiryDate:p[2]||'',profilePin:p[3]||'',mainEmail:p[4]||''};}).filter(r=>r.email&&r.pass);
    try{rtShowLoading('Importing...');const j=await api('/admin/bulk-stock',{method:'POST',body:JSON.stringify({skey,rows})});showToast(`✓ Added ${j.added} accounts`);await refreshFromFirebase();renderStockPanels();renderAccModal(false);}
    catch(e){showToast('⚠️ '+e.message);}finally{rtHideLoading();}
  };

  window.rtExportOrders=async function(){
    try{
      const r=await fetch((window.RT_SERVER||'')+'/admin/export-orders',{headers:authHeaders()});
      const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='rashadtech-orders.csv';a.click();
    }catch(e){showToast('⚠️ Export failed');}
  };

  window.rtTestGmail=async function(email){
    try{rtShowLoading('Testing Gmail...');const j=await api('/admin/gmail-test',{method:'POST',body:JSON.stringify({email})});showToast('✓ '+j.message);loadGmailMonitorPanel();}
    catch(e){showToast('⚠️ '+e.message);}finally{rtHideLoading();}
  };

  async function loadGmailMonitorPanel(){
    const el=document.getElementById('gmail-monitor-panel');if(!el||!isAdmin)return;
    try{
      const j=await api('/monitored-emails');
      el.innerHTML=(j.emails||[]).map(e=>`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
        <div><b>${esc(e.email)}</b><div style="color:var(--text3)">Last check: ${e.lastCheckedAt?new Date(e.lastCheckedAt).toLocaleString():'never'}</div></div>
        <button onclick="rtTestGmail('${esc(e.email)}')" style="padding:6px 10px;border:1px solid var(--border);background:var(--bg3);border-radius:6px;cursor:pointer">Test</button>
      </div>`).join('')||'<div style="color:var(--text3);font-size:12px">No Gmail monitors configured.</div>';
    }catch(e){el.innerHTML='<div style="color:var(--red);font-size:12px">Could not load monitors</div>';}
  }
  window.loadGmailMonitorPanel=loadGmailMonitorPanel;

  window.rtRequestRenewal=async function(orderId,product,plan,expiryDate){
    try{
      await api('/customer/renew-request',{method:'POST',body:JSON.stringify({orderId,product,plan,expiryDate})});
      showToast(typeof currentLang!=='undefined'&&currentLang==='ar'?'✓ تم إرسال طلب التجديد':'✓ Renewal request sent');
    }catch(e){showToast('⚠️ '+e.message);}
  };

  function injectUI(){
    const store=document.getElementById('tab-store');
    if(store&&!document.getElementById('store-promo-banner')){
      const b=document.createElement('div');b.id='store-promo-banner';b.style.cssText='display:none;background:var(--blue-bg);border:1px solid var(--blue-border);color:var(--blue);padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;font-weight:600';
      store.insertBefore(b,store.firstChild.nextSibling);
    }
    const dash=document.getElementById('admin-dashboard');
    if(dash&&!document.getElementById('dashboard-analytics')){
      const wrap=document.createElement('div');wrap.style.marginBottom='14px';
      wrap.innerHTML='<div style="font-size:13px;font-weight:700;margin-bottom:8px" data-t="analytics">Analytics</div><div id="dashboard-analytics"></div>';
      dash.prepend(wrap);
    }
    const stockTab=document.getElementById('admin-stock');
    if(stockTab&&!document.getElementById('stock-search')){
      const search=document.createElement('input');
      search.id='stock-search';search.placeholder='🔍 Search stock by product or alias...';
      search.style.cssText='width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);margin-bottom:12px';
      search.oninput=()=>{if(typeof renderStockPanels==='function')renderStockPanels();};
      stockTab.insertBefore(search,stockTab.firstChild);
    }
    if(stockTab&&!document.getElementById('gmail-monitor-panel')){
      const block=document.createElement('div');block.className='card card-pad';block.style.marginBottom='12px';
      block.innerHTML=`<div style="font-weight:700;margin-bottom:8px">Gmail monitors</div><div id="gmail-monitor-panel"></div>
        <div style="margin-top:12px;font-weight:700">Netflix alias usage</div><div id="netflix-alias-usage"></div>
        <div style="margin-top:12px"><button onclick="rtBulkImportStock()" style="padding:8px 12px;border:1px solid var(--border);background:var(--bg3);border-radius:6px;cursor:pointer" data-t="bulkImport">Bulk import CSV</button>
        <button onclick="rtExportOrders()" style="padding:8px 12px;border:1px solid var(--border);background:var(--bg3);border-radius:6px;cursor:pointer;margin-left:6px" data-t="exportOrders">Export orders CSV</button></div>
        <div style="margin-top:12px;font-weight:700">Site settings</div>
        <input id="admin-promo-banner" placeholder="Promo banner text" style="width:100%;margin:6px 0;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text)">
        <div style="display:flex;gap:8px"><input id="admin-referral-code" placeholder="Referral code" style="flex:1;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text)">
        <input id="admin-referral-discount" type="number" placeholder="Discount %" style="width:90px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text)"></div>
        <button onclick="rtSaveSiteSettings()" style="margin-top:6px;padding:8px 12px;border:none;background:var(--red);color:#fff;border-radius:6px;cursor:pointer">Save settings</button>
        <div style="margin-top:12px;font-weight:700">Server activity</div><div id="admin-activity-server"></div>`;
      stockTab.prepend(block);
    }
    const tv=document.getElementById('sublink-tv-section');
    if(tv&&!document.getElementById('sublink-tv-profile-hint')){
      const hint=document.createElement('div');hint.id='sublink-tv-profile-hint';hint.style.cssText='font-size:11px;color:var(--blue);margin-top:8px';
      tv.appendChild(hint);
    }
    const subContent=document.getElementById('sublink-content');
    if(subContent&&!document.getElementById('rt-issue-btn')){
      const row=document.createElement('div');row.style.marginTop='10px';
      row.innerHTML=`<button id="rt-issue-btn" onclick="rtReportIssue('subscription link','From sub link',{email:_sublinkEmail,product:document.getElementById('sublink-name')?.textContent})" style="width:100%;padding:10px;border:1px solid var(--orange-border);background:var(--orange-bg);color:var(--orange);border-radius:8px;cursor:pointer;font-weight:600" data-t="reportIssue">⚠️ Report issue</button>`;
      subContent.appendChild(row);
    }
    if(!document.getElementById('rt-features-style')){
      const style=document.createElement('style');style.id='rt-features-style';
      style.textContent=`@media(max-width:768px){.admin-wallet-row{flex-wrap:wrap}.aw-input{min-width:70px}.snav{font-size:12px;padding:8px}} #page-sublink[data-theme]{background:var(--bg);color:var(--text)}`;
      document.head.appendChild(style);
    }
    const subPage=document.getElementById('page-sublink');
    if(subPage&&localStorage.getItem('rt_theme'))subPage.setAttribute('data-theme',localStorage.getItem('rt_theme'));
    if(typeof setLang==='function'&&typeof currentLang!=='undefined')setLang(currentLang,true);
  }

  function updateTvProfileHint(){
    const el=document.getElementById('sublink-tv-profile-hint');if(!el)return;
    const profile=document.getElementById('sublink-profile-name')?.textContent?.trim();
    const pin=document.getElementById('sublink-profile-pin')?.textContent?.trim();
    if(profile)el.innerHTML=`On TV after activation, choose profile <b>${esc(profile)}</b>${pin?` and enter PIN <b>${esc(pin)}</b>`:''}.`;
  }

  function bootstrap(){
    injectUI();
    loadPromoBanner();
    setInterval(updateTvProfileHint,1000);
    if(typeof isAdmin!=='undefined'&&isAdmin){loadAdminEnhancements();loadGmailMonitorPanel();}
  }
  window.rtBootstrapFeatures=bootstrap;

  const _origEnter=window.enterApp;
  if(typeof _origEnter==='function'){
    window.enterApp=function(){_origEnter();bootstrap();};
  }

  const _origShowProfile=window.showProfilePage;
  if(typeof _origShowProfile==='function'){
    window.showProfilePage=function(){_origShowProfile();if(typeof setLang==='function'&&typeof currentLang!=='undefined')setLang(currentLang,true);};
  }

  const _origReqCode=window.requestSigninCode;
  if(typeof _origReqCode==='function'){
    window.requestSigninCode=async function(){
      const cooldownKey='rt_code_req_'+(_sublinkCodeEmail||_sublinkEmail||'default');
      const lastReq=Number(localStorage.getItem(cooldownKey)||0);
      const wait=Math.max(0,60000-(Date.now()-lastReq));
      const status=document.getElementById('request-code-status');
      if(wait>0&&status){status.textContent=`Please wait ${Math.ceil(wait/1000)}s before requesting again`;status.style.color='var(--orange)';return;}
      return _origReqCode();
    };
  }

  const _origRenderStock=window.renderStockPanels;
  if(typeof _origRenderStock==='function'){
    window.renderStockPanels=function(){
      const q=(document.getElementById('stock-search')?.value||'').toLowerCase();
      _origRenderStock();
      if(!q)return;
      document.querySelectorAll('#admin-stock .stock-panel').forEach(panel=>{
        const text=panel.textContent.toLowerCase();
        panel.style.display=text.includes(q)?'':'none';
      });
    };
  }
  const _origAdminLogin=window.doAdminLogin;
  if(typeof _origAdminLogin==='function'){
    window.doAdminLogin=async function(){
      try{rtShowLoading('Signing in...');await _origAdminLogin();loadAdminEnhancements();loadGmailMonitorPanel();}
      finally{rtHideLoading();}
    };
  }
  const _origLogin=window.doLogin;
  if(typeof _origLogin==='function'){
    window.doLogin=async function(){try{rtShowLoading('Signing in...');await _origLogin();}finally{rtHideLoading();}};
  }
  const _origSignup=window.doSignup;
  if(typeof _origSignup==='function'){
    window.doSignup=async function(){try{rtShowLoading('Creating account...');await _origSignup();}finally{rtHideLoading();}};
  }

  if(typeof LANG!=='undefined'){
    Object.assign(LANG.en,{analytics:'Analytics',exportOrders:'Export orders',bulkImport:'Bulk import'});
    Object.assign(LANG.ar,{analytics:'الإحصائيات',exportOrders:'تصدير الطلبات',bulkImport:'استيراد جماعي'});
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',bootstrap);
  }else{
    bootstrap();
  }
})();
