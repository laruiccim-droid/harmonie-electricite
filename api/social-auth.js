// OAuth flow pour Facebook, LinkedIn et Google Business Profile
// GET /api/social-auth?platform=facebook&action=start&pwd=XXX  â†’ redirect OAuth
// GET /api/social-auth?platform=facebook&action=callback&code=YYY  â†’ traite retour
// GET /api/social-auth?action=status  â†’ Ã©tat des connexions (protÃ©gÃ© admin)
// POST /api/social-auth?action=disconnect  â†’ dÃ©connecte une plateforme

const SB_URL = process.env.SUPABASE_URL || 'https://bqzebkobyfktemnwfwbt.supabase.co';
const SB_SVC = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PWD = process.env.ADMIN_PHOTO_PASSWORD;
const BASE = 'https://www.harmonie-electricite.com';

const CFGS = {
  facebook: {
    authUrl: 'https://www.facebook.com/v20.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v20.0/oauth/access_token',
    scope: 'pages_show_list,pages_manage_posts,pages_read_engagement,business_management',
    id: () => '3408014572713468',
    secret: () => process.env.FB_APP_SECRET,
  },
  linkedin: {
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scope: 'openid profile w_member_social',
    id: () => '78zyiprnm4225w',
    secret: () => process.env.LI_CLIENT_SECRET,
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/business.manage',
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
};

function callbackUrl(platform) {
  return `${BASE}/api/social-auth?platform=${platform}&action=callback`;
}

// â”€â”€ Supabase helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sbUpsert(platform, data) {
  const res = await fetch(`${SB_URL}/rest/v1/social_tokens`, {
    method: 'POST',
    headers: {
      apikey: SB_SVC, Authorization: `Bearer ${SB_SVC}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ platform, ...data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Supabase upsert: ' + t);
  }
}

async function sbDelete(platform) {
  await fetch(`${SB_URL}/rest/v1/social_tokens?platform=eq.${platform}`, {
    method: 'DELETE',
    headers: { apikey: SB_SVC, Authorization: `Bearer ${SB_SVC}` },
  });
}

async function sbGetAll() {
  const res = await fetch(`${SB_URL}/rest/v1/social_tokens?select=platform,page_name,expires_at,updated_at`, {
    headers: { apikey: SB_SVC, Authorization: `Bearer ${SB_SVC}` },
  });
  if (!res.ok) return [];
  return await res.json() || [];
}

// â”€â”€ Facebook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function facebookCallback(code, platform) {
  const cfg = CFGS.facebook;
  // 1. Code â†’ short-lived user token
  const u1 = new URLSearchParams({
    client_id: cfg.id(), client_secret: cfg.secret(),
    redirect_uri: callbackUrl(platform), code,
  });
  const r1 = await fetch(`${cfg.tokenUrl}?${u1}`);
  const d1 = await r1.json();
  if (d1.error) throw new Error(d1.error.message);

  // 2. Short-lived â†’ long-lived user token
  const u2 = new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: cfg.id(), client_secret: cfg.secret(),
    fb_exchange_token: d1.access_token,
  });
  const r2 = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?${u2}`);
  const d2 = await r2.json();

  // 2b. Log granted permissions
  const userToken = d2.access_token || d1.access_token;
  const rP = await fetch(`https://graph.facebook.com/v20.0/me/permissions?access_token=${userToken}`);
  const dP = await rP.json();
  console.log('Facebook granted permissions:', JSON.stringify(dP));

  // 3. Get pages â€” try /me/accounts first, then business portfolio
  const r3 = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${userToken}`);
  const d3 = await r3.json();
  console.log('Facebook /me/accounts response:', JSON.stringify(d3));

  let page = d3.data?.[0];

  if (!page) {
    // Fallback: get page token directly by known page ID (managed via Business Portfolio)
    const FB_PAGE_ID = '244371603109465';
    const rDirect = await fetch(`https://graph.facebook.com/v20.0/${FB_PAGE_ID}?fields=id,name,access_token&access_token=${userToken}`);
    const dDirect = await rDirect.json();
    console.log('Facebook direct page response:', JSON.stringify(dDirect));
    if (dDirect.access_token) {
      page = { id: dDirect.id, name: dDirect.name, access_token: dDirect.access_token };
    }
  }

  if (!page) {
    throw new Error('Aucune Page Facebook trouvÃ©e. VÃ©rifiez que vous Ãªtes administrateur et que la Page est liÃ©e Ã  votre compte.');
  }
  // 4. Récupérer le compte Instagram Business lié à la Page
  let igAccountId = null;
  let igUsername = null;
  try {
    const rIg = await fetch(`https://graph.facebook.com/v20.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
    const dIg = await rIg.json();
    console.log('Instagram business account:', JSON.stringify(dIg));
    igAccountId = dIg.instagram_business_account?.id || null;
    if (igAccountId) {
      const rIgInfo = await fetch(`https://graph.facebook.com/v20.0/${igAccountId}?fields=username&access_token=${page.access_token}`);
      const dIgInfo = await rIgInfo.json();
      igUsername = dIgInfo.username || null;
    }
  } catch (e) {
    console.log('Instagram lookup failed (non-bloquant):', e.message);
  }

  await sbUpsert('facebook', {
    access_token: page.access_token,
    refresh_token: null,
    expires_at: null,
    page_id: page.id,
    page_name: page.name,
    extra: {
      ...(d3.data?.length > 1 ? { pages: d3.data.map(p => ({ id: p.id, name: p.name })) } : {}),
      ...(igAccountId ? { ig_account_id: igAccountId, ig_username: igUsername } : {}),
    } || null,
  });

  // Sauvegarder aussi Instagram séparément si trouvé
  if (igAccountId) {
    await sbUpsert('instagram', {
      access_token: page.access_token,
      refresh_token: null,
      expires_at: null,
      page_id: igAccountId,
      page_name: igUsername ? `@${igUsername}` : `Instagram (${igAccountId})`,
      extra: { fb_page_id: page.id, fb_page_token: page.access_token },
    });
  }

  return page.name;
}

// â”€â”€ LinkedIn â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function linkedinCallback(code, platform) {
  const cfg = CFGS.linkedin;
  // 1. Code â†’ access token
  const r1 = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: callbackUrl(platform),
      client_id: cfg.id(), client_secret: cfg.secret(),
    }),
  });
  const d1 = await r1.json();
  if (d1.error) throw new Error(d1.error_description || d1.error);

  // 2. Get member ID via OpenID Connect userinfo
  const r2 = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${d1.access_token}` },
  });
  const d2 = await r2.json();
  const memberId = d2.sub || null;
  if (!memberId) throw new Error('Impossible de récupérer le member ID LinkedIn (réponse: ' + JSON.stringify(d2) + ')');
  const name = (d2.name || d2.given_name || 'Harmonie Électricité (LinkedIn)').trim();

  await sbUpsert('linkedin', {
    access_token: d1.access_token,
    refresh_token: d1.refresh_token || null,
    expires_at: d1.expires_in ? Date.now() + d1.expires_in * 1000 : null,
    page_id: memberId,
    page_name: name,
    extra: { author_urn: `urn:li:person:${memberId}` },
  });
  return name;
}

// â”€â”€ Google Business Profile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function googleCallback(code, platform) {
  const cfg = CFGS.google;
  // 1. Code â†’ tokens
  const r1 = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.id(), client_secret: cfg.secret(),
      redirect_uri: callbackUrl(platform), grant_type: 'authorization_code',
    }),
  });
  const d1 = await r1.json();
  if (d1.error) throw new Error(d1.error_description || d1.error);

  // 2. Get accounts
  const r2 = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${d1.access_token}` },
  });
  const d2 = await r2.json();
  console.log('Google accounts response:', JSON.stringify(d2));
  if (!d2.accounts?.length) {
    const detail = d2.error ? `(${d2.error.code}: ${d2.error.message})` : JSON.stringify(d2);
    throw new Error(`Aucun compte Google Business trouvÃ©. ${detail}`);
  }

  const accountName = d2.accounts[0].name; // e.g. "accounts/123456"
  const accountId = accountName.split('/').pop();

  // 3. Get locations
  const r3 = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
    { headers: { Authorization: `Bearer ${d1.access_token}` } }
  );
  const d3 = await r3.json();
  if (!d3.locations?.length) throw new Error('Aucun Ã©tablissement Google Business trouvÃ©.');

  const loc = d3.locations[0];
  const locationId = loc.name.split('/').pop();
  const locTitle = loc.title || 'Harmonie Ã‰lectricitÃ©';

  await sbUpsert('google', {
    access_token: d1.access_token,
    refresh_token: d1.refresh_token || null,
    expires_at: d1.expires_in ? Date.now() + d1.expires_in * 1000 : null,
    page_id: accountId,
    page_name: locTitle,
    extra: { location_id: locationId },
  });
  return locTitle;
}

