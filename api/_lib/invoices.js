// Logique partagée de traitement des factures EBP reçues par email
// (utilisée par api/inbound-email.js et api/check-invoices.js)

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bqzebkobyfktemnwfwbt.supabase.co';
export const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Regex pour extraire la référence chantier / N° d'OS du sujet ou du corps du mail,
// ex. "Réf. chantier : OS-2026-0123" ou simplement "OS-2026-0123"
const REFERENCE_REGEX = /R[ée]f\.?\s*(?:chantier)?\s*\/?\s*(?:N°?\s*d['’]?OS)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-_\/]{2,})/i;
const FALLBACK_REFERENCE_REGEX = /\b(OS[-_]?\d{4}[-_]?\d+)\b/i;
// Fallback supplémentaire : "Demande N°7464406" (numéro de demande EBP), au cas où
// ce numéro a été utilisé comme référence chantier sur le devis/bon dans l'app.
const DEMANDE_REGEX = /demande[^\n:]*?n[°o]?\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-_]{3,})/i;

// Regex pour extraire le code/n° de client EBP depuis le texte d'un PDF
// (formats EBP courants : "Code client : C001234", "N° de compte : 1234", "N° client : 1234")
const EBP_CLIENT_CODE_REGEX = /(?:code\s*client|n[°o]\s*(?:de\s*)?(?:compte|client))\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-_]{2,})/i;
// Format de code client EBP utilisé dans cette base ("CL" + chiffres, ex. CL00593).
// La mise en page PDF place souvent ce code avant son libellé "Code client" lors de
// l'extraction du texte (colonnes), donc cette regex sert de premier essai.
const EBP_CLIENT_CODE_DIRECT_REGEX = /\b(CL\d{4,6})\b/;

// Numéro du document EBP (devis/facture/avoir), ex. "Devis N°D01366" ou "Facture N°F00123"
// — typiquement dans le sujet de l'email envoyé depuis EBP.
const EBP_DOC_NUMERO_REGEX = /(?:devis|facture|avoir)\s*n[°o]\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-]*)/i;

// Montant TTC final ("Net à payer : 917,09 €") dans le texte du PDF EBP.
const TOTAL_TTC_REGEX = /Net\s*[àa]\s*payer\s*:?\s*\n?\s*([\d][\d\s.,]*)\s*€/i;

export function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Headers avec la clé service_role — nécessaire pour écrire dans Storage et
// mettre à jour des lignes existantes de la table `devis` (RLS).
export function sbServiceHeaders(extra) {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_KEY;
  return Object.assign({
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }, extra || {});
}

export async function findClientByEmail(email) {
  if (!email) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/clients?select=id,payload&payload->espaceClient->>email=eq.${encodeURIComponent(email.toLowerCase())}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].payload?.name || '' };
  } catch (e) {
    console.error('findClientByEmail error:', e);
    return null;
  }
}

// Extrait la référence chantier / N° d'OS du texte d'un email (sujet + corps)
export function extractReference(fullText) {
  const m1 = fullText.match(REFERENCE_REGEX);
  if (m1 && m1[1]) return m1[1].trim().replace(/[.,;:]+$/, '');
  const m2 = fullText.match(FALLBACK_REFERENCE_REGEX);
  if (m2 && m2[1]) return m2[1].trim();
  const m3 = fullText.match(DEMANDE_REGEX);
  if (m3 && m3[1]) return m3[1].trim();
  return null;
}

// Extrait le texte d'un PDF (base64) — utilisé pour retrouver une référence,
// un code client EBP ou le nom du client facturé quand ces infos ne sont pas
// dans le corps de l'email.
export async function extractPdfText(base64Content) {
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const buffer = Buffer.from(base64Content, 'base64');
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (e) {
    console.error('extractPdfText error:', e);
    return '';
  }
}

// Extrait le code/n° de client EBP depuis le texte d'un PDF
export function extractEbpClientCode(text) {
  const m0 = text.match(EBP_CLIENT_CODE_DIRECT_REGEX);
  if (m0 && m0[1]) return m0[1].trim();
  const m = text.match(EBP_CLIENT_CODE_REGEX);
  if (m && m[1]) return m[1].trim();
  return null;
}

