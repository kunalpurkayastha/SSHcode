// Alerts, context menus, popovers and notification banners, drawn as
// macOS-style glass.
import { esc, h, kbd } from './util.js';
import { icons, appIcon } from './icons.js';

let layer;
function overlayRoot() {
  if (!layer) { layer = h('<div class="overlays"></div>'); document.body.appendChild(layer); }
  return layer;
}

/** True while an alert, the palette or Settings owns the keyboard. */
export const modalOpen = () => !!document.querySelector('.scrim, .palette-wrap, .settings-wrap, .ql-wrap');

// --- alerts ------------------------------------------------------------------
/**
 * buttons: [{label, value, kind: 'primary' | 'danger' | 'cancel', default}]
 * (the primary button, or the last non-cancel one, is the default unless one
 * says default: true). input: {type, value, placeholder, select}.
 * check: {label, value} adds a checkbox. Resolves to {value, input, checked}
 * or null when cancelled.
 */
export function dialog({ icon = 'app', title, message = '', detail = '', input = null, check = null, buttons, wide = false }) {
  buttons = buttons || [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: 'OK', value: true, kind: 'primary' }];
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const def = buttons.find(b => b.default) || buttons.find(b => b.kind === 'primary') || [...buttons].reverse().find(b => b.kind !== 'cancel');
    const iconHtml = icon === 'app' ? appIcon : `<span class="sym ${icon}">${icons[icon] || ''}</span>`;
    // Only the default button submits, so Enter always means "default".
    const scrim = h(`<div class="scrim"><form class="dialog glass-pop${wide ? ' wide' : ''}" role="alertdialog" aria-label="${esc(title)}">
      <div class="d-icon">${iconHtml}</div>
      <h2>${esc(title)}</h2>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${detail ? `<pre class="detail">${esc(detail)}</pre>` : ''}
      ${input ? `<input class="field" autocomplete="off" spellcheck="false">` : ''}
      ${check ? `<label class="d-check"><input type="checkbox"${check.value ? ' checked' : ''}><span>${esc(check.label)}</span></label>` : ''}
      <div class="btns${buttons.length > 2 ? ' three' : ''}">${buttons.map((b, i) => `<button type="${b === def ? 'submit' : 'button'}" class="btn ${b.kind || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </form></div>`);
    overlayRoot().appendChild(scrim);
    const form = scrim.querySelector('form');
    const field = scrim.querySelector('input.field');
    const box = scrim.querySelector('.d-check input');
    if (field) {
      field.type = input.type || 'text';
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
    }
    const done = v => {
      scrim.classList.add('out');
      setTimeout(() => scrim.remove(), 140);
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const cancel = () => done(null);
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) cancel(); });
    form.addEventListener('click', e => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const spec = buttons[+b.dataset.i];
      if (spec.kind === 'cancel') { e.preventDefault(); cancel(); }
      else if (b.type !== 'submit') done({ value: spec.value, input: field ? field.value : null, checked: box ? box.checked : null });
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      done({ value: def ? def.value : true, input: field ? field.value : null, checked: box ? box.checked : null });
    });
    requestAnimationFrame(() => {
      if (field) {
        field.focus();
        const s = input.select;
        if (Array.isArray(s)) field.setSelectionRange(s[0], s[1]); else field.select();
      } else {
        const d = scrim.querySelector(`button[data-i="${buttons.indexOf(def)}"]`);
        if (d) d.focus();
      }
    });
  });
}

export async function confirm(title, message, { ok = 'OK', danger = false, icon, detail } = {}) {
  const r = await dialog({
    icon: icon || (danger ? 'warning' : 'app'), title, message, detail,
    buttons: [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: ok, value: true, kind: danger ? 'danger' : 'primary' }],
  });
  return !!(r && r.value);
}

export async function prompt(title, { message = '', value = '', placeholder = '', ok = 'OK', type = 'text', select, icon } = {}) {
  const r = await dialog({
    icon: icon || 'app', title, message, input: { value, placeholder, type, select },
    buttons: [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: ok, value: true, kind: 'primary' }],
  });
  return r ? r.input : null;
}

// --- banners -------------------------------------------------------------------
let toastBox;
export function toast({ title, message = '', kind = 'info', timeout, actions = [] }) {
  if (!toastBox) { toastBox = h('<div class="toasts" aria-live="polite"></div>'); overlayRoot().appendChild(toastBox); }
  const sym = kind === 'error' ? 'warning' : kind === 'ok' ? 'check' : 'info';
  const el = h(`<div class="toast glass-pop ${kind}" role="status">
    <span class="t-icon">${icons[sym]}</span>
    <div class="t-body"><div class="t-title">${esc(title)}</div>${message ? `<div class="t-msg">${esc(message)}</div>` : ''}
    ${actions.length ? `<div class="t-acts">${actions.map((a, i) => `<button class="btn small" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>
    <button class="ib t-close" aria-label="Dismiss">${icons.xmark}</button></div>`);
  toastBox.appendChild(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.querySelector('.t-close').onclick = close;
  el.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { close(); actions[+b.dataset.i].run(); }; });
  const ms = timeout ?? (kind === 'error' ? 9000 : 3500);
  if (ms) setTimeout(close, ms);
  return close;
}

export const toastError = (title, err) => toast({ kind: 'error', title, message: err && err.message ? err.message : String(err || '') });

// --- context menus ---------------------------------------------------------------
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu(); openMenu = null; } }

