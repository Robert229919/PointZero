# Point Zéro

Corrige le drift des sticks d'une manette PS5 (DualSense ou DualSense Edge) dans **tous les jeux PC**, et teste
la manette de fond en comble. Un seul `PointZero.exe`, sans installation, interface en français.

Le principe est celui de DS4Windows :

1. Point Zéro lit la DualSense en HID brut (USB ou Bluetooth).
2. Il corrige les sticks à partir d'un **diagnostic guidé** de ta manette : retrait du décalage mesuré, zone morte radiale progressive, zone externe, courbe.
3. Il crée une manette virtuelle avec **ViGEmBus** (Xbox 360 par défaut, DualShock 4 au choix).
4. **HidHide** cache la vraie manette aux jeux **uniquement pendant que Point Zéro tourne**, pour éviter une double entrée.

## Avertissement : utilisation à vos risques

Point Zéro est un projet personnel, fourni gratuitement **« tel quel », sans aucune garantie** d'aucune sorte,
expresse ou implicite, notamment de bon fonctionnement, de compatibilité ou d'adéquation à un usage particulier.

**L'auteur décline toute responsabilité** pour tout problème, dommage ou perte, direct ou indirect, qui découlerait
de l'installation ou de l'utilisation de ce logiciel, des pilotes tiers qu'il utilise (ViGEmBus, HidHide) ou des
instructions de ce dépôt. Cela concerne notamment :

- la manette, y compris ses sticks, ses gâchettes adaptatives, ses moteurs, son haut-parleur et sa batterie ;
- l'ordinateur, le système d'exploitation et ses pilotes ;
- les données ;
- les jeux : sauvegardes, parties en ligne, sanctions d'un anti-triche.

Point Zéro installe et utilise des pilotes de périphériques. Il peut créer une tâche planifiée qui s'exécute avec
les droits administrateur. Il change la visibilité de la manette pour les autres applications et lui envoie des
commandes : vibrations, gâchettes adaptatives, lumières, audio. Certains jeux ou anti-triches peuvent refuser les
manettes virtuelles.

**En utilisant ce logiciel, vous acceptez d'en assumer seul l'entière responsabilité.** Si vous n'êtes pas
d'accord, ne l'utilisez pas.

Ce projet n'est ni affilié à Sony Interactive Entertainment, ni approuvé par elle. « PlayStation », « DualSense » et
« DualShock » sont des marques de Sony. Le dessin de manette de l'interface est original : aucun élément graphique
officiel n'est utilisé.

## Compatibilité

| Manette | Prise en charge |
|---|---|
| DualSense (PS5) | Oui, en USB et en Bluetooth. C'est la manette avec laquelle Point Zéro a été testé. |
| DualSense Edge (PS5) | Reconnue, correction des sticks identique. Les palettes arrière et les boutons Fn n'ont pas été vérifiés. |
| DualShock 4 (PS4), manettes Xbox, Switch Pro, manettes génériques | Non |

Point Zéro ne reconnaît que les identifiants USB de Sony pour les manettes PS5 (054C:0CE6 et 054C:0DF2), car il lit
leur format de données propre. Le « mode DualShock 4 » des Réglages ne concerne que la **manette virtuelle** que
voient les jeux.

Système : Windows 10 ou 11, 64 bits.

## Télécharger

