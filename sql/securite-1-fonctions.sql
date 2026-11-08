-- SÉCURISATION — ÉTAPE 1 : fonctions des pages de signature client
-- Supabase → SQL Editor → coller ce fichier → Run. Sans effet sur les apps : on peut l'exécuter à tout moment.
--
-- Les clients qui signent depuis un lien (signer.html de l'app métier et de l'émargement) ne sont pas connectés.
-- Ces fonctions leur donnent accès à LEUR bon uniquement (retrouvé par le jeton du lien), sans aucun accès aux tables.

-- App métier : bon à signer, retrouvé par son jeton (payload.sigToken)
create or replace function public.signer_bon_lire(jeton text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'payload', payload)
  from public.devis
  where length(coalesce(jeton, '')) >= 8 and payload->>'sigToken' = jeton
  limit 1;
$$;

-- App métier : enregistre la signature et invalide le lien (comme le faisait signer.html)
create or replace function public.signer_bon_signer(jeton text, signature text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if length(coalesce(jeton, '')) < 8 or length(coalesce(signature, '')) < 100 or length(signature) > 2000000 then return false; end if;
  update public.devis
     set payload = (payload - 'sigToken') || jsonb_build_object(
           'sigClientData', signature,
           'sigClientDate', (extract(epoch from now()) * 1000)::bigint,
           'sigClientOk', true)
   where payload->>'sigToken' = jeton;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Émargement : demande de signature à distance (ligne SIG_<jeton> de la table emargements)
create or replace function public.emargement_signature_lire(jeton text)
returns jsonb language sql stable security definer set search_path = public as $$
  select payload from public.emargements
  where jeton ~ '^[0-9a-f]{32}$' and id = 'SIG_' || jeton
  limit 1;
$$;

create or replace function public.emargement_signature_signer(jeton text, signature text, signataire text, navigateur text default '')
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if jeton !~ '^[0-9a-f]{32}$' or length(coalesce(signature, '')) < 100 or length(signature) > 2000000
     or length(trim(coalesce(signataire, ''))) = 0 then return false; end if;
  update public.emargements
     set payload = payload || jsonb_build_object(
           'statut', 'signe', 'signature', signature, 'signataire', left(trim(signataire), 200),
           'signeLe', (extract(epoch from now()) * 1000)::bigint, 'navigateur', left(coalesce(navigateur, ''), 400))
   where id = 'SIG_' || jeton and coalesce(payload->>'statut', '') <> 'signe';
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Seules ces quatre fonctions sont ouvertes aux visiteurs non connectés.
revoke all on function public.signer_bon_lire(text) from public;
revoke all on function public.signer_bon_signer(text, text) from public;
revoke all on function public.emargement_signature_lire(text) from public;
revoke all on function public.emargement_signature_signer(text, text, text, text) from public;
grant execute on function public.signer_bon_lire(text) to anon, authenticated;
grant execute on function public.signer_bon_signer(text, text) to anon, authenticated;
grant execute on function public.emargement_signature_lire(text) to anon, authenticated;
grant execute on function public.emargement_signature_signer(text, text, text, text) to anon, authenticated;

-- Vérification : doit renvoyer 4 lignes
select proname from pg_proc where proname in ('signer_bon_lire', 'signer_bon_signer', 'emargement_signature_lire', 'emargement_signature_signer');
