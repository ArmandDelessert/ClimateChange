# ClimateChange

Recueil de visualisations et animations de données. Chaque visualisation vit dans son propre
dossier, autonome (HTML, JS, CSS, données et script de build), avec son propre `README.md`.

## Visualisations

- [`climate-spiral/`](climate-spiral/) — chaque jour depuis 1940 dessiné en une spirale (ERA5
  quotidien), à plat ou en entonnoir 3D.

## Ajouter une visualisation

Créer un nouveau dossier à la racine, sur le modèle de `climate-spiral/` : une page de démo, le
code, les données déjà préparées si la source ne peut pas être appelée directement depuis le
navigateur (CORS), un script de régénération si les données évoluent, et un `README.md` propre au
dossier. Puis ajouter un lien dans `index.html` et dans la liste ci-dessus.

## Lancer en local

```bash
python -m http.server 8123
```

Puis ouvrir <http://localhost:8123/>.
