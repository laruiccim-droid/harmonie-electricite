/**
 * email-fetcher/fetch.js
 * ---------------------
 * Récupère les mails IONOS (lus + non lus), suit les liens Citya Collab,
 * extrait les PDFs, et stocke tout dans Supabase pour la page d'entraînement.
 *
 * Variables d'environnement requises :
 *   IONOS_IMAP_USER   ex: contact@harmonie-electricite.com
 *   IONOS_IMAP_PASS   mot de passe IONOS
 *   SUPABASE_URL      ex: https://bqzebkobyfktemnwfwbt.supabase.co
 *   SUPABASE_KEY      clé publishable Supabase
 *
 * Usage :
 *   node fetch.js              → traite les 50 derniers mails non traités
 *   node fetch.js --all        → retraite tous les mails (reset labels)
 *   node fetch.js --limit 20   → limite à 20 mails
 */

'use strict';

const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const pdf             = require('pdf-parse');
const fetch           = require('node-fetch');
const { load }        = require('cheerio');
const puppeteer       = require('puppeteer');

// ── Config ────────────────────────────────────────────────────────────────────
const IMAP_USER  = process.env.IONOS_IMAP_USER;
const IMAP_PASS  = process.env.IONOS_IMAP_PASS;
const SUPA_URL   = process.env.SUPABASE_URL   || 'https://bqzebkobyfktemnwfwbt.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_KEY   || 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';
const LIMIT      = parseInt(process.argv.find((a, i) => process.argv[i-1] === '--limit') || '50');
const RESET_ALL  = process.argv.includes('--all');

if (!IMAP_USER || !IMAP_PASS) {
  console.error('❌ IONOS_IMAP_USER et IONOS_IMAP_PASS sont requis.');
  process.exit(1);
}

// ── Mots-clés de filtre ───────────────────────────────────────────────────────
const KEYWORDS = [
  'devis', 'intervention', 'panne', 'dépannage', 'depannage', 'urgence',
  'disponib', 'rendez-vous', 'rdv', 'électrique', 'electrique', 'électricité',
  'electricite', 'tableau', 'disjoncteur', 'prise', 'interrupteur', 'éclairage',
  'eclairage', 'installation', 'réparation', 'reparation', 'chantier', 'travaux',
  'court-circuit', 'interphone', 'portail', 'vmc', 'minuterie', 'détecteur',
  'detecteur', 'digicode', 'badge', 'néon', 'neon', 'luminaire', 'collab.citya', 'collab.ics',
  'demande', 'besoin de votre expertise', 'ordre de service'
];

