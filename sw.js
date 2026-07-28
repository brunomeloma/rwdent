/* RWDent — Service Worker (SÓ notificações push).
 *
 * Importante: este SW NÃO faz cache de nada (não tem handler de 'fetch'), de
 * propósito. Assim ele nunca serve uma versão velha do app.js/app.html — o
 * sistema continua atualizando normalmente pela rede. A única função dele é
 * receber o push (mesmo com o app/aba fechados) e mostrar a notificação.
 */

// Ativa a versão nova na hora, sem esperar as abas antigas fecharem.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// Chega um push do servidor -> mostra a notificação.
// Ícone em PNG (não SVG): o Safari/iOS não sabe desenhar notificação com
// ícone em SVG — a notificação falha em silêncio (chega, mas nunca aparece
// na tela, sem erro nenhum). Achado testando no aparelho real.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'RWDent';
  const options = {
    body: data.body || '',
    icon: data.icon || '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: data.tag || undefined,       // agrupa/atualiza notificação da mesma consulta
    renotify: !!data.tag,
    data: { url: data.url || '/app.html' },
    vibrate: [120, 60, 120]
  };
  event.waitUntil(
    self.registration.showNotification(title, options).catch(() => {
      // Rede de segurança: se algo no ícone/opções falhar num navegador
      // específico, mostra pelo menos o texto — nunca falha 100% em silêncio.
      return self.registration.showNotification(title, { body: options.body });
    })
  );
});

// Toca na notificação -> foca uma aba já aberta do app, ou abre uma nova.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const alvo = (event.notification.data && event.notification.data.url) || '/app.html';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.includes('/app') && 'focus' in w) return w.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(alvo);
  })());
});
