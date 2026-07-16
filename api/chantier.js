export const config = { api: { bodyParser: true } };

const SB_URL = process.env.SUPABASE_URL || 'https://bqzebkobyfktemnwfwbt.supabase.co';
const SB_SVC = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PWD = process.env.ADMIN_PHOTO_PASSWORD;

async function sb(path, method = 'GET', body, prefer) {
  const h = { apikey: SB_SVC, Authorization: `Bearer ${SB_SVC}` };
  if (body) { h['Content-Type'] = 'application/json'; }
  if (prefer) { h['Prefer'] = prefer; }
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function deleteFromStorage(filename) {
  const res = await fetch(`${SB_URL}/storage/v1/object/photos/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SB_SVC}` },
  });
  return res.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const pwd = req.headers['x-admin-password'];
  if (!ADMIN_PWD || pwd !== ADMIN_PWD) return res.status(401).json({ error: 'Non autorisé' });

  const { action } = req.query;

  try {
    // ── Chantiers ──────────────────────────────────────────────
    if (action === 'list-chantiers') {
      const chantiers = await sb('chantiers?select=*&order=created_at.desc');
      const photos = await sb('photos?select=id,url,chantier_id,filename,categorie,show_galerie,show_accueil,created_at&order=created_at.asc');
      const map = {};
      for (const p of photos) {
        if (!p.chantier_id) continue;
        if (!map[p.chantier_id]) map[p.chantier_id] = [];
        map[p.chantier_id].push(p);
      }
      return res.json(chantiers.map(c => ({ ...c, photos: map[c.id] || [] })));
    }

    if (action === 'create-chantier') {
      const { titre, description, categorie, show_galerie, show_accueil } = req.body;
      const row = await sb('chantiers?select=*', 'POST', { titre, description, categorie: categorie || 'autre', show_galerie: show_galerie !== false, show_accueil: !!show_accueil }, 'return=representation');
      return res.json(Array.isArray(row) ? row[0] : row);
    }

    if (action === 'update-chantier') {
      const { id, titre, description, categorie, show_galerie, show_accueil } = req.body;
      await sb(`chantiers?id=eq.${id}`, 'PATCH', { titre, description, categorie, show_galerie, show_accueil });
      return res.json({ ok: true });
    }

    if (action === 'set-cover') {
      const { chantier_id, cover_url } = req.body;
      await sb(`chantiers?id=eq.${chantier_id}`, 'PATCH', { cover_url });
      return res.json({ ok: true });
    }

    if (action === 'delete-chantier') {
      const { id } = req.body;
      // Unlink photos first
      await sb(`photos?chantier_id=eq.${id}`, 'PATCH', { chantier_id: null });
      await sb(`chantiers?id=eq.${id}`, 'DELETE');
      return res.json({ ok: true });
    }

    // ── Photos ─────────────────────────────────────────────────
    if (action === 'list-unclassified') {
      const photos = await sb('photos?select=*&chantier_id=is.null&order=created_at.desc');
      return res.json(photos);
    }

    if (action === 'move-photo') {
      const { photo_id, chantier_id } = req.body;
      const patch = { chantier_id: chantier_id || null };
      if (chantier_id) {
        const chantiers = await sb(`chantiers?id=eq.${chantier_id}&select=categorie,show_galerie,show_accueil`);
        if (chantiers && chantiers[0]) {
          patch.categorie = chantiers[0].categorie;
          patch.show_galerie = chantiers[0].show_galerie;
          patch.show_accueil = chantiers[0].show_accueil;
        }
      }
      await sb(`photos?id=eq.${photo_id}`, 'PATCH', patch);
      return res.json({ ok: true });
    }

    if (action === 'update-photo') {
      const { photo_id, categorie, legende, show_galerie, show_accueil, chantier_id } = req.body;
      const patch = {};
      if (categorie !== undefined) patch.categorie = categorie;
      if (legende !== undefined) patch.legende = legende;
      if (show_galerie !== undefined) patch.show_galerie = show_galerie;
      if (show_accueil !== undefined) patch.show_accueil = show_accueil;
      if (chantier_id !== undefined) patch.chantier_id = chantier_id || null;
      await sb(`photos?id=eq.${photo_id}`, 'PATCH', patch);
      return res.json({ ok: true });
    }

    if (action === 'delete-photo') {
      const { photo_id } = req.body;
      const rows = await sb(`photos?id=eq.${photo_id}&select=filename`);
      if (rows && rows[0] && rows[0].filename && !rows[0].filename.startsWith('http')) {
        await deleteFromStorage(rows[0].filename);
      }
      await sb(`photos?id=eq.${photo_id}`, 'DELETE');
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Action inconnue: ' + action });
  } catch (e) {
    console.error('chantier api error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