function matchesKeywords(text) {
  const t = (text || '').toLowerCase();
  return KEYWORDS.some(kw => t.includes(kw));
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SB_HEADERS = {
  'apikey': SUPA_KEY,
  'Authorization': 'Bearer ' + SUPA_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates,return=minimal'
};

async function supaUpsert(id, payload) {
  const r = await fetch(`${SUPA_URL}/rest/v1/notes`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify([{ id, payload }])
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase upsert failed: ${r.status} ${err}`);
  }
}

async function supaGetExistingIds() {
  const r = await fetch(`${SUPA_URL}/rest/v1/notes?id=like.email_train_*&select=id`, {
    headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }
  });
  if (!r.ok) return new Set();
  const rows = await r.json();
  return new Set(rows.map(row => row.id));
}

// ── Citya Collab : extraction depuis sujet + URL ──────────────────────────────
// L'API Citya requiert un token JS (impossible sans navigateur).
// Toutes les infos clés sont dans le sujet du mail et l'URL.
function parseCityaFromEmail(collabUrl, subject, bodyText) {
  const urlDecoded = decodeURIComponent(collabUrl);
  const urlParts   = urlDecoded.split('/');
  const numParts   = urlParts.filter(p => /^\d{5,}$/.test(p));
  const topicId    = numParts[0] || null;
  const demandId   = numParts[1] || null;

  let syndic = '', type = '', immeuble = '', adresse = '', motif = '', ref = '';

  const syndicMatch = subject.match(/^\[([^\]]+)\]/);
  if (syndicMatch) syndic = syndicMatch[1];

  const typeMatch = subject.match(/COLLAB-\d+-\d+\s*-\s*([^/]+)/);
  if (typeMatch) type = typeMatch[1].trim();

  const immMatch = subject.match(/Imm:\s*([^-]+)/);
  if (immMatch) immeuble = immMatch[1].trim();

  const refMatch = subject.match(/R[eé]f\.?\s*(\d+)/i);
  if (refMatch) ref = refMatch[1];

  const afterRef = subject.match(/R[eé]f\.?\s*\d+\s*-\s*(.+)$/i);
  if (afterRef) {
    const parts = afterRef[1].split(' - ');
    adresse = parts[0]?.trim() || '';
    motif   = parts.slice(1).join(' - ').trim();
  }

  const descLines = (bodyText || '').split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 10 && !l.startsWith('http') && !l.startsWith('[http') &&
      !l.startsWith('=-') && !l.includes('Société CITYA') && !l.includes('salutations') &&
      !l.includes('référence interne') && !l.includes('courriel'));
  const description = descLines.slice(0, 5).join('\n');

  return {
    url: collabUrl, topicId, demandId, type,
    titre: motif || immeuble,
    descriptionClient: description,
    adresse: adresse || immeuble,
    agence: syndic, reference: ref,
    source: 'email-subject'
  };
}

// ── Citya Collab : navigateur headless Puppeteer ──────────────────────────────
// Intercepte l'appel API TopicServlet fait par AngularJS après chargement
async function fetchCityaCollab(collabUrl, subject, bodyText) {
  // Extraire topicId depuis l'URL pour le fallback
  const urlDecoded = decodeURIComponent(collabUrl);
  const numParts   = urlDecoded.split('/').filter(p => /^\d{5,}$/.test(p));
  const topicId    = numParts[0] || null;

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    // Écouter les logs du navigateur
    page.on('console', msg => { if (msg.text().startsWith('DOM ') || msg.text().startsWith('Titres') || msg.text().startsWith('Body')) console.log('  🌐 PAGE:', msg.text().substring(0, 300)); });

    // Intercepter les réponses API de TopicServlet
    let apiData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('TopicServlet') && url.includes('searchDetailTopic')) {
        try {
          const json = await response.json();
          if (json.success && json.TopicStates) apiData = json;
        } catch {}
      }
    });

    await page.goto(collabUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // Attendre que AngularJS charge les données
    await new Promise(r => setTimeout(r, 3000));

    // Cliquer sur tous les boutons "Voir plus" / "Voir la demande" pour déplier le contenu
    await page.evaluate(() => {
      const selectors = [
        'a[ng-click*="voir"], button[ng-click*="voir"]',
        '[class*="voir-plus"], [class*="voirPlus"]',
        'a.voir-plus, button.voir-plus',
        '[data-action*="expand"], [ng-click*="expand"]'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => { try { el.click(); } catch(e) {} });
      });
      // Aussi chercher par texte "Voir plus"
      document.querySelectorAll('a, button, span').forEach(el => {
        if (/voir\s*plus|voir\s*la\s*demande|afficher/i.test(el.textContent)) {
          try { el.click(); } catch(e) {}
        }
      });
    });
    await new Promise(r => setTimeout(r, 1000));

    // Toujours lire le DOM rendu (plus fiable que l'API pour objet/adresse)
    const domData = await page.evaluate(() => {
      // Déplier toutes les sections cachées
      document.querySelectorAll('.blockquoteGroupeUser-content-hidden, [class*="content-hidden"]').forEach(el => {
        el.style.display = 'block';
        el.classList.remove('blockquoteGroupeUser-content-hidden');
      });

      // Titre h1 → "IMMEUBLE - Motif" → séparer
      const h1Text = document.querySelector('h1, h2')?.innerText?.trim() || '';
      const dashIdx = h1Text.indexOf(' - ');
      const immeuble = dashIdx > 0 ? h1Text.substring(0, dashIdx).trim() : h1Text;
      const motifTitre = dashIdx > 0 ? h1Text.substring(dashIdx + 3).trim() : '';

      // Description : depuis le body text complet (plus fiable que innerText sur éléments cachés)
      const fullBody = document.body.innerText;
      let desc = '';
      const dIdx = fullBody.search(/demande de notre client\s*:/i);
      if (dIdx >= 0) {
        const after = fullBody.substring(dIdx).replace(/^demande de notre client\s*:\s*/i, '');
        // Stopper au premier marqueur de fin (fiche immeuble, bouton, etc.)
        const stopMarkers = [/\nLieu Intervention/i, /voir moins/i, /\nHistorique/i, /\nDossiers/i];
        let end = after.length;
        stopMarkers.forEach(re => { const m = after.search(re); if (m > 0 && m < end) end = m; });
        desc = after.substring(0, end).trim();
      }

      // Adresse Maps (Citya)
      const mapsLink = document.querySelector('a[href*="maps.google"]');
      const mapsHref = mapsLink ? mapsLink.getAttribute('href') : '';
      const adresseFiche = document.querySelector('.fiche-infos-adresse')?.innerText?.trim() || '';

      // Lieu intervention ICS/Savoisienne : "NOM (adresse)"
      let lieuImmeuble = '', lieuAdresse = '';
      const lieuText = document.body.innerText;
      const lieuIdx = lieuText.search(/Lieu de l.intervention\s*:/i);
      if (lieuIdx >= 0) {
        const lieuSection = lieuText.substring(lieuIdx, lieuIdx + 300);
        const lieuMatch = lieuSection.match(/\n\s*([^\n(]+?)\s*\(([^)]+)\)/);
        if (lieuMatch) {
          lieuImmeuble = lieuMatch[1].trim();
          lieuAdresse  = lieuMatch[2].trim();
        }
      }

      // Digicode
      const digicodes = [...document.querySelectorAll('.fiche-infos-digicode')].map(el => el.innerText.trim()).filter(Boolean);

      return { desc, immeuble, motifTitre, mapsHref, adresseFiche, lieuImmeuble, lieuAdresse, digicodes };
    });

    if (apiData) {
      await browser.close();
      const parsed = parseCityaApiResponse(apiData, collabUrl);
      // Enrichir avec le DOM rendu (plus fiable pour adresse et description)
      if (domData.desc) parsed.descriptionClient = domData.desc;
      if (domData.mapsHref) {
        const adresse = domData.mapsHref.replace(/.*\?q=/, '').split('&')[0];
        if (adresse) parsed.adresse = decodeURIComponent(adresse);
      } else if (domData.lieuAdresse) {
        parsed.adresse = domData.lieuAdresse;
      } else if (domData.adresseFiche) {
        parsed.adresse = domData.adresseFiche;
      }
      // Immeuble : lieu ICS (plus fiable) > DOM h1 > API
      const immSource = domData.lieuImmeuble || domData.immeuble;
      if (immSource) { parsed.immeuble = immSource; parsed.titre = immSource; }
      if (domData.motifTitre) parsed.motifTitre = domData.motifTitre;
      if (domData.digicodes.length) parsed.digicode = domData.digicodes.join(' | ');
      return parsed;
    }

    await browser.close();

    return {
      url: collabUrl, topicId,
      titre:             domData.immeuble || domData.lieuImmeuble || '',
      immeuble:          domData.immeuble || domData.lieuImmeuble || '',
      descriptionClient: domData.desc || '',
      adresse:           domData.lieuAdresse || domData.adresseFiche || '',
      motifTitre:        domData.motifTitre || '',
      type:              'Demande',
      source:            'puppeteer-dom'
    };

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    // Dernier recours : parser depuis le sujet du mail
    return parseCityaFromSubject(collabUrl, subject, bodyText, topicId);
  }
}

function parseCityaApiResponse(data, url) {
  try {
    const ts      = data.TopicStates[0];
    const topic   = ts.topic;
    const contenu = topic.contenus?.[0];
    const $ = load(contenu?.objet || '');

    // Description : texte du bloc principal (avant les fiches immeuble)
    const descHtml = $('#eventMainContent').html() || contenu?.objet || '';
    const descText = descHtml
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

    // Adresse : dans l'href Google Maps ou dans le texte fiche-infos-adresse
    const mapsLink = $('a[href*="maps.google"]').attr('href') || '';
    const adresseFromMaps = mapsLink ? decodeURIComponent(mapsLink.replace('http://maps.google.com/?q=', '')) : '';
    const adresseFromFiche = $('.fiche-infos-adresse').first().text().trim();
    const adresse = adresseFromMaps || adresseFromFiche;

    // Nom immeuble
    const immNom = $('.fiche-infos-nom').first().text().trim();

    // Type depuis le titre de la demande (sujet mail ou tag)
    const tagsType = contenu?.tagsType || [];
    const tagImm = tagsType.find(t => t.typeTag?.libelle === 'Immeuble');

    // Digicode
    const digicodes = $('.fiche-infos-digicode').map((i, el) => $(el).text().trim()).get().filter(Boolean);

    const gi = contenu?.expediteur?.groupeInformations;
    return {
      url,
      topicId: topic.idTopic,
      type: contenu?.typeContenu?.libelle || 'Demande d\'intervention',
      titre: immNom || topic.titre || '',
      descriptionClient: descText,
      adresse,
      immeuble: immNom,
      digicode: digicodes.join(' | '),
      agence: contenu?.expediteur?.dieze?.replace(/^#/, '') || '',
      agenceContact: (gi && gi.prenom && gi.nom) ? `${gi.prenom} ${gi.nom}` : '',
      agenceEmail: gi?.email || '',
      dateCreation: contenu?.dateCreation || '',
      source: 'api'
    };
  } catch (e) {
    return { url, erreur: 'Parsing API: ' + e.message };
  }
}

function parseCityaFromSubject(collabUrl, subject, bodyText, topicId) {
  let syndic = '', type = '', immeuble = '', adresse = '', motif = '';
  const syndicMatch = (subject||'').match(/^\[([^\]]+)\]/);
  if (syndicMatch) syndic = syndicMatch[1];
  const typeMatch = (subject||'').match(/COLLAB-\d+-\d+\s*-\s*([^/]+)/);
  if (typeMatch) type = typeMatch[1].trim();
  const immMatch = (subject||'').match(/Imm:\s*([^-]+)/);
  if (immMatch) immeuble = immMatch[1].trim();
  const afterRef = (subject||'').match(/R[eé]f\.?\s*\d+\s*-\s*(.+)$/i);
  if (afterRef) {
    const parts = afterRef[1].split(' - ');
    adresse = parts[0]?.trim() || '';
    motif   = parts.slice(1).join(' - ').trim();
  }
  return {
    url: collabUrl, topicId, type,
    titre: motif || immeuble,
    descriptionClient: '',
    adresse: adresse || immeuble,
    agence: syndic,
    source: 'email-subject-fallback'
  };
}

// ── Extraction PDF ────────────────────────────────────────────────────────────
async function extractPdfText(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text.replace(/\s+/g, ' ').trim().substring(0, 5000);
  } catch (e) {
    return '';
  }
}

// ── Extraction liens depuis texte ─────────────────────────────────────────────
function extractLinks(text) {
  const joined = (text || '').replace(/\r?\n/g, ' ');
  const urlRe = /https?:\/\/[^\s<>"[\]]+/g;
  return [...new Set((joined).match(urlRe) || [])];
}

// Extrait les href d'un HTML (plus fiable que regex sur texte pour les URLs longues)
function extractHrefs(html) {
  if (!html) return [];
  const $ = load(html);
  const urls = [];
  $('a[href]').each(function() {
    const href = $(this).attr('href');
    if (href && href.startsWith('http')) urls.push(href);
  });
  return [...new Set(urls)];
}

const COLLAB_DOMAINS = ['collab.citya.com', 'collab.ics.fr'];

function isCollabUrl(u) {
  return COLLAB_DOMAINS.some(d => u.includes(d)) && u.includes('/detail/');
}

function extractCityaLinks(text, html) {
  const fromText = extractLinks(text).filter(isCollabUrl);
  const fromHtml = extractHrefs(html).filter(isCollabUrl);
  return [...new Set([...fromText, ...fromHtml])];
}

// ── Nettoyage texte mail ──────────────────────────────────────────────────────
function cleanText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Connexion IMAP IONOS…');

  const existingIds = RESET_ALL ? new Set() : await supaGetExistingIds();
  console.log(`📦 ${existingIds.size} mail(s) déjà en base`);

  const client = new ImapFlow({
    host: 'imap.ionos.fr',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false
  });

  await client.connect();

  let processed = 0;
  let skipped   = 0;
  let noKeyword = 0;

  try {
    await client.mailboxOpen('INBOX');

    // Récupérer les UIDs des mails (lus + non lus, les plus récents en premier)
    const uids = await client.search({ all: true }, { uid: true });
    const recentUids = uids.reverse().slice(0, Math.min(uids.length, LIMIT * 3));

    console.log(`📬 ${uids.length} mails total, traitement des ${recentUids.length} plus récents…`);

    for (const uid of recentUids) {
      if (processed >= LIMIT) break;

      const supaId = `email_train_${uid}`;
      if (!RESET_ALL && existingIds.has(supaId)) {
        skipped++;
        continue;
      }

      try {
        // Télécharger le mail
        const msg = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
        if (!msg) continue;

        const parsed = await simpleParser(msg.source);

        const fromAddr = parsed.from?.text || '';
        const subject  = parsed.subject || '';
        const date     = parsed.date?.toISOString() || '';
        const textBody = parsed.text || cleanText(parsed.html || '');
        const htmlBody = parsed.html || '';

        // Filtre mots-clés
        const fullText = subject + ' ' + textBody + ' ' + fromAddr;
        if (!matchesKeywords(fullText)) {
          noKeyword++;
          continue;
        }

        console.log(`\n📧 [${uid}] ${subject.substring(0, 60)}`);

        // Extraire PDFs
        const pdfTexts = [];
        for (const att of (parsed.attachments || [])) {
          if (att.contentType === 'application/pdf' && att.content) {
            console.log(`  📄 PDF: ${att.filename}`);
            const txt = await extractPdfText(att.content);
            if (txt) pdfTexts.push({ filename: att.filename, text: txt });
          }
        }

        // Extraire liens Citya (href HTML prioritaire sur texte brut)
        const cityaUrls = extractCityaLinks(textBody, htmlBody);

        const collabData = [];
        for (const url of cityaUrls) {
          console.log(`  🔗 Citya: ${url.substring(0, 80)}…`);
          const data = await fetchCityaCollab(url, subject, textBody);
          collabData.push(data);
        }

        // Stocker dans Supabase
        const payload = {
          source:       'email_training',
          uid,
          from:         fromAddr,
          subject,
          date,
          bodyText:     textBody.substring(0, 8000),
          allLinks:     extractLinks(textBody + ' ' + htmlBody).slice(0, 20),
          pdfTexts,
          collabData,
          label:        null,
          extractedData: null,
          processedAt:  Date.now(),
          flags:        [...(msg.flags || [])]
        };

        await supaUpsert(supaId, payload);
        console.log(`  ✅ Stocké (${pdfTexts.length} PDF, ${collabData.length} Collab)`);
        processed++;

      } catch (e) {
        console.error(`  ❌ Erreur uid ${uid}: ${e.message}`);
      }
    }

  } finally {
    await client.logout();
  }

  console.log(`\n✅ Terminé — ${processed} stockés, ${skipped} déjà connus, ${noKeyword} sans mots-clés`);
}

main().catch(e => { console.error(e); process.exit(1); });
