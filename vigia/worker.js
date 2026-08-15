/* ============================================================
   PUENTE TELEGRAM → VIGÍA  (Cloudflare Worker, plan gratis)

   Telegram avisa a este Worker cuando le escribes al bot; el Worker
   despierta al Vigía en GitHub Actions. Sin cron, sin sesiones: solo
   corre cuando tú mandas un mensaje.

   Abrir la dirección del Worker en el navegador muestra un diagnóstico
   con las variables que faltan.

   Variables (Worker → Settings → Variables and Secrets):
     TG_TOKEN   token del bot            (Secret)
     GH_TOKEN   token de GitHub          (Secret)
     TG_SECRET  palabra secreta inventada(Secret)
     TG_CHAT    tu chat id               (Text)
     GH_REPO    smartinoli/BETO          (Text)
   ============================================================ */

export default {
  async fetch(request, env) {
    const hay = v => (v && String(v).trim()) ? 'ok' : 'FALTA';

    /* ---- diagnóstico: abrir la dirección en el navegador ---- */
    if (request.method !== 'POST') {
      const estado = {
        puente: 'activo · versión 2',
        TG_TOKEN: hay(env.TG_TOKEN),
        GH_TOKEN: hay(env.GH_TOKEN),
        TG_SECRET: hay(env.TG_SECRET),
        TG_CHAT: env.TG_CHAT ? 'ok (termina en …' + String(env.TG_CHAT).slice(-3) + ')' : 'FALTA',
        GH_REPO: env.GH_REPO || 'FALTA',
      };
      const faltan = Object.entries(estado).filter(([, v]) => String(v).includes('FALTA'));
      estado.resumen = faltan.length
        ? '⚠ Faltan variables: ' + faltan.map(([k]) => k).join(', ')
        : '✓ Todo configurado. Escríbele al bot para probar.';
      return new Response(JSON.stringify(estado, null, 2), {
        status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    /* ---- aviso de Telegram ---- */
    if (env.TG_SECRET &&
        request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) {
      return new Response('no', { status: 401 });
    }

    let update = null;
    try { update = await request.json(); } catch { return new Response('ok'); }
    const msg = update.message || update.edited_message;
    const texto = (msg && msg.text || '').trim();
    const chat = msg && msg.chat && String(msg.chat.id);
    if (!texto || !chat) return new Response('ok');

    /* responde SIEMPRE a quien escribe: si algo está mal, lo dice en el chat
       en vez de quedarse callado (el silencio era imposible de diagnosticar) */
    const decir = (t) => fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: t, parse_mode: 'HTML' }),
    });

    if (!env.TG_CHAT) {
      await decir('⚠ Al puente le falta la variable <b>TG_CHAT</b>.\n\nTu chat id es: <code>'
        + chat + '</code>\n\nPonlo en el Worker (Settings → Variables) y vuelve a Deploy.');
      return new Response('ok');
    }
    if (chat !== String(env.TG_CHAT).trim()) {
      await decir('⛔ Este chat no está autorizado.\n\nTu chat id: <code>' + chat
        + '</code>\nEl configurado en el puente termina en <code>…'
        + String(env.TG_CHAT).trim().slice(-3) + '</code>\n\nSi eres tú, corrige '
        + '<b>TG_CHAT</b> en el Worker y vuelve a Deploy.');
      return new Response('ok');
    }
    if (!env.GH_TOKEN || !env.GH_REPO) {
      await decir('⚠ Al puente le falta <b>' + (!env.GH_TOKEN ? 'GH_TOKEN' : 'GH_REPO')
        + '</b>. Agrégala en el Worker y vuelve a Deploy.');
      return new Response('ok');
    }

    const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'vigia-puente',
      },
      body: JSON.stringify({ event_type: 'comando', client_payload: { texto } }),
    });

    if (r.status === 204) {
      await decir('⏳ Recibido: <b>' + texto.replace(/[<>&]/g, '') + '</b> — trabajando…');
    } else {
      const detalle = r.status === 404
        ? 'Revisa GH_REPO (debe ser smartinoli/BETO) o que el token tenga acceso a ese repositorio.'
        : (r.status === 401 || r.status === 403)
          ? 'El token de GitHub venció o le falta el permiso Contents: Read and write.'
          : '';
      await decir('❌ No pude despertar al Vigía (GitHub respondió ' + r.status + ').\n' + detalle);
    }
    return new Response('ok');
  },
};
