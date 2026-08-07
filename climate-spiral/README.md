# Spirale du réchauffement — ERA5 quotidien

Chaque jour depuis 1940 dessiné en une spirale : une boucle par année, le rayon suit l'écart de
température moyenne mondiale au niveau préindustriel. Un paramètre unique, l'**ouverture**,
interpole en continu entre la spirale vue de dessus et un entonnoir 3D où les années sont
écartées le long d'un axe temporel — étroit et bleu dans les années 1940, évasé et rouge
aujourd'hui.

Module ES sans aucune dépendance, rendu en Canvas 2D avec une projection perspective écrite à la
main (pas de bibliothèque 3D).

```
index.html                      page de démonstration (poster complet)
climate-spiral.js               le module : classe ClimateSpiral
climate-spiral.css              thèmes clair/sombre et mise en page des contrôles
data/era5-daily-anomaly.json    données générées, versionnées
build_data.py                   régénération des données + contrôles de non-régression
```

Ce dossier est autonome : il peut être déplacé ou copié tel quel dans un autre dépôt.

## Lancer la démo

Un serveur HTTP est nécessaire : la page est un module ES et charge les données par `fetch`,
ce qui ne fonctionne pas depuis un `file://`.

```bash
cd climate-spiral
python -m http.server 8123
```

Puis ouvrir <http://localhost:8123/>.

## Intégrer dans une page

```html
<link rel="stylesheet" href="climate-spiral.css">
<canvas id="spiral" style="width: 640px; height: 640px"></canvas>

<script type="module">
  import { ClimateSpiral } from './climate-spiral.js';

  const data = await fetch('./data/era5-daily-anomaly.json').then((r) => r.json());
  const spiral = new ClimateSpiral(document.getElementById('spiral'), data, {
    theme: 'dark',      // 'dark' | 'light'
    openness: 0,        // 0 = à plat, 1 = entonnoir
    speed: 180,         // jours par seconde (~2 s par année)
    loop: false,
  });

  spiral.on('change', (state) => console.log(state.year, state.anomalyC));
  spiral.play();
</script>
```

Le canvas doit avoir une taille en CSS ; le module gère lui-même la résolution (`devicePixelRatio`)
et suit les redimensionnements via un `ResizeObserver`.

### API

| Méthode | Effet |
| --- | --- |
| `play()` / `pause()` / `toggle()` | Lecture automatique. Relance depuis 1940 si le curseur est à la fin. |
| `seekToIndex(i)` | Positionne sur le i-ème jour (0 = 1940-01-01). |
| `seekToYear(1998)` | Positionne au 1er janvier de l'année. |
| `stepYear(±1)` | Avance ou recule d'une année pleine. |
| `stepDay(±1)` | Avance ou recule d'un seul jour. |
| `setOpenness(v, animate)` | `0` à plat, `1` entonnoir. Transition adoucie de 900 ms par défaut. |
| `setSpeed(joursParSeconde)`, `setLoop(bool)`, `setTheme('dark'\|'light')` | |
| `setHoverPoint(x, y)` | Affiche un trait radial + la date au jour le plus proche de ce point (coordonnées en pixels bitmap du canvas). |
| `clearHover()` | Masque le trait de survol. |
| `on('change', fn)` | Notifié à chaque changement d'état ; renvoie une fonction de désabonnement. |
| `destroy()` | Libère la boucle d'animation et les observateurs. |

Propriétés en lecture : `length`, `index`, `playing`, `openness`, `meta`, `state`.

`state` contient `{ index, year, month, date, anomalyC, playing, openness, loop, speed, theme }` et
constitue le point de synchronisation unique de l'interface : la page de démo n'inspecte jamais
l'état interne du module.

### Thème

Le module lit trois propriétés CSS personnalisées sur le canvas — `--cs-ring`, `--cs-ring-accent`,
`--cs-label` — pour accorder les anneaux et les libellés au reste de la page. Les rampes de
couleur des courbes sont définies dans le module (`RAMPS`).

## Régénérer les données

```bash
python climate-spiral/build_data.py
```

Le script télécharge la série quotidienne, applique l'offset préindustriel, écrit
`data/era5-daily-anomaly.json`, et **échoue** si l'un des contrôles de non-régression ne passe
pas :

