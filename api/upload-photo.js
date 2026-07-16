import busboy from 'busboy';

export const config = { api: { bodyParser: false, sizeLimit: '25mb' } };

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://bqzebkobyfktemnwfwbt.supabase.co';
const SUPABASE_SVC  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PWD     = process.env.ADMIN_PHOTO_PASSWORD;
const BUCKET        = 'photos';

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files  = [];
    const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => files.push({
        filename: info.filename,
        mimetype: info.mimeType || 'image/jpeg',
        buffer: Buffer.concat(chunks),
      }));
    });
    bb.on('finish', () => resolve({ fields, files }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

async function uploadToStorage(buffer, path, mimetype) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC}`,
      'Content-Type': mimetype,
      'Cache-Control': 'public, max-age=31536000',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Storage upload failed: ' + txt);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function insertPhoto(url, filename, categorie, legende, show_galerie, show_accueil, chantier_id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/photos`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SVC,
      Authorization: `Bearer ${SUPABASE_SVC}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ url, filename, categorie, legende, show_galerie, show_accueil, chantier_id }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('DB insert failed: ' + txt);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let fields, files;
  try {
    ({ fields, files } = await parseMultipart(req));
  } catch (e) {
    return res.status(400).json({ error: 'Parse error: ' + e.message });
  }

  if (!ADMIN_PWD || fields.password !== ADMIN_PWD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const categorie    = fields.categorie    || 'autre';
  const legende      = fields.legende      || '';
  const show_galerie = fields.show_galerie !== 'false';
  const show_accueil = fields.show_accueil === 'true';
  const chantier_id  = fields.chantier_id  || null;

  // Si nouvelles photos cochées "Accueil" dans un chantier existant,
  // retirer show_accueil des anciennes photos du même chantier
  if (show_accueil && chantier_id) {
    await fetch(`${SUPABASE_URL}/rest/v1/photos?chantier_id=eq.${chantier_id}&show_accueil=eq.true`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SVC,
        Authorization: `Bearer ${SUPABASE_SVC}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ show_accueil: false }),
    });
  }

  const results = [];
  const errors  = [];

  for (const file of files) {
    try {
      const ext      = (file.filename.split('.').pop() || 'jpg').toLowerCase();
      const safeName = `${categorie}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const url      = await uploadToStorage(file.buffer, safeName, file.mimetype);
      await insertPhoto(url, safeName, categorie, legende, show_galerie, show_accueil, chantier_id);
      results.push({ url, filename: safeName });
    } catch (e) {
      console.error('upload error:', file.filename, e.message);
      errors.push({ filename: file.filename, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, uploaded: results.length, results, errors });
}
