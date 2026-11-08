-- SÉCURISATION — ÉTAPE 2 : verrouillage des données
-- À exécuter SEULEMENT quand vous êtes connecté (écran « Connexion ») sur le téléphone ET le PC,
-- avec la nouvelle version des deux apps. Supabase → SQL Editor → coller → Run.
--
-- Avant : n'importe qui ayant la clé publique (visible dans le code des sites) pouvait lire, modifier et effacer
-- toutes les tables (clients, bons, notes, coffre…) et les photos.
-- Après : seuls les comptes connectés (Authentication → Users) y ont accès. Les clients qui signent un lien
-- passent par les fonctions de l'étape 1. Les photos restent visibles par leur lien (bucket public), mais
-- personne d'autre ne peut en ajouter, en remplacer ni en effacer.
-- Retour arrière immédiat si besoin : sql/securite-annuler.sql

-- 1. Tables : on retire tous les accès « anon » / « public » et on ouvre aux seuls comptes connectés
do $$
declare t record; p record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t.tablename and (roles && array['anon', 'public']::name[]) loop
      execute format('drop policy %I on public.%I', p.policyname, t.tablename);
    end loop;
    execute format('drop policy if exists "Comptes connectés" on public.%I', t.tablename);
    execute format('create policy "Comptes connectés" on public.%I for all to authenticated using (true) with check (true)', t.tablename);
    execute format('revoke all on public.%I from anon', t.tablename);
  end loop;
end $$;

-- 2. Stockage (photos, PDF) : écriture, remplacement, suppression et liste réservés aux comptes connectés
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects' and (roles && array['anon', 'public']::name[]) loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;
drop policy if exists "Comptes connectés : fichiers" on storage.objects;
create policy "Comptes connectés : fichiers" on storage.objects for all to authenticated using (true) with check (true);

-- Vérification : aucune ligne ne doit citer anon ou public
select schemaname, tablename, policyname, roles from pg_policies
where schemaname in ('public', 'storage') order by 1, 2;
