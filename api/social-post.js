// Publication simultanée sur Facebook, LinkedIn et Google Business Profile
// POST /api/social-post { platforms: ['facebook','linkedin','google'], text, image_url }

const SB_URL = process.env.SUPABASE_URL || 'https://bqzebkobyfktemnwfwbt.supabase.co';
const SB_SVC = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PWD = process.env.ADMIN_PHOTO_PASSWORD;

async function getToken(platform) {
  const res = await fetch(`${SB_URL}/rest/v1/social_tokens?platform=eq.${platform}&select=*`, {
    headers: { apikey: SB_SVC, Authorization: `Bearer ${SB_SVC}` },
  });
  const rows = await res.json();
  return rows?.[0] || null;
}

async function refreshGoogleToken(tokenRow) {
  if (!tokenRow.refresh_token) throw new Error('Pas de refresh_token Google — reconnectez votre compte.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenRow.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error('Refresh Google: ' + d.error_description);
  // Update token in DB
  await fetch(`${SB_URL}/rest/v1/social_tokens?platform=eq.google`, {
    method: 'PATCH',
    headers: { apikey: SB_SVC, Authorization: `Bearer ${SB_SVC}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ access_token: d.access_token, expires_at: Date.now() + d.expires_in * 1000, updated_at: new Date().toISOString() }),
  });
  return d.access_token;
}

// ── Facebook ──────────────────────────────────────────────────────────────────

async function postFacebook(imageUrls, text, tokenRow) {
  const token = tokenRow.access_token;
  const pageId = tokenRow.page_id;

  if (imageUrls.length === 1) {
    // Photo unique : endpoint classique
    const params = new URLSearchParams({ url: imageUrls[0], message: text, access_token: token });
    const res = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return { post_id: d.post_id || d.id };
  }

  // Multi-photos : upload chaque photo sans publication, puis créer le post groupé
  const photoIds = await Promise.all(imageUrls.map(async (url) => {
    const params = new URLSearchParams({ url, published: 'false', access_token: token });
    const r = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const d = await r.json();
    if (d.error) throw new Error('FB upload photo: ' + d.error.message);
    return d.id;
  }));

  const feedBody = new URLSearchParams({ message: text, access_token: token });
  photoIds.forEach(id => feedBody.append('attached_media[]', JSON.stringify({ media_fbid: id })));
  const rFeed = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: feedBody,
  });
  const dFeed = await rFeed.json();
  if (dFeed.error) throw new Error(dFeed.error.message);
  return { post_id: dFeed.id };
}

// ── LinkedIn ──────────────────────────────────────────────────────────────────

async function uploadLinkedInImage(imageUrl, authorUrn, authHeader) {
  const r1 = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  const d1 = await r1.json();
  if (!r1.ok) throw new Error('LinkedIn init upload: ' + JSON.stringify(d1));

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error('Impossible de télécharger l\'image depuis Supabase');

  const r2 = await fetch(d1.value.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: await imgRes.arrayBuffer(),
  });
  if (!r2.ok) throw new Error('LinkedIn upload image: ' + r2.status);

  return d1.value.image;
}

async function postLinkedIn(imageUrls, text, tokenRow) {
  const authorUrn = tokenRow.extra?.author_urn || `urn:li:person:${tokenRow.page_id}`;
  const authHeader = { Authorization: `Bearer ${tokenRow.access_token}`, 'LinkedIn-Version': '202412', 'X-Restli-Protocol-Version': '2.0.0' };

  // Upload toutes les images
  const imageUrns = await Promise.all(imageUrls.map(url => uploadLinkedInImage(url, authorUrn, authHeader)));

  // Construire le contenu : media unique ou multiImage
  const content = imageUrns.length === 1
    ? { media: { title: text.substring(0, 70), id: imageUrns[0] } }
    : { multiImage: { images: imageUrns.map(id => ({ id, altText: text.substring(0, 120) })) } };

  const r3 = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: authorUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content,
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!r3.ok) {
    const err = await r3.text();
    throw new Error('LinkedIn post: ' + err);
  }
  return { post_id: r3.headers.get('x-restli-id') };
}

// ── Instagram ────────────────────────────────────────────────────────────────

async function postInstagram(imageUrls, text, tokenRow) {
  const igUserId = tokenRow.page_id;
  const accessToken = tokenRow.access_token;
  const caption = text;

  let creationId;

  if (imageUrls.length === 1) {
    // Image unique
    const r1 = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image_url: imageUrls[0], caption, access_token: accessToken }),
    });
    const d1 = await r1.json();
    if (d1.error) throw new Error('Instagram media: ' + d1.error.message);
    creationId = d1.id;
  } else {
    // Carrousel : créer un conteneur par image (sans caption), puis le carrousel
    const itemIds = await Promise.all(imageUrls.map(async (url) => {
      const r = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: url, is_carousel_item: 'true', access_token: accessToken }),
      });
      const d = await r.json();
      if (d.error) throw new Error('Instagram carousel item: ' + d.error.message);
      return d.id;
    }));

    const rCarousel = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ media_type: 'CAROUSEL', children: itemIds.join(','), caption, access_token: accessToken }),
    });
    const dCarousel = await rCarousel.json();
    if (dCarousel.error) throw new Error('Instagram carousel: ' + dCarousel.error.message);
    creationId = dCarousel.id;
  }

  // Publier le conteneur
  const rPub = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
  });
  const dPub = await rPub.json();
  if (dPub.error) throw new Error('Instagram publish: ' + dPub.error.message);
  return { post_id: dPub.id };
}

// ── Google Business Profile ───────────────────────────────────────────────────

async function postGoogle(imageUrl, text, tokenRow) {
  const accountId = tokenRow.page_id;
  const locationId = tokenRow.extra?.location_id;
  if (!locationId) throw new Error('location_id manquant — reconnectez Google.');

  // Refresh token if expired (Google tokens expire in 1h)
  let accessToken = tokenRow.access_token;
  if (tokenRow.expires_at && Date.now() > tokenRow.expires_at - 60000) {
    accessToken = await refreshGoogleToken(tokenRow);
  }

  // API Business Profile v1 (mybusiness v4 est fermée depuis 2023)
  const res = await fetch(
    `https://mybusinesslocalposts.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/localPosts`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topicType: 'STANDARD',
        summary: text,
        media: [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }],
        callToAction: { actionType: 'CALL' },
      }),
    }
  );
  const raw = await res.text();
  let d;
  try { d = JSON.parse(raw); } catch(e) {
    throw new Error(`Google HTTP ${res.status} [account=${accountId} loc=${locationId}]: ${raw.substring(0, 200)}`);
  }
  if (d.error) throw new Error(`Google ${res.status}: ${d.error.message} (${d.error.status})`);
  return { post_id: d.name };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const pwd = req.headers['x-admin-password'];
  if (!ADMIN_PWD || pwd !== ADMIN_PWD) return res.status(401).json({ error: 'Non autorisé' });

  const { platforms, text, image_url, image_urls, cover_index } = req.body;
  if (!platforms?.length) return res.status(400).json({ error: 'Aucune plateforme sélectionnée' });

  // Compatibilité : accepte image_url (ancienne API) ou image_urls (nouvelle)
  const allUrls = image_urls?.length ? image_urls : (image_url ? [image_url] : []);
  if (!allUrls.length) return res.status(400).json({ error: 'image_url(s) requis' });

  const coverIdx = cover_index ?? 0;
  const coverUrl = allUrls[coverIdx] || allUrls[0];

  // Réordonner : photo de couverture en premier
  const orderedUrls = [coverUrl, ...allUrls.filter((_, i) => i !== coverIdx)];

  const results = {};

  for (const platform of platforms) {
    try {
      const tokenRow = await getToken(platform);
      if (!tokenRow) { results[platform] = { error: 'Non connecté — allez dans l\'onglet Réseaux' }; continue; }

      if (platform === 'facebook') results[platform] = await postFacebook(orderedUrls, text, tokenRow);
      else if (platform === 'linkedin') results[platform] = await postLinkedIn(orderedUrls, text, tokenRow);
      else if (platform === 'instagram') results[platform] = await postInstagram(orderedUrls, text, tokenRow);
      else if (platform === 'google') results[platform] = await postGoogle(coverUrl, text, tokenRow);
      else results[platform] = { error: 'Plateforme inconnue' };
    } catch (e) {
      console.error(`social-post ${platform}:`, e.message);
      results[platform] = { error: e.message };
    }
  }

  const allOk = Object.values(results).every(r => !r.error);
  return res.status(allOk ? 200 : 207).json({ ok: allOk, results });
}