// Recherche un client par son code client EBP (payload.code, déjà rempli pour
// les clients importés depuis EBP)
export async function findClientByEbpCode(code) {
  if (!code) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/clients?select=id,payload&payload->>code=eq.${encodeURIComponent(code)}&limit=1`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].payload?.name || '' };
  } catch (e) {
    console.error('findClientByEbpCode error:', e);
    return null;
  }
}

// Recherche un client par nom (comparaison insensible à la casse/accents),
// utilisé pour rattacher un document à partir du nom de facturation lu dans le PDF EBP.
export async function findClientByName(name) {
  if (!name) return null;
  const normalize = (s) => (s || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const target = normalize(name);
  if (!target) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/clients?select=id,payload`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    for (const row of rows) {
      const clientName = normalize(row.payload?.name);
      if (!clientName) continue;
      if (clientName === target || clientName.includes(target) || target.includes(clientName)) {
        return { id: row.id, name: row.payload?.name || '' };
      }
    }
    return null;
  } catch (e) {
    console.error('findClientByName error:', e);
    return null;
  }
}

// Recherche un devis/bon existant dont le champ payload.reference correspond
export async function findDevisByReference(ref) {
  if (!ref) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/devis?select=id,payload&payload->>reference=eq.${encodeURIComponent(ref)}&limit=1`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    return { id: rows[0].id, payload: rows[0].payload || {} };
  } catch (e) {
    console.error('findDevisByReference error:', e);
    return null;
  }
}

// Recherche un client à partir des adresses destinataires (en excluant l'adresse d'ingestion)
export async function findClientByRecipientEmails(toEmails, ignoreEmail) {
  for (const email of toEmails) {
    const clean = (email || '').toString().trim().toLowerCase();
    if (!clean || clean === ignoreEmail) continue;
    const client = await findClientByEmail(clean);
    if (client) return client;
  }
  return null;
}

// Génère le prochain numéro de facture FAC{année}-NNN
export async function nextFactureId() {
  const year = new Date().getFullYear();
  try {
    const url = `${SUPABASE_URL}/rest/v1/devis?select=id&order=id.desc&limit=200`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    let max = 0;
    if (r.ok) {
      const rows = await r.json();
      rows.forEach(row => {
        if (row.id && row.id.startsWith('FAC' + year)) {
          const n = parseInt(row.id.slice(('FAC' + year + '-').length), 10) || 0;
          if (n > max) max = n;
        }
      });
    }
    return 'FAC' + year + '-' + String(max + 1).padStart(3, '0');
  } catch (e) {
    console.error('nextFactureId error:', e);
    return 'FAC' + year + '-' + String(Date.now()).slice(-3);
  }
}

// Génère le prochain numéro de devis D{année}-NNN (même format que devisNextNum() côté app métier)
export async function nextDevisId() {
  const year = new Date().getFullYear();
  try {
    const url = `${SUPABASE_URL}/rest/v1/devis?select=id&order=id.desc&limit=200`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    let max = 0;
    if (r.ok) {
      const rows = await r.json();
      rows.forEach(row => {
        if (row.id && row.id.startsWith('D' + year) && !row.id.startsWith('DEV')) {
          const n = parseInt(row.id.slice(('D' + year + '-').length), 10) || 0;
          if (n > max) max = n;
        }
      });
    }
    return 'D' + year + '-' + String(max + 1).padStart(3, '0');
  } catch (e) {
    console.error('nextDevisId error:', e);
    return 'D' + year + '-' + String(Date.now()).slice(-3);
  }
}

// Génère le prochain numéro d'avoir AV{année}-NNN
export async function nextAvoirId() {
  const year = new Date().getFullYear();
  try {
    const url = `${SUPABASE_URL}/rest/v1/devis?select=id&order=id.desc&limit=200`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    let max = 0;
    if (r.ok) {
      const rows = await r.json();
      rows.forEach(row => {
        if (row.id && row.id.startsWith('AV' + year)) {
          const n = parseInt(row.id.slice(('AV' + year + '-').length), 10) || 0;
          if (n > max) max = n;
        }
      });
    }
    return 'AV' + year + '-' + String(max + 1).padStart(3, '0');
  } catch (e) {
    console.error('nextAvoirId error:', e);
    return 'AV' + year + '-' + String(Date.now()).slice(-3);
  }
}

// Extrait le nom du client facturé depuis le texte d'un PDF EBP — repère le bloc
// "Doit :" / "Client :" / "Facturé à :" et prend la ligne suivante (nom du destinataire).
export function extractClientNameFromPdf(text) {
  const m = text.match(/(?:doit|client|factur[ée]\s*[àa])\s*:?\s*\n\s*([^\n]{2,80})/i);
  if (m && m[1]) {
    const name = m[1].trim();
    if (name && !/^code\s*client|^n[°o]/i.test(name)) return name;
  }
  return null;
}

// Extrait le numéro du document EBP (ex. "D01366") depuis le sujet de l'email,
// pour l'utiliser comme numéro/id du document plutôt qu'un numéro interne généré.
export function extractEbpDocNumero(fullText) {
  const m = fullText.match(EBP_DOC_NUMERO_REGEX);
  if (m && m[1]) return m[1].trim();
  return null;
}

// Extrait le montant TTC final ("Net à payer") depuis le texte du PDF EBP.
export function extractTotalTTC(pdfText) {
  const m = pdfText.match(TOTAL_TTC_REGEX);
  if (m && m[1]) {
    const num = parseFloat(m[1].trim().replace(/\s/g, '').replace(',', '.'));
    if (!isNaN(num)) return num;
  }
  return 0;
}

// Vérifie si un document avec cet id existe déjà dans la table `devis`.
export async function devisIdExists(id) {
  if (!id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/devis?select=id&id=eq.${encodeURIComponent(id)}&limit=1`;
    const r = await fetch(url, { headers: sbServiceHeaders() });
    if (!r.ok) return false;
    const rows = await r.json();
    return rows.length > 0;
  } catch (e) {
    console.error('devisIdExists error:', e);
    return false;
  }
}

