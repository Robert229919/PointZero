// 04 Réglages — virtual pad type, startup, whitelist, profiles, real pad visibility, pad refresh helper.
import { send } from '../bridge.js';
import { S, sub, hideRealOn, setHideReal } from '../state.js';
import { h, setText, setClass, toggle, segmented, button } from '../ui.js';

const block = (n, title, ...kids) => h('div', { class: 'blk' },
  h('div', { class: 'blk-h' }, h('span', { class: 'lbl' }, n), h('h2', { class: 'h2' }, title)), ...kids);
const fileName = p => p.split(/[\\/]/).pop();

export default function settings() {
  const vt = segmented({ options: [{ value: 'x360', label: 'Xbox 360' }, { value: 'ds4', label: 'DualShock 4' }], value: 'x360', label: 'Type de manette virtuelle',
    onChange: v => { S.settings.virtualType = v; send({ t: 'setVirtualType', type: v }); } });
  const vtNote = h('p', { class: 'note' });
  const NOTES = {
    x360: 'Xbox 360 : reconnue par presque tous les jeux PC.',
    ds4: 'DualShock 4 : affiche les boutons PlayStation dans les jeux qui le gèrent.',
  };
  const sw = {};
  const mk = (key, label) => (sw[key] = toggle({ label, onChange: v => { S.settings[key] = v; send({ t: 'setting', key, value: v }); } })).el;

  const verLine = h('span', { class: 'hint' });
  const wl = h('ul', { class: 'list' });
  const profs = h('ul', { class: 'list' });

  // ---- real pad visibility ----
  const hideSw = toggle({ label: 'Cacher la vraie manette aux jeux', checked: true, onChange: v => { setHideReal(v); renderHide(); } });
  const hideHint = h('span', { class: 'hint' });
  hideSw.el.querySelector('.sw-txt').append(hideHint);
  function renderHide() {
    const st = S.status, d = st?.drivers;
    const missing = !!d && (!d.vigem || !d.hidhide), corr = !!st?.correction;
    hideSw.set(!missing && corr && hideRealOn());
    hideSw.btn.disabled = !st || missing || !corr;
    setClass(hideSw.el, 'off', hideSw.btn.disabled);
    setText(hideHint, missing ? 'Indisponible : pilotes manquants.' : !corr ? 'Active la correction pour pouvoir la cacher.' : '');
  }

  // ---- pad refresh helper ----
  const helperBox = h('div', { class: 'helper' });
  let helperKey = '';
  const fill = (...kids) => helperBox.replaceChildren(...kids.filter(Boolean));
  function renderHelper() {
    const hp = S.status?.helper || {};
    const key = `${!!hp.installed}/${!!hp.refreshing}/${hp.blockedBy || ''}/${!!hp.needsReconnect}`;
    if (key === helperKey) return;
    helperKey = key;
    // An app refused the restart (host already toasts it); after that Windows may require a reconnection.
    const RECO = 'reconnecte la manette (câble, ou PS 10 s puis PS) pour que les applications déjà ouvertes voient le changement.';
    const by = hp.blockedBy, reco = !!hp.needsReconnect;
    const blocked = by && reco ? h('p', { class: 'warn-line' }, `${by} a refusé de lâcher la manette. Ferme-le, puis ${RECO}`)
      : reco ? h('p', { class: 'warn-line' }, 'R' + RECO.slice(1))
      : by ? h('p', { class: 'warn-line' }, `${by} garde la manette ouverte : ferme-la, puis « Actualiser maintenant ».`)
      : null;
    if (!hp.installed) {
      fill(blocked,
        h('p', { class: 'note' }, 'Steam ou ton navigateur peuvent garder l’ancienne manette en mémoire. Point Zéro peut la redémarrer une fraction de seconde à chaque changement pour que toutes les applis la redétectent. Une autorisation administrateur est demandée une seule fois.'),
        h('div', { class: 'row-btns' }, button('Activer l’actualisation automatique', () => send({ t: 'helperInstall' }), 'btn-line')));
      return;
    }
    const now = button(hp.refreshing ? 'Actualisation…' : 'Actualiser maintenant', () => send({ t: 'refreshPad' }), 'btn-line');
    now.disabled = !!hp.refreshing || reco;
    fill(
      h('p', { class: 'state-line acc' }, 'Actualisation automatique active'),
      blocked,
      blocked ? null : h('p', { class: 'note' }, 'La manette redémarre une fraction de seconde après chaque changement de visibilité.'),
      h('div', { class: 'row-btns' }, now, reco ? h('span', { class: 'hint' }, 'Inutile tant que la manette n’est pas reconnectée') : null, button('Désactiver', () => send({ t: 'helperRemove' }), 'btn-link dim')));
  }

  const el = h('section', { class: 'screen scr-set', 'aria-label': 'Réglages' },
    h('div', { class: 'set-col' },
      block('01', 'Manette virtuelle', vt.el, vtNote),
      block('02', 'Démarrage',
        mk('autostart', 'Lancer au démarrage de Windows'),
        mk('startMinimized', 'Démarrer réduit dans la zone de notification'),
        mk('closeToTray', 'Fermer = réduire dans la zone de notification')),
      block('05', 'Sécurité',
        hideSw.el,
        h('p', { class: 'note' }, 'Visible = les jeux voient la vraie manette ET la manette virtuelle (double entrée possible). Pratique pour un outil web comme dualshock-tools.'),
        h('p', { class: 'note' }, 'Le masquage est retiré automatiquement à la fermeture de Point Zéro et après un plantage.')),
      block('07', 'Mises à jour',
        mk('checkUpdates', 'Prévenir quand une nouvelle version sort'),
        h('div', { class: 'row-btns' }, button('Vérifier maintenant', () => send({ t: 'checkUpdates' }), 'btn-line'), verLine),
        h('p', { class: 'note' }, 'Seule connexion de Point Zéro : une requête anonyme à la page des versions sur GitHub.'))),
    h('div', { class: 'set-col' },
      block('03', 'Applications autorisées à voir la vraie manette', wl,
        h('div', { class: 'row-btns' }, button('Ajouter une application…', () => send({ t: 'whitelistAdd' }), 'btn-line')),
        h('p', { class: 'note' }, 'Point Zéro lui-même est toujours autorisé.')),
      block('04', 'Profils', profs),
      block('06', 'Actualisation de la manette', helperBox)));

  function renderSettings() {
    const s = S.settings;
    vt.set(s.virtualType); vtNote.textContent = NOTES[s.virtualType] || '';
    verLine.textContent = S.version ? `Version installée : ${S.version}` : '';
    for (const k in sw) sw[k].set(!!s[k]);
    wl.replaceChildren(...(s.whitelist.length ? s.whitelist.map(p => h('li', { class: 'li' },
      h('span', { class: 'li-main' }, h('span', { class: 'li-t' }, fileName(p)), h('span', { class: 'li-sub' }, p)),
      button('Retirer', () => { s.whitelist = s.whitelist.filter(x => x !== p); renderSettings(); send({ t: 'whitelistRemove', path: p }); }, 'btn-link'))) :
      [h('li', { class: 'li li-empty' }, 'Aucune application ajoutée.')]));
    renderHide();
  }
  function renderProfiles() {
    const active = S.settings.activeProfile, one = S.profiles.length <= 1;
    profs.replaceChildren(...S.profiles.map(n => h('li', { class: 'li' + (n === active ? ' cur' : '') },
      h('span', { class: 'li-main' }, h('span', { class: 'li-t' }, n), n === active ? h('span', { class: 'lbl acc' }, 'Actif') : null),
      n === active ? null : button('Charger', () => send({ t: 'profileLoad', name: n }), 'btn-link'),
      one ? null : button('Supprimer', () => send({ t: 'profileDelete', name: n }), 'btn-link dim'))));
  }
  sub('settings', () => { renderSettings(); renderProfiles(); });
  sub('profiles', renderProfiles);
  sub('hideReal', renderHide);
  sub('status', () => {
    const t = S.status?.virtual?.type; if (t && t !== vt.value) { vt.set(t); vtNote.textContent = NOTES[t]; }
    renderHide(); renderHelper();
  });
  renderHelper();

  return { num: '04', title: 'Réglages', el, needsController: false, enter() { renderSettings(); renderProfiles(); renderHelper(); } };
}
