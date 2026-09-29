# 📻 Radio OACV — site public

Ce dépôt contient **le site public** de la radio : la page que les visiteurs
ouvrent pour écouter. Il est **entièrement statique** — aucune base de données,
aucun serveur, aucune dépendance. Le site est donc disponible en permanence,
avec HTTPS, depuis Netlify.

## Ce qu'il y a dedans

```text
index.html          la page
style.css           le design (couleurs dynamiques, animations)
app.js              le moteur : antenne, file de lecture, jingle, publicité
ui.js               l'interface : pochette, paroles, visualiseur
assets/             le logo
audio/              jingle et publicité maison, joués par app.js
netlify.toml        cache, en-têtes de sécurité, redirections
```

La musique vient de YouTube (lecteur intégré) et la liste des titres est
récupérée depuis les API publiques Piped / Invidious. Rien n'est stocké ici.

## ⚠️ Ce dépôt est généré automatiquement

**Ne modifiez pas ces fichiers à la main.** Tout est produit par
`radio/tools/export-site.js` à partir du projet `radio/`, sur votre machine.
Vos éventuelles modifications seraient écrasées à la prochaine mise en ligne,
et ne seraient pas déployées.

Pour mettre le site à jour :

```bash
cd radio
npm run export          # recrée ce dossier depuis le projet
cd ../radio-site
git add . && git commit -m "Mise à jour du site" && git push
```

## Ce qui n'est pas ici

L'administration de la radio (annonces au micro, programmation, gestion de la
banque) tourne sur **votre machine**, via un serveur Node qui n'est jamais
connecté à Internet. Aucun mot de passe, aucune donnée d'annonce, aucun secret
ne figure dans ce dépôt.
