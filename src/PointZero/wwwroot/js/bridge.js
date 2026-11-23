// Host ⇄ UI bridge (see docs/protocol.md). Falls back to an in-page mock outside WebView2.

const handlers = new Map();

function dispatch(msg) {
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return; } }
  if (!msg || typeof msg.t !== 'string') return;
  const list = handlers.get(msg.t);
  if (list) for (const h of list) h(msg);
}

const webview = window.chrome?.webview;
let post;

if (webview) {
  webview.addEventListener('message', e => dispatch(e.data));
  post = m => webview.postMessage(m);
} else {
  const { createMock } = await import('./mock.js');
  const mock = createMock(dispatch);
  post = m => mock.receive(m);
}

export const isMock = !webview;

export function send(msg) { post(msg); }

export function on(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
  return () => handlers.get(type).delete(handler);
}
