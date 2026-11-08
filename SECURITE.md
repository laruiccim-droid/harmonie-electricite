# Sécurisation des données (Supabase)

Avant : la clé Supabase est visible dans le code des sites (dépôts publics), et les tables acceptaient tout de la part
de n'importe qui ayant cette clé : lire, modifier ou effacer les clients, bons, notes, coffre, chantiers, photos.

Après : seuls vos comptes connectés y ont accès. Les clients qui signent depuis un lien passent par quatre fonctions
qui ne montrent que leur bon. La clé publique peut rester visible : seule, elle ne donne plus accès à rien.

Mettre les dépôts en privé ne protège pas les données (la clé reste dans le site publié) et, sur un compte GitHub
gratuit, arrête la publication GitHub Pages : les apps ne s'ouvriraient plus.

## Étapes, dans l'ordre (sur supabase.com, projet bqzebkobyfktemnwfwbt)

1. **Créer votre compte** : Authentication → Users → *Add user* → *Create new user* : votre e-mail et un mot de passe
   solide, cocher *Auto Confirm User*. (Un compte par personne qui utilise les apps.)
2. **Fermer les inscriptions** : Authentication → Sign In / Providers (ou Settings) → désactiver
   *Allow new users to sign up*. Sinon n'importe qui pourrait se créer un compte.
3. **Fonctions des signatures** : SQL Editor → *New query* → coller `sql/securite-1-fonctions.sql` → *Run*.
   Le résultat liste 4 fonctions. Sans effet sur les apps.
4. **Mise en ligne** des nouvelles versions (app métier et émargement), puis sur le téléphone **et** le PC :
   ouvrir l'app → écran « Connexion » → e-mail + mot de passe. Une fois par appareil, pour les deux apps.
5. **Verrouillage** : SQL Editor → coller `sql/securite-2-verrouillage.sql` → *Run*.
   Le tableau final ne doit plus montrer que `{authenticated}`.
6. **Vérifier** sur le téléphone : agenda, clients, un bon, l'émargement, les relevés, l'envoi d'un e-mail.
   Si quelque chose ne marche plus : `sql/securite-annuler.sql` remet l'accès comme avant, le temps de corriger.

## À savoir

- Un outil extérieur qui utiliserait la clé publique (import EBP, automatisation…) sera refusé après l'étape 5 :
  il lui faudra un compte, ou la clé *service_role* (jamais dans le code d'un site).
- Le coffre est chiffré avec votre code PIN ; jusqu'au verrouillage, le fichier chiffré était téléchargeable par tous.
  Si le PIN est court (4 à 6 chiffres), changez-le après le verrouillage, et changez les mots de passe qu'il contient
  s'ils sont sensibles.
- Les mots de passe des utilisateurs de l'app (`he_users_config`, empreinte SHA-256) étaient lisibles eux aussi :
  changez-les après le verrouillage.
- Les photos restent visibles par leur lien (bucket public) : quelqu'un qui n'a pas le lien ne peut pas les lister.
