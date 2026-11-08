-- RETOUR ARRIÈRE de sql/securite-2-verrouillage.sql : rouvre les tables et le stockage avec la clé publique,
-- comme avant (à n'utiliser que si une app ne fonctionne plus après le verrouillage). Supabase → SQL Editor → Run.

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('grant select, insert, update, delete on public.%I to anon', t.tablename);
    execute format('drop policy if exists "Accès public (retour arrière)" on public.%I', t.tablename);
    execute format('create policy "Accès public (retour arrière)" on public.%I for all to anon using (true) with check (true)', t.tablename);
  end loop;
end $$;

drop policy if exists "Accès public (retour arrière) : fichiers" on storage.objects;
create policy "Accès public (retour arrière) : fichiers" on storage.objects for all to anon using (true) with check (true);
