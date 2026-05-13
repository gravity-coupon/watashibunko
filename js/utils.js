// Small shared utilities.

export function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Toggleable debug overlay (triple-tap version label to enable).
let _dbgEl = null;
let _dbgOn = false;

export function initDebug(el) {
  _dbgEl = el;
}

export function isDebugOn() {
  return _dbgOn;
}

export function setDebugEnabled(on) {
  _dbgOn = on;
  if (_dbgEl) _dbgEl.style.display = on ? 'block' : 'none';
}

export function dbg(msg) {
  console.log('[DBG]', msg);
  if (!_dbgOn || !_dbgEl) return;
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  _dbgEl.textContent = t + ' ' + msg + '\n' + _dbgEl.textContent.slice(0, 3000);
}
