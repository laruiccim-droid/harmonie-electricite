-- À exécuter une seule fois dans Supabase → SQL Editor
-- Table de suivi du cycle de vie des interventions (même pattern JSONB que notes/checklist/clients/devis)

create table if not exists public.interventions (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Active la RLS et autorise l'accès via la clé publique (même pattern que les autres tables)
alter table public.interventions enable row level security;

create policy "Allow anon all on interventions"
  on public.interventions
  for all
  to anon
  using (true)
  with check (true);

-- Structure attendue du champ payload (documentation, pas de contrainte stricte) :
-- {
--   "id": "INT2026-001",
--   "client_id": "...",
--   "residence_id": "...",          -- optionnel
--   "client_nom": "...",
--   "adresse": "...",
--   "type": "intervention" | "maintenance" | "devis",
--   "statut": "attente_planification" | "planifiee" | "en_cours"
--            | "terminee" | "rapport_envoye" | "facturee" | "annulee",
--   "description": "...",
--   "date_demande": "2026-06-12",
--   "date_planifiee": "2026-06-15",
--   "date_debut": null,
--   "date_fin": null,
--   "rapport_pdf_url": null,
--   "devis_id": null,               -- lien vers table devis si applicable
--   "notif_assistante": { "devis": false, "facture": false, "lue": false },
--   "createdAt": 1234567890,
--   "updatedAt": 1234567890
-- }