Le dernier `PointZero.exe` se trouve dans les [Releases](https://github.com/Robert229919/PointZero/releases).
Quand une nouvelle version sort, Point Zéro affiche une fenêtre qui la présente, avec un lien vers la page de
téléchargement. On peut désactiver ce rappel dans Réglages → Mises à jour.

C'est la **seule connexion réseau** de Point Zéro : une requête anonyme à l'API publique des releases GitHub,
au démarrage puis toutes les 6 heures. Rien sur vous ni sur votre PC n'est envoyé.

## 1. Installer les pilotes (une seule fois)

Deux pilotes de Nefarius, depuis leurs installeurs officiels sur GitHub. Le plus simple est winget, qui télécharge
ces mêmes installeurs et vérifie leur empreinte :

```powershell
winget install --id ViGEm.ViGEmBus --exact
```

```powershell
winget install --id Nefarius.HidHide --exact
```

Sinon, téléchargez-les à la main :

- ViGEmBus 1.22.0 : <https://github.com/nefarius/ViGEmBus/releases>. Le projet est archivé, mais le pilote fonctionne toujours.
- HidHide 1.5.230 : <https://github.com/nefarius/HidHide/releases>

**Après avoir installé HidHide, débranchez et rebranchez la manette une fois** (ou redémarrez le PC). Le filtre
HidHide ne s'attache à la manette qu'au branchement. Tant que ce n'est pas fait, Point Zéro l'indique dans la
barre latérale.

Sans ces pilotes, Point Zéro fonctionne en **testeur seul** : il mesure et teste, mais ne corrige rien dans les jeux.

## 2. Installer Point Zéro

Copiez `PointZero.exe` où vous voulez (par exemple `%LOCALAPPDATA%\Programs\PointZero\`) et lancez-le.
Il ne demande pas les droits administrateur. Il a besoin du runtime Microsoft Edge WebView2, déjà présent sur
Windows 10 et 11.

Au premier lancement, Point Zéro s'ajoute à la liste blanche de HidHide pour continuer à voir la vraie manette.
Il y ajoute aussi BatteryHub, s'il est ouvert, pour qu'il continue à afficher la batterie.

## 3. Utilisation

- **01 Correction** : deux oscilloscopes affichent le signal brut (gris) et le signal corrigé (vert) avec leur traînée.
  - Pour chaque stick : `Zone morte`, `Zone externe`, `Courbe`, `Anti-zone morte` (pour annuler la zone morte propre à un jeu) et `Suivi du drift` (recentrage lent au repos).
  - `Calibrer le centre` : posez la manette sans la toucher. Point Zéro mesure le repos pendant 2 s et propose une zone morte juste au-dessus du bruit mesuré.
  - L2 et R2 ont aussi une zone morte et une zone externe.
  - Les profils sont enregistrés en JSON dans `%APPDATA%\PointZero\profiles`.
- **02 Diagnostic** : procédure guidée.
  1. Repos.
  2. « Pousse le stick en haut à droite… relâche », dans les 8 directions, deux tours : 16 retours au centre.
  3. Trois tours en butée.
  4. Résultat : décalage, dispersion du retour au centre, bruit, amplitude, circularité, sauts, zone morte conseillée et un verdict honnête. Au-delà d'environ 20 % de zone morte nécessaire, il vaut mieux réparer le stick.
  - **Le résultat est appliqué automatiquement** au profil actif : centre, zone morte et zone externe. Le bouton `Annuler` revient aux réglages précédents. L'écran Correction indique d'où viennent les réglages de chaque stick : diagnostic du…, ajusté à la main, centre calibré, ou réglages standard.
- **03 Testeur** : tous les boutons (PS, Create, Options, Mute, clic du pavé, L3/R3), les gâchettes analogiques, le gyroscope et l'accéléromètre, le pavé tactile (2 doigts), les vibrations, les gâchettes adaptatives, la barre LED, les LEDs joueur et la LED micro, la batterie, ainsi que le haut-parleur et le micro (en USB).
- **04 Réglages** :
  - Manette virtuelle Xbox 360 ou DualShock 4.
  - Lancement au démarrage de Windows, réduction dans la zone de notification.
  - Applications autorisées à voir la vraie manette.
  - **Cacher la vraie manette aux jeux** : un interrupteur, aussi présent en haut de chaque écran à côté de « Correction ». Position Visible : les jeux voient la vraie manette **et** la manette virtuelle, ce qui sert par exemple pour un outil web comme dualshock-tools.
  - **Actualisation de la manette** : voir ci-dessous.

L'icône de la zone de notification a un point vert quand la correction est active. Un clic droit dessus permet
d'activer ou désactiver la correction, de cacher ou montrer la vraie manette, ou de quitter. Fermer la fenêtre la
réduit seulement : la correction continue.

### Actualisation de la manette (applications déjà ouvertes)

HidHide n'empêche que les **nouvelles** ouvertures de la manette :

- Une application qui la tenait déjà (Steam lancé au démarrage, un navigateur, un jeu) continue de la voir quand elle est cachée.
- Une application à qui elle a été refusée ne la retrouve pas quand elle redevient visible.

Point Zéro redémarre donc la manette une fraction de seconde à chaque changement. Toutes les applications la redétectent alors selon le nouvel état. Il faut les droits administrateur, d'où un assistant installé **une seule fois** depuis Réglages, avec une fenêtre UAC :

- une tâche planifiée `PointZero RestartPad`, exécutée en SYSTEM ;
- elle lance uniquement le script fixe `C:\Program Files\PointZero\restart-pad.ps1`, qui redémarre seulement la DualSense ;
- votre compte peut la déclencher sans fenêtre UAC.

Une application peut refuser ce redémarrage, en général un jeu lancé avant Point Zéro qui tient la manette. Point
Zéro affiche alors son nom. Windows marque ensuite la manette « redémarrage requis » et ignore les redémarrages
suivants. Fermez le jeu puis reconnectez la manette : câble, ou appui long sur PS pendant 10 s puis PS.
Pour éviter ce cas, lancez Point Zéro avant vos jeux, par exemple au démarrage de Windows.

### Vérifier que les jeux ne voient que la manette virtuelle

Pendant que Point Zéro tourne, `Win+R` puis `joy.cpl` ne doit lister que **Controller (XBOX 360 For Windows)**.
Une fois Point Zéro fermé, on y retrouve **DualSense Wireless Controller**.

### Steam

Steam est sur la liste des applications qui ne voient pas la vraie manette : il ne voit que la manette virtuelle.
Si un jeu Steam réagit en double ou affiche de mauvaises icônes de boutons, désactivez Steam Input pour ce jeu
(Propriétés → Manette → « Désactiver Steam Input »).

### Outils web (dualshock-tools…)

Pour qu'un site comme dualshock-tools voie la **vraie** DualSense, passez « Vraie manette » sur **Visible**.
L'actualisation la fait réapparaître dans le navigateur.

En mode DualShock 4, le site voit aussi la manette virtuelle de Point Zéro. Ce n'est pas votre manette : la
calibrer ne sert à rien.

Si vous recalibrez la vraie manette avec ce site, refaites ensuite le diagnostic de Point Zéro, car son centre aura
changé.

## 4. Sécurité : la vraie manette n'est jamais cachée pour de bon

- À la fermeture normale (« Quitter » ou `PointZero.exe --quit`), le masquage est retiré et HidHide revient à son état d'avant.
- Chaque modification de HidHide est d'abord écrite dans `%APPDATA%\PointZero\cloak-state.json`. Après un crash ou une coupure, le masquage est retiré :
  - au prochain démarrage de Point Zéro ;
  - ou, à défaut, à la prochaine ouverture de session, par une entrée `RunOnce` temporaire (`PointZero.exe --cleanup`). Cette entrée n'existe que pendant que la manette est cachée.
- Interrupteur manuel : « Vraie manette : Visible » en haut de l'appli ou dans Réglages, ou clic droit sur l'icône, puis « Cacher la vraie manette ».
- En dernier recours : `PointZero.exe --cleanup`, ou le « HidHide Configuration Client » (décochez « Enable device hiding »).

## 5. Désinstallation propre

1. Quittez Point Zéro : clic droit sur l'icône, puis « Quitter ». La vraie manette redevient visible.
2. Si vous aviez activé « Lancer au démarrage de Windows », désactivez-le dans Réglages ou supprimez la valeur `PointZero` de `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
3. Si l'actualisation automatique est activée, désactivez-la dans Réglages (une fenêtre UAC). Sinon, dans un terminal administrateur : `schtasks /Delete /TN "PointZero RestartPad" /F`, puis supprimez `C:\Program Files\PointZero`.
4. Supprimez `PointZero.exe`, `%APPDATA%\PointZero` (réglages, profils, journal) et `%LOCALAPPDATA%\PointZero` (cache WebView2).
5. Si aucune autre application ne s'en sert (DS4Windows, DSX…), désinstallez les pilotes, puis redémarrez :

   ```powershell
   winget uninstall --id Nefarius.HidHide --exact
   ```

   ```powershell
   winget uninstall --id ViGEm.ViGEmBus --exact
   ```

## 6. Compiler

Il faut le SDK .NET 10 (`winget install Microsoft.DotNet.SDK.10`).

```powershell
.\build.ps1
```

Le script produit `dist\PointZero.exe`, un exe autonome qui ne demande pas d'installer .NET.

### Publier une nouvelle version

1. Augmentez `<Version>` dans `src\PointZero\PointZero.csproj`, par exemple `1.1.0`.
2. Lancez `.\build.ps1`.
3. Publiez la release avec l'exe, avec un tag `v` + version :

   ```powershell
   gh release create v1.1.0 dist\PointZero.exe --title "Point Zéro 1.1.0" --notes "Ce qui change…"
   ```

Les utilisateurs d'une version plus ancienne voient alors la fenêtre « Nouvelle version disponible », avec les
notes de la release. Les brouillons et les pré-versions sont ignorés.

Pour le développement :

- La variable `POINTZERO_WWWROOT=<chemin de src\PointZero\wwwroot>` sert l'interface depuis le disque, avec les outils de développement (F12).
- `POINTZERO_DEBUG=1` écrit le débit et les sorties dans `%APPDATA%\PointZero\pointzero.log`.
- `tools\Probe` est une petite console de diagnostic : lecture HID, mesure du drift au repos, test de la manette virtuelle.
- L'interface se développe aussi dans un navigateur ordinaire, avec une manette simulée : servir `src\PointZero\wwwroot` en local, voir `js\mock.js`.
- Le protocole hôte ⇄ interface est décrit dans `docs\protocol.md`.

## Limites connues

- En Bluetooth, Windows n'expose pas l'audio de la DualSense : le test du haut-parleur et du micro demande l'USB.
- Le routage vers le haut-parleur interne et les gâchettes adaptatives utilisent des formats documentés par la communauté, pas par Sony.
- Une correction logicielle ne remplace pas un stick usé : si le diagnostic conclut « Trop fort », la seule vraie solution est de remplacer le module (potentiomètre, ou module à effet Hall / TMR).
