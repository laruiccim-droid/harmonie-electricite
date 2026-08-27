# App Métier — Règles de mapping Google Calendar → Bon d'intervention

## Flux de données

Un bon est généré depuis deux sources dans index.html :
1. **Arrêt du timer** (`timerStopFromBanner()` ~ligne 2850)
2. **Fiche RDV agenda** (`openBon()` ~ligne 3620)

Les données sont passées à bon.html via `sessionStorage.setItem('he_bon_data', JSON.stringify(data))`.

---

## Champs du bon (bon.html) et leur source GCal

| Champ bon.html | ID élément | Source dans `data` | Source GCal |
|---|---|---|---|
| Nom client | `f-client` | `data.clientNom` | Recherche dans CLIENTS par `event.summary` |
| Adresse chantier | `f-adresse` | `data.clientAdresse` / `data.adresse` | `client.addressChantier` → `client.address` → `event.location` |
| Adresse facturation | `f-adresse-fact` | `data.clientAdresseFacturation` | `client.address` |
| Téléphone | `f-tel` | `data.clientTel` | `client.phone` |
| Email | `f-email` | `data.clientEmail` | `client.email` |
| **Motif / description** | `f-motif` | `data.description` | `event.summary` + `event.description` (HTML nettoyé) |
| **Rapport** | `f-rapport` | *(laissé vide)* | Ne jamais pré-remplir le rapport |
| Date | `f-date` | `data.date` | Timer start → `event.start.dateTime` |
| Heure arrivée | `f-heure-debut` | `data.heureDebut` | Timer start → `event.start.dateTime` |
| Heure départ | `f-heure-fin` | `data.heureFin` | Timer end → `event.end.dateTime` |
| Durée | `f-duree` | Calculé par `calcDuree()` | — |
| Référence OS | `f-reference` | `data.reference` | — |

---

## Règles absolues

1. **Tout le texte descriptif va dans `f-motif`** (= `data.description`), jamais dans `f-rapport`
2. **`f-rapport` reste toujours vide** à la génération — c'est l'utilisateur qui le remplit après l'intervention
3. **La description GCal doit être nettoyée** via `stripGcalDesc()` avant d'être mise dans `data.description` :
   - Supprimer toutes les balises HTML (`<p>`, `<b>`, `<br>`, etc.)
   - Supprimer les marqueurs du bon précédent (`✅ BON D'INTERVENTION`, `📄 PDF`, `💶 Total`, `📦 Fournitures`, `👤 Client`, `⏱`, `🔧 Motif`, `━━━`)
   - Décoder les entités HTML (`&nbsp;`, `&amp;`, etc.)
4. **Le motif = titre + description** : `[event.summary, stripGcalDesc(event.description)].filter(Boolean).join('\n\n')`
5. **Les URLs dans le motif restent en texte brut** — bon.html les détecte et affiche un bandeau de liens cliquables
6. **Adresse** : priorité `client.addressChantier` > `client.address` > `event.location`

---

## Structure de l'objet `data` passé à bon.html

```js
{
  type: 'bon',                    // 'bon' ou 'devis'
  eventId: event.id,             // pour mise à jour GCal après validation
  date: 'JJ/MM/AAAA',
  heureDebut: 'HH:MM',
  heureFin: 'HH:MM',
  dureeMin: 45,                  // en minutes (calcDuree() recalcule f-duree)
  clientNom: '',
  clientTel: '',
  clientEmail: '',
  clientAdresse: '',             // adresse chantier → f-adresse
  clientAdresseFacturation: '',  // → f-adresse-fact
  adresse: '',                   // alias de clientAdresse
  description: '',               // → f-motif (titre + description nettoyée)
  // NE PAS inclure 'rapport' — f-rapport doit rester vide
}
```

---

## Cas particuliers à corriger si signalés

Quand l'utilisateur dit "X est mal placé", mettre à jour ce tableau ET le code correspondant :

| Problème signalé | Correction à faire |
|---|---|
| HTML dans motif | Vérifier que `stripGcalDesc()` est appelé sur `event.description` |
| Rapport pré-rempli | Supprimer `rapport:` de l'objet `data` dans `openBon()` et `timerStopFromBanner()` |
| Adresse manquante | Vérifier l'ordre de priorité dans `clientAdresse` |
| Titre du RDV absent du motif | Vérifier que `event.summary` est inclus dans `description` |
| Liens non cliquables | Ils sont affichés dans le bandeau `#motif-links` de bon.html via `updateMotifLinks()` |
