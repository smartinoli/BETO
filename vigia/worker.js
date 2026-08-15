/* ============================================================
   PUENTE TELEGRAM → VIGÍA  (Cloudflare Worker, plan gratis)

   Telegram avisa a este Worker cuando le escribes al bot; el Worker
   despierta al Vigía en GitHub Actions. Sin cron, sin sesiones: solo
   corre cuando tú mandas un mensaje.

   Variables que hay que configurar en el Worker (Settings → Variables):
     TG_TOKEN     token del bot (el mismo del secreto de GitHub)
     TG_CHAT      tu chat id (solo tú puedes dar órdenes)
     TG_SECRET    una palabra larga que inventes; Telegram la manda de
                  vuelta en cada aviso y así nadie más puede fingir ser él
     GH_TOKEN     token de GitHub con permiso Actions: read and write
     GH_REPO      smartinoli/BETO
   ============================================================ */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Vigía: puente activo', { status: 200 });

    /* solo Telegram, con el secreto acordado */
    if (env.TG_SECRET &&
        request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) {
      return new Response('no', { status: 401 });
    }

    let update = null;
    try { update = await request.json(); } catch { return new Response('ok'); }
    const msg = update.message || update.edited_message;
    const texto = (msg && msg.text || '').trim();
    const chat = msg && msg.chat && String(msg.chat.id);

    /* solo tu chat: si alguien más encuentra el bot, lo ignora */
    if (!texto || chat !== String(env.TG_CHAT)) return new Response('ok');

    const decir = (t) => fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: t, parse_mode: 'HTML' }),
    });

    /* despierta al Vigía con el comando */
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
      await decir('❌ No pude despertar al Vigía (GitHub respondió ' + r.status + ').');
    }
    return new Response('ok');
  },
};
