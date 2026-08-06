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
|---|---|
| `play()` / `pause()` / `toggle()` | Lecture automatique. Relance depuis 1940 si le curseur est à la fin. |
| `seekToIndex(i)` | Positionne sur le i-ème jour (0 = 1940-01-01). |
| `seekToYear(1998)` | Positionne au 1er janvier de l'année. |
| `stepYear(±1)` | Avance ou recule d'une année pleine. |
| `setOpenness(v, animate)` | `0` à plat, `1` entonnoir. Transition adoucie de 900 ms par défaut. |
| `setSpeed(joursParSeconde)`, `setLoop(bool)`, `setTheme('dark'\|'light')` | |
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

Les anomalies sont stockées en **milli-degrés entiers** (`valeur / 1000 = °C`). C'est exactement la
précision de la source ; un arrondi plus grossier reclasserait des jours situés juste au-dessus
d'un seuil (en centi-degrés, 8 des 281 jours de 2024 passent sous la barre).

## Données et attribution

Température quotidienne moyenne mondiale de l'air à 2 m, issue de la réanalyse **ERA5** produite
par l'ECMWF pour le **Copernicus Climate Change Service (C3S)**, récupérée via la série publiée
par [Climate Pulse](https://pulse.climate.copernicus.eu/) :

<https://sites.ecmwf.int/data/climatepulse/data/series/era5_daily_series_2t_global.csv>

Les anomalies publiées sont relatives à la période de référence 1991-2020. Pour les exprimer par
rapport au niveau préindustriel 1850-1900, que la réanalyse ERA5 ne couvre pas, on ajoute l'offset
standard de **+0,88 °C** retenu par C3S d'après le rapport IPCC AR6 WGI
([Temperature Q&As](https://climate.copernicus.eu/temperature-qas)).

Les données Copernicus sont réutilisables sous la licence Copernicus, à condition de citer la
source. La note de bas de page de `index.html` porte cette mention ; conservez-la si vous
réutilisez la visualisation.

Le fichier de données est **versionné** dans le dépôt, et non chargé en direct : l'endpoint ECMWF
ne renvoie pas d'en-tête `Access-Control-Allow-Origin`, un navigateur ne peut donc pas le lire
depuis une autre origine.

## Notes d'implémentation

- **Projection.** La spirale occupe le plan XY, les années s'empilent sur Z. L'ouverture pilote
  conjointement l'inclinaison et l'écartement, ce qui garantit une vue de dessus exactement plate
  à `openness = 0`. La pile est recentrée verticalement à chaque image, sinon la division
  perspective — qui grossit la face avant et rétrécit la face arrière — fait dériver l'entonnoir
  hors du cadre.
- **Sens d'ouverture.** L'entonnoir s'évase vers le haut : 1940 en bas, l'année courante en haut.
  C'est l'inclinaison qui est négative, et non le signe de Z : inverser Z retournerait aussi la
  profondeur et placerait la large embouchure au fond.
- **Ordre de tracé.** 1940 est placé au fond de l'entonnoir et aujourd'hui à l'avant, si bien que
  l'ordre chronologique est aussi le bon ordre du peintre.
- **Résultat déterministe.** Les chemins du script sont relatifs à son propre dossier
  (`Path(__file__).resolve().parent`), pas au répertoire courant : `build_data.py` peut être lancé
  depuis n'importe où et écrit toujours dans `climate-spiral/data/`.
- **Cache à deux couches.** Les années déjà terminées vivent dans un canvas hors écran ; seule
  l'année en cours est redessinée à chaque image. Avancer d'une année ajoute à ce cache, un recul
  ou un changement de caméra le reconstruit.
- **Groupement des tracés.** Les segments sont répartis par godet de couleur en une seule passe
  (et non en rebalayant l'année une fois par godet), et les segments consécutifs de même couleur
  forment un seul sous-chemin — des sous-chemins isolés feraient rasteriser deux embouts de ligne
  chacun. Ces deux points valent chacun environ un facteur 4 sur une reconstruction complète :
  288 ms avant, ~6 ms après (p95 10,4 ms) pour les 31 627 segments. En lecture courante, une image
  coûte 0,7 ms.

## Accessibilité

Contrôles étiquetés, raccourcis clavier (espace pour lire/pause, ← → pour changer d'année,
Origine/Fin pour les extrémités), description vivante du canvas via `aria-label`, et lecture
automatique désactivée si `prefers-reduced-motion` est actif.
