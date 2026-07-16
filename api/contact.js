export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://www.harmonie-electricite.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nom, telephone, type_projet, commune, message } = req.body || {};

  if (!nom || !message) {
    return res.status(400).json({ success: false, error: 'Champs manquants' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'Clé API manquante' });

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;padding:32px;border-radius:8px;">
      <h2 style="color:#0A0A0A;border-bottom:2px solid #C9A86A;padding-bottom:12px;">
        📩 Nouveau message depuis le site
      </h2>
      <table style="width:100%;border-collapse:collapse;margin-top:20px;">
        <tr><td style="padding:10px 0;color:#555;width:140px;font-weight:600;">Nom</td><td style="padding:10px 0;color:#222;">${nom}</td></tr>
        <tr style="background:#fff;"><td style="padding:10px 8px;color:#555;font-weight:600;">Téléphone</td><td style="padding:10px 8px;color:#222;"><a href="tel:${telephone}" style="color:#C9A86A;">${telephone}</a></td></tr>
        <tr><td style="padding:10px 0;color:#555;font-weight:600;">Type de projet</td><td style="padding:10px 0;color:#222;">${type_projet || '—'}</td></tr>
        <tr style="background:#fff;"><td style="padding:10px 8px;color:#555;font-weight:600;">Commune</td><td style="padding:10px 8px;color:#222;">${commune || '—'}</td></tr>
      </table>
      <div style="margin-top:20px;background:#fff;padding:16px;border-radius:6px;border-left:3px solid #C9A86A;">
        <strong style="color:#555;">Message :</strong>
        <p style="color:#222;margin-top:8px;line-height:1.6;">${message.replace(/\n/g, '<br>')}</p>
      </div>
      <p style="margin-top:24px;font-size:12px;color:#aaa;text-align:center;">
        Harmonie Électricité · 225 chemin des Bochets, 73170 Yenne · <a href="https://www.harmonie-electricite.com" style="color:#C9A86A;">harmonie-electricite.com</a>
      </p>
    </div>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Harmonie Électricité <contact@harmonie-electricite.com>',
        to: ['contact@harmonie-electricite.com'],
        reply_to: telephone ? undefined : undefined,
        subject: `Message de ${nom} — Site Harmonie Électricité`,
        html,
      }),
    });

    const data = await response.json();
    if (response.ok) {
      return res.status(200).json({ success: true });
    } else {
      console.error('Resend error:', data);
      return res.status(500).json({ success: false, error: data });
    }
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