/**
 * items: [{label, icon, keys, action, disabled, danger, current}], '-' for a
 * separator, {header} for a small section title, or {swatches: [colour…],
 * value, pick(colour)} for a row of colour dots (null = none).
 */
export function contextMenu(x, y, items) {
  closeMenu();
  items = items.filter((it, i, a) => it !== '-' || (i > 0 && a[i - 1] !== '-' && i < a.length - 1));
  const menu = h(`<div class="menu glass-pop" role="menu">${items.map((it, i) => it === '-' ? '<div class="sep"></div>' :
    it.header ? `<div class="mh">${esc(it.header)}</div>` :
    it.swatches ? `<div class="m-sw">${it.swatches.map(c => `<button class="sw${c === it.value ? ' on' : ''}${c ? '' : ' none'}" data-sw="${i}:${c || ''}" style="${c ? `--c:var(--${c})` : ''}" title="${esc(c ? c[0].toUpperCase() + c.slice(1) : 'None')}"></button>`).join('')}</div>` :
    `<div class="mi${it.disabled ? ' dis' : ''}${it.danger ? ' danger' : ''}${it.current ? ' cur' : ''}" role="menuitem" data-i="${i}">
      <span class="mi-ic">${it.icon ? icons[it.icon] : ''}</span><span class="mi-l">${esc(it.label)}</span>${it.keys ? `<span class="mi-k">${esc(kbd(it.keys))}</span>` : ''}</div>`).join('')}</div>`);
  overlayRoot().appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  let hot = -1;
  const rows = [...menu.querySelectorAll('.mi:not(.dis)')];
  const setHot = i => { rows.forEach(r => r.classList.remove('hot')); hot = i; if (rows[i]) rows[i].classList.add('hot'); };
  const run = el => { const it = items[+el.dataset.i]; closeMenu(); if (it && it.action) it.action(); };
  const openedAt = performance.now();
  menu.addEventListener('mousemove', e => { const el = e.target.closest('.mi:not(.dis)'); setHot(rows.indexOf(el)); });
  menu.addEventListener('mouseleave', () => setHot(-1));
  menu.addEventListener('mouseup', e => {
    // The release of the right-click that opened the menu may land on an item
    // (menus near a screen edge are moved under the pointer): not a choice.
    if (e.button === 2 && performance.now() - openedAt < 350) return;
    const sw = e.target.closest('[data-sw]');
    if (sw) {
      const [i, c] = sw.dataset.sw.split(':');
      closeMenu();
      items[+i].pick(c || null);
      return;
    }
    const el = e.target.closest('.mi:not(.dis)');
    if (el) run(el);
  });
  menu.addEventListener('contextmenu', e => e.preventDefault());
  const onKey = e => {
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown') setHot((hot + 1) % rows.length);
    else if (e.key === 'ArrowUp') setHot(hot <= 0 ? rows.length - 1 : hot - 1);
    else if (e.key === 'Enter' && rows[hot]) run(rows[hot]);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  const onDown = e => { if (!menu.contains(e.target)) closeMenu(); };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  });
  openMenu = () => {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  };
}

// --- popovers ---------------------------------------------------------------------
let openPop = null;
export function closePopover() { if (openPop) { openPop(); openPop = null; } }

/**
 * Show `el` in a popover under (or above) `anchor` (an element or a rect);
 * closes on Escape, an outside click, or the returned function.
 */
export function popover(anchor, el, { align = 'end', onClose } = {}) {
  closePopover();
  closeMenu();
  const pop = h('<div class="popover glass-pop" role="dialog"></div>');
  pop.appendChild(el);
  overlayRoot().appendChild(pop);
  const place = () => {
    const a = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const r = pop.getBoundingClientRect();
    let left = align === 'end' ? a.right - r.width : a.left;
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
    let top = a.bottom + 8;
    if (top + r.height > innerHeight - 8) top = Math.max(8, a.top - r.height - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  };
  place();
  const onKey = e => { if (e.key === 'Escape' && !modalOpen()) { e.stopPropagation(); closePopover(); } };
  const onDown = e => {
    if (pop.contains(e.target) || (anchor instanceof Element && anchor.contains(e.target))) return;
    if (e.target.closest && e.target.closest('.overlays .scrim, .overlays .menu')) return;
    closePopover();
  };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  window.addEventListener('resize', closePopover);
  openPop = () => {
    pop.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', closePopover);
    if (onClose) onClose();
  };
  return { el: pop, place, close: () => { if (openPop && pop.isConnected) closePopover(); } };
}

export const spinner = (size = 16) => `<span class="spin" style="width:${size}px;height:${size}px" aria-label="Loading">${'<i></i>'.repeat(8)}</span>`;