// â”€â”€ Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { platform, action } = req.query;

  // â”€â”€ Status (liste toutes les connexions) â”€â”€
  if (action === 'status') {
    const pwd = req.headers['x-admin-password'];
    if (!ADMIN_PWD || pwd !== ADMIN_PWD) return res.status(401).json({ error: 'Non autorisÃ©' });
    const rows = await sbGetAll();
    return res.json(rows);
  }

  // â”€â”€ Disconnect â”€â”€
  if (action === 'disconnect') {
    const pwd = req.headers['x-admin-password'];
    if (!ADMIN_PWD || pwd !== ADMIN_PWD) return res.status(401).json({ error: 'Non autorisÃ©' });
    if (!platform || !CFGS[platform]) return res.status(400).json({ error: 'Plateforme invalide' });
    await sbDelete(platform);
    return res.json({ ok: true });
  }

  if (!platform || !CFGS[platform]) return res.status(400).send('Plateforme invalide');
  const cfg = CFGS[platform];

  // â”€â”€ Start OAuth (redirige vers la plateforme) â”€â”€
  if (action === 'start') {
    const pwd = req.query.pwd;
    if (!ADMIN_PWD || pwd !== ADMIN_PWD) return res.status(401).send('Non autorisÃ©');
    if (!cfg.id()) return res.status(500).send(`Variables d'environnement manquantes pour ${platform}`);

    const state = Buffer.from(JSON.stringify({ pwd, ts: Date.now() })).toString('base64url');
    const params = new URLSearchParams({
      client_id: cfg.id(),
      redirect_uri: callbackUrl(platform),
      scope: cfg.scope,
      response_type: 'code',
      state,
      ...(platform === 'google' ? { access_type: 'offline', prompt: 'consent' } : {}),
    });
    return res.redirect(302, `${cfg.authUrl}?${params}`);
  }

  // â”€â”€ OAuth Callback â”€â”€
  if (action === 'callback') {
    const { code, state, error } = req.query;
    const closeScript = (ok, nameOrErr) => {
      const msg = ok
        ? `{type:'social-auth',platform:'${platform}',success:true,name:${JSON.stringify(nameOrErr)}}`
        : `{type:'social-auth',platform:'${platform}',error:${JSON.stringify(nameOrErr)}}`;
      const color = ok ? '#C9A86A' : '#e05050';
      const icon = ok ? 'âœ…' : 'âŒ';
      const text = ok ? `${nameOrErr} connectÃ© !` : `Erreur : ${nameOrErr}`;
      return `<!DOCTYPE html><html><body style="background:#0A0A0A;color:${color};font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;">
<div><div style="font-size:3rem;margin-bottom:16px;">${icon}</div><h2 style="font-weight:600;">${text}</h2><p style="color:#7C786E;margin-top:8px;font-size:14px;">Cette fenÃªtre va se fermer automatiquementâ€¦</p></div>
<script>try{window.opener?.postMessage(${msg},'*');}catch(e){}setTimeout(()=>window.close(),2500);</script>
</body></html>`;
    };

    if (error) return res.send(closeScript(false, error));

    // Verify state
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
      if (!ADMIN_PWD || stateData.pwd !== ADMIN_PWD || Date.now() - stateData.ts > 600000) {
        return res.send(closeScript(false, 'Session expirÃ©e ou invalide'));
      }
    } catch(e) {
      return res.send(closeScript(false, 'State invalide'));
    }

    try {
      let name;
      if (platform === 'facebook') name = await facebookCallback(code, platform);
      else if (platform === 'linkedin') name = await linkedinCallback(code, platform);
      else if (platform === 'google') name = await googleCallback(code, platform);
      return res.send(closeScript(true, name));
    } catch(e) {
      console.error(`social-auth ${platform} error:`, e.message);
      return res.send(closeScript(false, e.message));
    }
  }

  return res.status(400).json({ error: 'Action inconnue' });
}

