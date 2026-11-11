'use strict';
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { load } = require('cheerio');

const IMAP_USER = process.env.IONOS_IMAP_USER;
const IMAP_PASS = process.env.IONOS_IMAP_PASS;

async function main() {
  const client = new ImapFlow({
    host: 'imap.ionos.fr', port: 993, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false
  });
  await client.connect();
  await client.mailboxOpen('INBOX');

  // Chercher un mail Citya récent
  const uids = await client.search({ all: true }, { uid: true });
  const recent = uids.reverse().slice(0, 20);

  for (const uid of recent) {
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg) continue;
    const parsed = await simpleParser(msg.source);
    const subject = parsed.subject || '';
    if (!subject.toLowerCase().includes('collab') && !subject.toLowerCase().includes('citya')) continue;

    console.log('\n=== MAIL UID', uid, '===');
    console.log('Sujet:', subject);
    console.log('A un HTML:', !!parsed.html);
    console.log('Longueur texte brut:', (parsed.text || '').length);

    // Chercher URLs Citya dans le texte brut
    const textLinks = (parsed.text || '').replace(/\r?\n/g, ' ').match(/https?:\/\/[^\s<>"[\]]+/g) || [];
    const cityaText = textLinks.filter(u => u.includes('collab.citya.com'));
    console.log('\nURLs Citya dans texte brut:', cityaText.length);
    cityaText.forEach(u => console.log(' ', u.substring(0, 120)));

    // Chercher URLs Citya dans les href HTML
    if (parsed.html) {
      const $ = load(parsed.html);
      const hrefs = [];
      $('a[href]').each(function() { hrefs.push($(this).attr('href')); });
      const cityaHref = hrefs.filter(u => u && u.includes('collab.citya.com'));
      console.log('\nURLs Citya dans href HTML:', cityaHref.length);
      cityaHref.forEach(u => console.log(' ', u.substring(0, 120)));

      // Chercher aussi dans le source HTML brut
      const rawMatches = parsed.html.match(/https?:\/\/[^"'\s<>]+collab\.citya\.com[^"'\s<>]*/g) || [];
      console.log('\nURLs Citya dans HTML brut:', rawMatches.length);
      rawMatches.slice(0, 3).forEach(u => console.log(' ', u.substring(0, 120)));
    }
    // Tester l'appel Citya directement
    const { load: $ } = require('cheerio');
    const fetch = require('node-fetch');
    const $2 = load(parsed.html);
    const href = $2('a[href]').map((i, el) => $2(el).attr('href')).get().find(u => u && u.includes('/detail/'));
    if (href) {
      console.log('\nURL complète trouvée:', href);
      console.log('\nTest appel Citya...');
      try {
        // Étape 1 : GET l'URL avec cookies
        const r = await fetch(href, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
        console.log('Status HTTP:', r.status);
        const body = await r.text();
        console.log('Longueur réponse:', body.length);

        // Afficher les cookies reçus
        const cookies = r.headers.raw()['set-cookie'] || [];
        console.log('Cookies reçus:', cookies.length);
        cookies.forEach(c => console.log(' ', c.substring(0, 100)));

        // Construire cookie string
        const jar = {};
        cookies.forEach(c => {
          const [kv] = c.split(';');
          const eq = kv.indexOf('=');
          if (eq > 0) jar[kv.substring(0,eq).trim()] = kv.substring(eq+1).trim();
        });
        const cookieStr = Object.entries(jar).map(([k,v]) => k+'='+v).join('; ');
        console.log('Cookie string:', cookieStr.substring(0, 100));

        // Extraire topicId
        const parts = decodeURIComponent(href).split('/');
        const topicId = parts.find(p => /^\d{5,}$/.test(p));
        console.log('TopicId:', topicId);

        // Étape 2 : Appel TopicServlet sans token (juste cookies)
        const apiUrl = `https://collab.citya.com/tomcat/Collabore/TopicServlet?action=searchDetailTopic&topic=${topicId}`;
        console.log('\nAppel API:', apiUrl);
        const r2 = await fetch(apiUrl, {
          headers: { 'Cookie': cookieStr, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://collab.citya.com/' }
        });
        console.log('Status API:', r2.status);
        const apiBody = await r2.text();
        console.log('Réponse API (200 premiers chars):', apiBody.substring(0, 200));

        // Extraire le token hex depuis l'URL (grand hash entre le #HARMONIE et le topicId)
        const hexMatch = decodeURIComponent(href).match(/HARMONIE-ELECTRICITE\/([a-f0-9]{20,})\/\d/i);
        if (hexMatch) {
          const hexToken = hexMatch[1];
          console.log('\nToken hex extrait:', hexToken.substring(0, 40) + '...');
          const apiUrl2 = `https://collab.citya.com/tomcat/Collabore/TopicServlet?action=searchDetailTopic&token=${hexToken}&topic=${topicId}`;
          console.log('Appel API avec token hex...');
          const r3 = await fetch(apiUrl2, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://collab.citya.com/' } });
          console.log('Status:', r3.status);
          console.log('Réponse:', (await r3.text()).substring(0, 400));
        }
        // Afficher aussi début du HTML pour chercher d'autres indices
        console.log('\nDébut HTML:', body.substring(0, 500));
      } catch(e) {
        console.log('Erreur fetch:', e.message);
      }
    }
    break; // Un seul mail pour le debug
  }

  await client.logout();
}

main().catch(console.error);