- 0 jour au-dessus de +1,5 °C en 1940, **281 en 2024** ;
- premier franchissement de +1,5 °C le **5 octobre 2015** ;
- série continue, sans trou ni doublon, années pleines à 365 ou 366 jours.

Ces valeurs ont été publiées indépendamment par C3S ; elles verrouillent toute la chaîne (colonne
source, offset, arrondi) et signalent une modification silencieuse en amont.

### Actualisation automatique

Le workflow [`update-era5-data.yml`](../.github/workflows/update-era5-data.yml) relance ce script
une fois par jour (09:00 UTC) et publie le résultat s'il diffère. Comme la page charge les données
par `fetch` à l'exécution, publier un nouveau `era5-daily-anomaly.json` sur la branche servie par
GitHub Pages suffit — aucune reconstruction du site n'est nécessaire.

Le même workflow relève l'en-tête `Last-Modified` du CSV source à chaque exécution et l'ajoute à
`data/source-last-modified-log.csv`. La cadence de publication exacte de la source n'étant pas
documentée, ce journal permet de la déterminer après quelques semaines de relevés, et d'ajuster
l'horaire du cron en conséquence si besoin.

Les anomalies sont stockées en **milli-degrés entiers** (`valeur / 1000 = °C`). C'est exactement la
précision de la source ; un arrondi plus grossier reclasserait des jours situés juste au-dessus
d'un seuil (en centi-degrés, 8 des 281 jours de 2024 passent sous la barre).

## Données et attribution

Température quotidienne moyenne mondiale de l'air à 2 m, issue de la réanalyse **ERA5** produite par le [**Centre européen pour les prévisions météorologiques à moyen terme**](https://www.ecmwf.int/) (**CEPMMT** ; en anglais European Centre for Medium-Range Weather Forecasts, **ECMWF**) pour le [**Copernicus Climate Change Service**](https://climate.copernicus.eu/) (**C3S**), récupérée via la série publiée par [**Climate Pulse**](https://pulse.climate.copernicus.eu/) :

<https://sites.ecmwf.int/data/climatepulse/data/series/era5_daily_series_2t_global.csv>

Ce CSV source contient quatre colonnes :

| Colonne | Signification |
| --- | --- |
| `2t` | Température moyenne journalière absolue, moyenne des 24 valeurs horaires de 00h à 23h UTC. |
| `clim_91-20` | Climatologie du jour : la moyenne de `2t` pour cette date calendaire (ex. tous les 15 mars), calculée sur la période de référence 1991-2020. C'est la « normale » à laquelle le jour est comparé. |
| `ano_91-20` | Anomalie du jour par rapport à sa climatologie 1991-2020, c'est-à-dire `2t − clim_91-20`. |
| `status` | `PRELIMINARY` ou `FINAL` : les tout derniers jours sont provisoires et peuvent légèrement changer une fois les données ERA5 définitives disponibles (habituellement 3 jours de délai). |

### Données affichées dans l'animation

