import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { processInvoiceEmail } from './_lib/invoices.js';

// Relève la boîte mail dédiée (ex. factures@harmonie-electricite.com) par IMAP,
// traite les emails non lus contenant une pièce jointe PDF comme des factures
// EBP (cf. processInvoiceEmail), puis les marque comme lus.
// Déclenché par un Vercel Cron (quotidien) et/ou par un bouton manuel dans l'app métier.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const host = process.env.IMAP_HOST;
  const port = parseInt(process.env.IMAP_PORT || '993', 10);
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;

  if (!host || !user || !pass) {
    return res.status(200).json({ ok: false, error: 'imap_not_configured' });
  }

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const results = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids) {
        try {
          const message = await client.fetchOne(uid, { source: true, uid: true, size: true, envelope: true, bodyStructure: true, flags: true }, { uid: true });
          if (!message || !message.source) {
            results.push({
              uid,
              ok: false,
              error: 'no_source',
              messageKeys: message ? Object.keys(message) : null,
              size: message?.size,
              envelopeSubject: message?.envelope?.subject,
              bodyStructureType: message?.bodyStructure?.type,
              bodyStructureChildren: message?.bodyStructure?.childNodes?.map(c => ({ type: c.type, disposition: c.disposition, part: c.part })) || null,
            });
            continue;
          }
          const parsed = await simpleParser(message.source);

          const attachments = (parsed.attachments || [])
            .filter(a => (a.contentType || '').toLowerCase().includes('pdf') || (a.filename || '').toLowerCase().endsWith('.pdf'))
            .map(a => ({
              filename: a.filename || 'facture.pdf',
              content_type: a.contentType || 'application/pdf',
              content: a.content.toString('base64'),
            }));

          const toEmails = (parsed.to?.value || []).map(t => t.address).filter(Boolean);

          const data = {
            subject: parsed.subject || '',
            text: parsed.text || '',
            to: toEmails,
            to_address: user,
            attachments,
          };

          if (attachments.length) {
            const result = await processInvoiceEmail(data);
            results.push({ uid, ...result, subject: data.subject });
          } else {
            const allAttachments = (parsed.attachments || []).map(a => ({
              filename: a.filename || null,
              contentType: a.contentType || null,
            }));
            results.push({ uid, ok: false, error: 'no_pdf', subject: data.subject, allAttachments });
          }

          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) {
          console.error('check-invoices: erreur traitement message', uid, e);
          results.push({ uid, ok: false, error: e.message });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('check-invoices error:', e);
    return res.status(200).json({ ok: false, error: e.message });
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}
