// Cloudflare Worker: rapport-ai-harmonie
// Deploy at: https://rapport-ai-harmonie.harmonie-electricite.workers.dev
// Env var required: CLAUDE_API_KEY
// Wrangler command: npx wrangler secret put CLAUDE_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const { rapport, adresse, catalogue } = body;
    if (!rapport) {
      return new Response(JSON.stringify({ error: 'Champ rapport manquant' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // Tarifs fixes connus
    const tarifsMO = [
      { ref: 'MO',   nom: "Main d'œuvre standard",         pv: 57,  unite: 'h' },
      { ref: 'MOD1', nom: "Main d'œuvre dépannage",         pv: 57,  unite: 'h' },
      { ref: 'MOD2', nom: "Main d'œuvre urgence (après 20h)", pv: 90, unite: 'h' },
    ];
    const tarifsZones = [
      { ref: 'DEPLA1', nom: 'Déplacement zone 1 (Chambéry/Aix centre)',        pv: 40,  villes: 'Chambéry centre, Aix-les-Bains centre, La Motte-Servolex centre, Viviers-du-Lac, Tresserve (≤20km de Yenne)' },
      { ref: 'DEPLA2', nom: 'Déplacement zone 2 (périphérie Chambéry/Aix)',    pv: 45,  villes: 'périphérie Chambéry/Aix, Le Bourget-du-Lac, Méry, Brison, Jacob-Bellecombette (20-35km)' },
      { ref: 'DEPLA3', nom: 'Déplacement zone 3',                               pv: 60,  villes: 'Annecy direction, Albertville direction, Rumilly, Alby-sur-Chéran (35-55km)' },
      { ref: 'DEPLA4', nom: 'Déplacement zone 4',                               pv: 78,  villes: 'Annecy centre, Ugine, Grenoble direction (55-80km)' },
      { ref: 'DEPLA5', nom: 'Déplacement zone 5 (grande distance)',             pv: 122, villes: 'plus de 80km de Yenne' },
    ];

    // Catalogue passé par le client (100 premiers articles les plus pertinents)
    const catalogueCtx = Array.isArray(catalogue) && catalogue.length
      ? catalogue.slice(0, 120).map(a => `${a.ref} | ${a.nom} | ${a.pv}€/${a.unite}`).join('\n')
      : '(catalogue non fourni)';

    const systemPrompt = `Tu es un assistant technique pour Harmonie Électricité, entreprise d'électricité générale et automatismes de portails/portes situées à Yenne (73170 Savoie).

TARIFS MAIN D'ŒUVRE :
${tarifsMO.map(m => `- ${m.ref}: ${m.nom} → ${m.pv}€/${m.unite}`).join('\n')}

TARIFS DÉPLACEMENT (forfait par intervention, choisir UN seul selon l'adresse du chantier) :
${tarifsZones.map(z => `- ${z.ref} (${z.pv}€) : ${z.villes}`).join('\n')}
Adresse chantier : "${adresse || 'non précisée'}"

CATALOGUE FOURNITURES DISPONIBLES (ref | nom | prix HT) :
${catalogueCtx}

CONSIGNES :
1. Lis le rapport d'intervention et déduis les pièces/matériaux nécessaires.
2. Utilise en priorité les références du catalogue fourni. Si une pièce n'existe pas dans le catalogue, crée une ligne avec ref="LIBRE", un nom descriptif précis, et un prix moyen constaté.
3. Estime le temps de main d'œuvre en heures (utilise MO par défaut, MOD2 si urgence).
4. Détermine la zone de déplacement selon l'adresse du chantier. Si adresse inconnue, utilise DEPLA1.
5. Réponds UNIQUEMENT en JSON valide, sans markdown, sans explication.

FORMAT DE RÉPONSE (JSON strict) :
{
  "zone": "DEPLA1",
  "zone_justification": "Chambéry centre, <20km de Yenne",
  "lignes": [
    { "ref": "REF", "nom": "Désignation", "qte": 1, "pv": 99.90, "unite": "U" },
    { "ref": "MO", "nom": "Main d'œuvre", "qte": 2, "pv": 57, "unite": "h" },
    { "ref": "DEPLA1", "nom": "Déplacement zone 1", "qte": 1, "pv": 40, "unite": "U" }
  ],
  "resume": "Résumé en 1-2 phrases de ce qui a été diagnostiqué et ce qui est préconisé."
}`;

    const userMsg = `Rapport d'intervention :\n${rapport}`;

    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Erreur réseau Claude API: ' + e.message }), {
        status: 502, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return new Response(JSON.stringify({ error: 'Erreur Claude API: ' + errText }), {
        status: claudeRes.status, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    // Parser le JSON retourné par Claude
    let parsed;
    try {
      // Extraire JSON même si Claude ajoute du texte autour
      const match = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : rawText);
    } catch {
      return new Response(JSON.stringify({ error: 'Réponse Claude non parseable', raw: rawText }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
};
