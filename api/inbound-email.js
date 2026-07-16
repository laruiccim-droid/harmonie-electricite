import crypto from 'crypto';
import { SUPABASE_URL, sbHeaders, findClientByEmail, processInvoiceEmail } from './_lib/invoices.js';

const URGENCY_KEYWORDS = [
  'urgent', 'urgence', 'panne', 'disjoncteur', 'court[- ]?circuit',
  'sans courant', 'sans électricité', 'sans electricite', 'danger', 'fuite', 'étincelle', 'etincelle'
];
const URGENCY_REGEX = new RegExp(URGENCY_KEYWORDS.join('|'), 'i');

// Verify Resend webhook signature (Svix format: v1,<base64 hmac>)
function verifyResendSignature(req, rawBody) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;

  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretBytes = Buffer.from(secret.split('_').pop(), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return svixSignature.split(' ').some(part => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    return sig === expected;
  });
}

// Verify a shared-secret header (used par notre worker/email custom)
function verifySharedSecret(req) {
  const secret = process.env.INBOUND_SHARED_SECRET;
  if (!secret) return false;
  return req.headers['x-inbound-secret'] === secret;
}

function verifySignature(req, rawBody) {
  if (verifyResendSignature(req, rawBody)) return true;
  if (verifySharedSecret(req)) return true;
  return process.env.SKIP_SIGNATURE_CHECK === 'true';
}

async function nextInterventionId() {
  const year = new Date().getFullYear();
  try {
    const url = `${SUPABASE_URL}/rest/v1/interventions?select=id&order=id.desc&limit=50`;
    const r = await fetch(url, { headers: sbHeaders() });
    let max = 0;
    if (r.ok) {
      const rows = await r.json();
      rows.forEach(row => {
        if (row.id && row.id.startsWith('INT' + year)) {
          const n = parseInt(row.id.slice(7), 10) || 0;
          if (n > max) max = n;
        }
      });
    }
    return 'INT' + year + '-' + String(max + 1).padStart(3, '0');
  } catch (e) {
    console.error('nextInterventionId error:', e);
    return 'INT' + year + '-' + String(Date.now()).slice(-3);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody = '';
  try {
    rawBody = JSON.stringify(req.body || {});
  } catch (e) {
    rawBody = '';
  }

  if (!verifySignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const payload = req.body || {};
    const data = payload.data || payload;

    // Une facture EBP arrive toujours avec une pièce jointe PDF -> on bascule
    // sur le traitement facture plutôt que sur la création d'intervention.
    const hasPdfAttachment = (data.attachments || []).some(a => {
      const ct = (a.content_type || a.contentType || a.type || '').toLowerCase();
      const fn = (a.filename || a.name || '').toLowerCase();
      return ct.includes('pdf') || fn.endsWith('.pdf');
    });
    if (hasPdfAttachment) {
      const result = await processInvoiceEmail(data);
      return res.status(200).json(result);
    }

    const fromEmail = (data.from?.email || data.from || '').toString().trim().toLowerCase();
    const subject = (data.subject || '').toString();
    const text = (data.text || data.html || '').toString();

    const fullText = `${subject}\n${text}`;
    const urgent = URGENCY_REGEX.test(fullText);

    const client = await findClientByEmail(fromEmail);
    const id = await nextInterventionId();
    const now = Date.now();

    const interventionPayload = {
      id,
      client_id: client ? client.id : null,
      client_nom: client ? client.name : fromEmail,
      residence_id: null,
      residence_nom: null,
      adresse: null,
      description: subject ? `${subject}\n\n${text}` : text,
      type: 'intervention',
      statut: 'attente_planification',
      urgent,
      source: 'email',
      from_email: fromEmail,
      date_demande: new Date().toISOString().split('T')[0],
      date_planifiee: null,
      notif_assistante: { devis: false, facture: false, lue: false },
      createdAt: now,
      updatedAt: now,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/interventions`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ id, payload: interventionPayload }),
    });

    if (!insertRes.ok) {
      console.error('Supabase insert error:', await insertRes.text());
    }

    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error('inbound-email error:', e);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
