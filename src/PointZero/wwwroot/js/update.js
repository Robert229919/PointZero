// New-release popup: shown when the host finds a newer GitHub release ({t:"update"}).
import { on, send } from './bridge.js';
import { h, button } from './ui.js';

let dlg = null, shownFor = '';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function close() {
  if (!dlg) return;
  dlg.classList.remove('in');
  const d = dlg; dlg = null;
  setTimeout(() => { d.close(); d.remove(); }, 200);
}

function show(m) {
  if (dlg && shownFor === m.version) return;
  if (dlg) { dlg.close(); dlg.remove(); dlg = null; }
  shownFor = m.version;

  const date = fmtDate(m.publishedAt);
  const notes = (m.notes || '').trim();
  dlg = h('dialog', { class: 'upd', 'aria-labelledby': 'upd-v' },
    h('div', { class: 'upd-top' },
      h('span', { class: 'lbl acc' }, 'Nouvelle version disponible'),
      h('span', { class: 'lbl' }, date)),
    h('div', { class: 'upd-v', id: 'upd-v' }, m.version),
    h('p', { class: 'upd-cur' }, `Tu utilises la version ${m.current}.`,
      m.name && m.name !== m.version && m.name !== 'v' + m.version ? h('span', {}, ` « ${m.name} »`) : null),
    notes ? h('pre', { class: 'upd-notes' }, notes) : h('p', { class: 'note' }, 'Les nouveautés sont décrites sur la page de la version.'),
    h('div', { class: 'upd-btns' },
      button('Voir et télécharger', () => { send({ t: 'openUrl', url: m.url }); close(); }, 'btn-acc'),
      button('Plus tard', close, 'btn-line'),
      button('Ignorer cette version', () => { send({ t: 'skipVersion', version: m.version }); close(); }, 'btn-link dim')));
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });   // Esc
  document.body.append(dlg);
  dlg.showModal();
  requestAnimationFrame(() => dlg?.classList.add('in'));
}

on('update', show);