La spirale n'affiche pas `ano_91-20` brute, mais `ano_91-20 + 0,88` — l'anomalie ramenée au niveau
préindustriel 1850-1900 plutôt qu'à la référence 1991-2020, ERA5 ne couvrant pas 1850-1900
directement. Le décalage standard de **+0,88 °C** est celui retenu par C3S, d'après le rapport IPCC
AR6 WGI ([Temperature Q&As](https://climate.copernicus.eu/temperature-qas)).

C'est ce calcul qui est fait dans `build_data.py` avant écriture du JSON ; le rayon et la couleur de
chaque jour dans la spirale suivent ensuite cette valeur décalée, pas la colonne brute du CSV.

Les données Copernicus sont réutilisables sous la licence Copernicus, à condition de citer la
source. La note de bas de page de `index.html` porte cette mention ; conservez-la si vous
réutilisez la visualisation.

Le fichier de données est **versionné** dans le dépôt, et non chargé en direct : l'endpoint ECMWF
ne renvoie pas d'en-tête `Access-Control-Allow-Origin`, un navigateur ne peut donc pas le lire
depuis une autre origine.

## Notes d'implémentation

- **Échelle rayon/couleur.** L'anomalie affichée (voir « Données affichées » ci-dessus) est mise à
  l'échelle entre `A_MIN = -0,6 °C` (fixe) et un `A_MAX` calculé à l'initialisation :
  `max(2,2, anomalie_max_des_données + 0,15)`. Le plancher de 2,2 reproduit exactement le rendu
  actuel (l'anomalie maximale observée est +2,035 °C) ; il ne s'élève que si des données futures le
  dépassent, et ne redescend jamais. La couleur suit la même règle. Ainsi, ajouter des années dans
  `era5-daily-anomaly.json` — y compris des valeurs extrêmes — ne casse jamais le rendu : pas de
  point qui déborde du cadre, pas besoin de retoucher le code.
- **Projection.** La spirale occupe le plan XY, les années s'empilent sur Z. L'ouverture pilote
  conjointement l'inclinaison et l'écartement, ce qui garantit une vue de dessus exactement plate
  à `openness = 0`. La pile est recentrée verticalement à chaque image (`cam.yShift`), sinon la
  division perspective — qui grossit la face avant et rétrécit la face arrière — fait dériver
  l'entonnoir hors du cadre. Ce recentrage est multiplié par `openness` : sans ce facteur, la vue à
  plat se retrouvait décalée verticalement d'environ 15 % du rayon, l'estimation utilisée (écart
  entre l'anomalie max de la première et de la dernière année) restant non nulle même sans la
  moindre inclinaison à corriger.
- **Sens d'ouverture.** L'entonnoir s'évase vers le haut : 1940 en bas, l'année courante en haut.
  C'est l'inclinaison qui est négative, et non le signe de Z : inverser Z retournerait aussi la
  profondeur et placerait la large embouchure au fond.
- **Ouverture complète.** Plus `TILT_MAX` (l'inclinaison à `openness = 1`) approche 90°, plus la
  caméra regarde les plans-années par la tranche : combiné à la perspective de profondeur, les
  années lointaines (très réduites par la distance) s'aplatissent en bandes, tandis que les années
  proches (agrandies par la perspective) restent des ellipses nettes — un effet de tube conique,
  pas un défaut de rendu.
- **Ordre de tracé.** 1940 est placé au fond de l'entonnoir et aujourd'hui à l'avant, si bien que
  l'ordre chronologique est aussi le bon ordre du peintre.
- **Résultat déterministe.** Les chemins du script sont relatifs à son propre dossier
  (`Path(__file__).resolve().parent`), pas au répertoire courant : `build_data.py` peut être lancé
  depuis n'importe où et écrit toujours dans `climate-spiral/data/`.
- **Cache à deux couches.** Les années déjà terminées vivent dans un canvas hors écran ; seule
  l'année en cours est redessinée à chaque image. Avancer d'une année ajoute à ce cache, un recul
  ou un changement de caméra le reconstruit.
- **Survol.** `setHoverPoint` place le point sur le plan de l'année actuellement affichée et
  résout l'angle par une itération à point fixe (la perspective dépend du rayon qu'on cherche à
  déterminer) : suffisant pour une aide au survol, sans viser une précision infra-jour.
- **Illumination des anneaux.** Chaque anneau de référence (0/+0,5/+1/+1,5/+2 °C) mémorise à
  l'initialisation le premier jour où il a été franchi (`#ringFirstCross`), et s'illumine puis
  s'estompe sur 45 jours simulés à partir de ce jour précis — un événement figé dans le temps, pas
  un état : revenir en arrière puis rejouer refranchit le même jour et rallume le même flash.
- **Groupement des tracés.** Les segments sont répartis par godet de couleur en une seule passe
  (et non en rebalayant l'année une fois par godet), et les segments consécutifs de même couleur
  forment un seul sous-chemin — des sous-chemins isolés feraient rasteriser deux embouts de ligne
  chacun. Ces deux points valent chacun environ un facteur 4 sur une reconstruction complète :
  288 ms avant, ~6 ms après (p95 10,4 ms) pour les 31 627 segments. En lecture courante, une image
  coûte 0,7 ms.

## Accessibilité

Contrôles étiquetés, description vivante du canvas via `aria-label`, et lecture automatique
désactivée si `prefers-reduced-motion` est actif.

Raccourcis clavier :

| Touche | Effet |
| --- | --- |
| Espace | Lecture / pause |
| ← → | Année précédente / suivante |
| Ctrl/Cmd/Maj + ← → | Jour précédent / suivant |
| Origine / Fin | Tout début (1940-01-01) / jour le plus récent |
