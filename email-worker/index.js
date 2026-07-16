const TARGET_URL = 'https://www.harmonie-electricite.com/api/inbound-email';

// Décode le texte selon le Content-Transfer-Encoding indiqué
function decodeBody(body, encoding) {
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    try {
      return new TextDecoder('utf-8').decode(
        Uint8Array.from(atob(body.replace(/\s+/g, '')), c => c.charCodeAt(0))
      );
    } catch (e) {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([A-F0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

// Lit un en-tête MIME en gérant le repli sur plusieurs lignes (folding)
function getHeader(headers, name) {
  const re = new RegExp(name + ':\\s*([^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*)', 'i');
  const m = headers.match(re);
  if (!m) return '';
  return m[1].replace(/\r\n[ \t]/g, ' ').trim();
}

// Parcourt récursivement les parties MIME : extrait le texte brut (premier
// text/plain trouvé) et les pièces jointes PDF (en base64, telles quelles).
function parsePart(raw, out) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return;

  const headers = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + 4);

  const contentType = getHeader(headers, 'Content-Type');
  const ctMain = (contentType.split(';')[0] || '').trim().toLowerCase();
  const dispo = getHeader(headers, 'Content-Disposition');
  const encoding = getHeader(headers, 'Content-Transfer-Encoding').toLowerCase();

  if (ctMain.startsWith('multipart/')) {
    const boundaryMatch = contentType.match(/boundary="?([^";\r\n]+)"?/i);
    if (!boundaryMatch) return;
    const boundary = boundaryMatch[1];
    const parts = body.split('--' + boundary);
    for (const p of parts) {
      const trimmed = p.replace(/^\r\n/, '').replace(/\r\n$/, '');
      if (!trimmed || trimmed === '--' || trimmed.startsWith('--')) continue;
      parsePart(trimmed, out);
    }
    return;
  }

  const filenameMatch = (dispo + ' ' + contentType).match(/filename\*?=("?)([^";\r\n]+)\1/i);
  const filename = filenameMatch ? filenameMatch[2].replace(/^UTF-8''/i, '') : '';

  if (ctMain === 'application/pdf' || (filename && filename.toLowerCase().endsWith('.pdf'))) {
    const content = body.replace(/[\r\n\s]+/g, '');
    if (content) {
      out.attachments.push({ filename: filename || 'facture.pdf', content_type: 'application/pdf', content });
    }
    return;
  }

  if (ctMain === 'text/plain' && !out.text) {
    out.text = decodeBody(body.trim(), encoding);
  }
}

// Extrait le corps texte et les pièces jointes PDF d'un email brut
function parseMessage(raw) {
  const out = { text: '', attachments: [] };
  parsePart(raw, out);
  return out;
}

// Extrait les adresses email d'un en-tête "To: Nom <a@b.com>, c@d.com"
function extractEmails(headerValue) {
  const matches = headerValue.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  return matches || [];
}

export default {
  async email(message, env, ctx) {
    try {
      const buffer = await new Response(message.raw).arrayBuffer();
      const raw = new TextDecoder('utf-8').decode(buffer);

      const subject = message.headers.get('subject') || '';
      const from = message.from || '';
      // message.to = adresse d'ingestion (souvent en CCI, différente du
      // destinataire visible) ; on récupère le vrai destinataire ("À:")
      // dans l'en-tête brut pour identifier le client.
      const toHeaderRaw = message.headers.get('to') || '';
      const toEmails = extractEmails(toHeaderRaw);
      const { text, attachments } = parseMessage(raw);

      await fetch(TARGET_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-inbound-secret': env.INBOUND_SHARED_SECRET || '',
        },
        body: JSON.stringify({ from, to: toEmails, to_address: message.to || '', subject, text, attachments }),
      });
    } catch (e) {
      console.error('email-worker error:', e);
    }
  },
};