// Détermine si l'email reçu concerne un devis, une facture ou un avoir EBP
// (sur la base du sujet + corps du mail). Par défaut : facture.
export function detectDocType(fullText) {
  const hasAvoir = /\bavoir\b/i.test(fullText);
  if (hasAvoir) return 'avoir';
  const hasDevis = /\bdevis\b/i.test(fullText);
  const hasFacture = /\bfacture\b|invoice/i.test(fullText);
  if (hasDevis && !hasFacture) return 'devis';
  return 'facture';
}

// Upload d'une pièce jointe PDF vers le bucket Supabase Storage "factures"
export async function uploadFacturePdf(filename, base64Content) {
  const safeName = (filename || 'facture.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${Date.now()}-${safeName}`;
  const buffer = Buffer.from(base64Content, 'base64');
  const url = `${SUPABASE_URL}/storage/v1/object/factures/${encodeURIComponent(path)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: sbServiceHeaders({ 'Content-Type': 'application/pdf' }),
    body: buffer,
  });
  if (!r.ok) {
    console.error('uploadFacturePdf error:', await r.text());
    return null;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/factures/${encodeURIComponent(path)}`;
}

// Traite un email contenant un devis ou une facture PDF (depuis EBP) :
// upload du PDF, puis rattachement à un devis/bon existant (par référence)
// ou création d'un nouveau document minimal. `data` = { subject, text, to, to_address, attachments }
export async function processInvoiceEmail(data) {
  try {
    const subject = (data.subject || '').toString();
    const text = (data.text || data.html || '').toString();
    const fullText = `${subject}\n${text}`;
    const ref = extractReference(fullText);
    const docType = detectDocType(fullText); // 'devis' ou 'facture'

    const pdfAttachments = (data.attachments || []).filter(a => {
      const ct = (a.content_type || a.contentType || a.type || '').toLowerCase();
      const fn = (a.filename || a.name || '').toLowerCase();
      return ct.includes('pdf') || fn.endsWith('.pdf');
    });

    let pdfUrl = null;
    let pdfText = '';
    for (const att of pdfAttachments) {
      const content = att.content || att.content_base64 || att.data;
      if (!content) continue;
      const url = await uploadFacturePdf(att.filename || att.name, content);
      if (url) {
        pdfUrl = url;
        pdfText = await extractPdfText(content);
        break;
      }
    }

    if (!pdfUrl) {
      return { ok: false, error: 'no_pdf' };
    }

    // Si aucune référence trouvée dans l'email, on tente aussi dans le texte du PDF
    const pdfRef = !ref ? extractReference(pdfText) : null;
    const effectiveRef = ref || pdfRef;

    // Cas 1 : la référence correspond à un devis/bon existant -> on l'attache
    // (un avoir reste toujours un nouveau document distinct, cf. Cas 2)
    const existing = await findDevisByReference(effectiveRef);
    if (existing && docType !== 'avoir') {
      const updatedPayload = docType === 'devis'
        ? Object.assign({}, existing.payload, {
            pdfUrl,
            statut: (existing.payload.statut === 'brouillon' || !existing.payload.statut) ? 'envoye' : existing.payload.statut,
            updatedAt: Date.now(),
          })
        : Object.assign({}, existing.payload, {
            factureUrl: pdfUrl,
            statut: 'facture',
            updatedAt: Date.now(),
          });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/devis?id=eq.${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        headers: sbServiceHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ payload: updatedPayload }),
      });
      if (!r.ok) console.error('processInvoiceEmail PATCH error:', await r.text());
      return { ok: true, id: existing.id, linked: true };
    }

    // Cas 2 : pas de correspondance (ou avoir) -> nouveau document minimal (devis, facture ou avoir)
    const toEmails = (data.to || []).map(t => (t && t.email) ? t.email : t).filter(Boolean);
    const ingestEmail = (data.to_address || '').toString().toLowerCase();
    let client = await findClientByRecipientEmails(toEmails, ingestEmail);
    // Si pas trouvé via l'adresse destinataire, on tente via le nom de facturation
    // lu dans le PDF, puis via le code client EBP lu dans le PDF.
    if (!client) {
      const pdfClientName = extractClientNameFromPdf(pdfText);
      if (pdfClientName) client = await findClientByName(pdfClientName);
    }
    if (!client) {
      const ebpCode = extractEbpClientCode(pdfText) || extractEbpClientCode(fullText);
      if (ebpCode) client = await findClientByEbpCode(ebpCode);
    }
    const recipientEmail = toEmails.find(e => (e || '').toLowerCase() !== ingestEmail) || '';
    const clientName = client ? client.name : (existing ? existing.payload.client : recipientEmail);
    const clientId = client ? client.id : (existing ? existing.payload.client_id : null);

    // Préférer le numéro du document EBP (ex. "D01366") comme id/numero, pour
    // éviter de générer un numéro interne en doublon avec celui d'EBP.
    let id;
    const ebpNumero = extractEbpDocNumero(fullText) || extractEbpDocNumero(pdfText);
    if (ebpNumero && !(await devisIdExists(ebpNumero))) {
      id = ebpNumero;
    } else if (docType === 'devis') id = await nextDevisId();
    else if (docType === 'avoir') id = await nextAvoirId();
    else id = await nextFactureId();
    const now = Date.now();

    const docPayload = {
      id,
      type: docType,
      numero: id,
      statut: docType === 'devis' ? 'envoye' : docType,
      date: new Date().toISOString().split('T')[0],
      client: clientName || '',
      client_id: clientId,
      motif: subject,
      reference: effectiveRef || null,
      lignes: [],
      totalTTC: extractTotalTTC(pdfText),
      createdAt: now,
      updatedAt: now,
    };
    if (docType === 'devis') docPayload.pdfUrl = pdfUrl;
    else if (docType === 'avoir') docPayload.avoirUrl = pdfUrl;
    else docPayload.factureUrl = pdfUrl;

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/devis`, {
      method: 'POST',
      headers: sbServiceHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ id, payload: docPayload }),
    });
    if (!insertRes.ok) console.error('processInvoiceEmail INSERT error:', await insertRes.text());

    return { ok: true, id, linked: false };
  } catch (e) {
    console.error('processInvoiceEmail error:', e);
    return { ok: false, error: e.message };
  }
}
