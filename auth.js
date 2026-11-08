// Connexion Harmonie Électricité — même fichier dans l'app métier (harmonie-electricite) et l'émargement.
// À charger EN PREMIER dans chaque page (sauf les pages de signature client, publiques).
//
// Toutes les requêtes vers Supabase partent avec la session de l'utilisateur connecté au lieu de la seule clé
// publique : une fois les tables verrouillées (sql/securite-2-verrouillage.sql), personne d'autre ne peut lire
// ni modifier les données. Les deux apps sont sur la même adresse (laruiccim-droid.github.io) : une seule
// connexion par appareil suffit pour les deux, et elle dure (renouvelée toute seule tant que l'app est utilisée).
(function () {
  'use strict';
  var SB_URL = 'https://bqzebkobyfktemnwfwbt.supabase.co';
  var SB_CLE = 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';
  var CLE_SESSION = 'he_supabase_session';
  var fetchOrigine = window.fetch.bind(window);
  var session = lire(), renouvellement = null;

  function lire() { try { return JSON.parse(localStorage.getItem(CLE_SESSION)); } catch (e) { return null; } }
  function enregistrer(s) {
    session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), email: (s.user && s.user.email) || (session && session.email) || '' };
    try { localStorage.setItem(CLE_SESSION, JSON.stringify(session)); } catch (e) {}
  }
  function oublier() { session = null; try { localStorage.removeItem(CLE_SESSION); } catch (e) {} }

  // Session renouvelée une minute avant expiration ; hors ligne, on garde l'ancienne (les requêtes échoueront de toute façon).
  function renouveler() {
    if (renouvellement) return renouvellement;
    renouvellement = fetchOrigine(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: SB_CLE, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }),
    }).then(function (r) {
      if (r.ok) return r.json().then(enregistrer);
      if (r.status === 400 || r.status === 401 || r.status === 403) { oublier(); demanderConnexion('Votre connexion a expiré : reconnectez-vous.'); }
    }).catch(function () {}).then(function () { renouvellement = null; });
    return renouvellement;
  }
  function jeton() {
    if (!session) return Promise.resolve(null);
    if (session.expires_at * 1000 - Date.now() > 60000) return Promise.resolve(session.access_token);
    return renouveler().then(function () { return session && session.access_token; });
  }

  window.fetch = function (entree, options) {
    var url = typeof entree === 'string' ? entree : (entree && entree.url) || String(entree);
    var versSupabase = url.indexOf(SB_URL) === 0 && url.indexOf('/auth/v1/') < 0 && url.indexOf('/storage/v1/object/public/') < 0;
    if (!versSupabase) return fetchOrigine(entree, options);
    return jeton().then(function (t) {
      if (!t) return fetchOrigine(entree, options);
      var entetes = new Headers((options && options.headers) || (entree instanceof Request ? entree.headers : undefined));
      entetes.set('Authorization', 'Bearer ' + t);
      if (!entetes.has('apikey')) entetes.set('apikey', SB_CLE);
      return fetchOrigine(entree, Object.assign({}, options, { headers: entetes }));
    });
  };

  // ---------- Écran de connexion ----------
  function demanderConnexion(message) {
    if (document.getElementById('he-connexion')) return;
    if (!document.body) return document.addEventListener('DOMContentLoaded', function () { demanderConnexion(message); });
    var d = document.createElement('div');
    d.id = 'he-connexion';
    d.innerHTML = '<style>#he-connexion{position:fixed;inset:0;z-index:2147483000;background:#0A0A0A;color:#E8E5DE;display:flex;align-items:center;justify-content:center;'
      + 'padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));font-family:Jost,system-ui,"Segoe UI",sans-serif}'
      + '#he-connexion form{width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px}'
      + '#he-connexion .s{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#C9A86A}'
      + '#he-connexion h2{margin:0 0 6px;font-weight:300;font-size:24px;letter-spacing:.06em;color:#F4F1EA}'
      + '#he-connexion label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#A8A49A}'
      + '#he-connexion input{width:100%;box-sizing:border-box;min-height:46px;border:1px solid rgba(201,168,106,.35);background:#181818;color:#F4F1EA;border-radius:4px;padding:8px 12px;font:inherit;font-size:16px}'
      + '#he-connexion input:focus{outline:none;border-color:#C9A86A}'
      + '#he-connexion button{min-height:48px;border:0;border-radius:4px;background:linear-gradient(135deg,#C9A86A,#DFC28C 50%,#C9A86A);color:#0A0A0A;font:inherit;font-weight:600;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;margin-top:6px}'
      + '#he-connexion button:disabled{opacity:.5}#he-connexion .m{min-height:1.4em;font-size:14px;color:#D9A35B;line-height:1.4}#he-connexion .a{font-size:13px;color:#857F74;line-height:1.5}</style>'
      + '<form novalidate><div class="s">Harmonie Électricité</div><h2>Connexion</h2>'
      + '<label for="he-email">E-mail</label><input id="he-email" type="email" autocomplete="username" inputmode="email" required>'
      + '<label for="he-mdp">Mot de passe</label><input id="he-mdp" type="password" autocomplete="current-password" required>'
      + '<div class="m" id="he-msg"></div><button type="submit" id="he-ok">Se connecter</button>'
      + '<p class="a">Une seule connexion par appareil, pour l’app métier et l’émargement. Elle reste active ensuite, même sans réseau.</p></form>';
    document.body.appendChild(d);
    var f = d.querySelector('form'), msg = d.querySelector('#he-msg');
    if (message) msg.textContent = message;
    var email = d.querySelector('#he-email'); email.value = (session && session.email) || localStorage.getItem('he_dernier_email') || ''; (email.value ? d.querySelector('#he-mdp') : email).focus();
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var em = email.value.trim(), mdp = d.querySelector('#he-mdp').value;
      if (!em || !mdp) { msg.textContent = 'Indiquez votre e-mail et votre mot de passe.'; return; }
      var b = d.querySelector('#he-ok'); b.disabled = true; msg.textContent = 'Connexion…';
      fetchOrigine(SB_URL + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: SB_CLE, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, password: mdp }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j.access_token) {
            enregistrer(j); try { localStorage.setItem('he_dernier_email', em); } catch (e2) {}
            location.reload(); // la page repart avec la connexion
            return;
          }
          b.disabled = false;
          msg.textContent = r.status === 400 ? 'E-mail ou mot de passe incorrect.' : 'Connexion impossible (' + (j.msg || j.error_description || r.status) + ').';
        });
      }).catch(function () { b.disabled = false; msg.textContent = 'Pas de réseau : la première connexion sur cet appareil demande Internet.'; });
    });
  }

  window.heAuth = {
    email: function () { return session && session.email; },
    connecte: function () { return !!session; },
    deconnecter: function () {
      var s = session; oublier();
      if (s) fetchOrigine(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_CLE, Authorization: 'Bearer ' + s.access_token } }).catch(function () {});
      demanderConnexion('Vous êtes déconnecté.');
    },
  };

  if (!session) demanderConnexion();
  else if (session.expires_at * 1000 - Date.now() < 60000 && navigator.onLine !== false) renouveler();
})();
