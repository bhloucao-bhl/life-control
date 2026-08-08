import { userFromRequest, validToken } from '../../../lib/oauth';
import { brDateTime } from '../../../lib/tz';

export const runtime = 'nodejs';

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';

function header(payload, name) {
  const hs = (payload && payload.headers) || [];
  const f = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return f ? f.value : '';
}

/** Extrai o corpo em texto do e-mail (percorre as partes). */
function plainBody(payload) {
  if (!payload) return '';
  const dec = (d) => {
    try { return Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
    catch (e) { return ''; }
  };
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return dec(payload.body.data);
  const parts = payload.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body && p.body.data) return dec(p.body.data);
  }
  for (const p of parts) {
    const nested = plainBody(p);
    if (nested) return nested;
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return dec(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function htmlBody(payload) {
  if (!payload) return '';
  const dec = (d) => { try { return Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } };
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) return dec(payload.body.data);
  const parts = payload.parts || [];
  for (const p of parts) { if (p.mimeType === 'text/html' && p.body && p.body.data) return dec(p.body.data); }
  for (const p of parts) { const nested = htmlBody(p); if (nested) return nested; }
  return '';
}

/** GET -> lista de não lidos das últimas 24h, com corpo. */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, messages: [] });

  const h = { Authorization: `Bearer ${token}` };

  // Diagnostico: quais permissoes o token realmente tem hoje
  let grantedScopes = null;
  try {
    const ti = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { cache: 'no-store' });
    if (ti.ok) { const tj = await ti.json(); grantedScopes = tj.scope || null; }
  } catch (e) {}

  try {
    // Busca 1: não lidos recentes (pessoais). Busca 2: label corporativa "(M) Moura Backup" (lidos/arquivados pela regra do Gmail), sem limite de tempo — mantém os últimos 25 independente da hora.
    const q = encodeURIComponent('is:unread newer_than:1d');
    const qWork = encodeURIComponent('label:"(M) Moura Backup"');
    const [r, rWork] = await Promise.all([
      fetch(`${G}/messages?q=${q}&maxResults=25`, { headers: h, cache: 'no-store' }),
      fetch(`${G}/messages?q=${qWork}&maxResults=25`, { headers: h, cache: 'no-store' }),
    ]);
    if (!r.ok) {
      const txt = await r.text();
      let detail = txt.slice(0, 400);
      try {
        const ej = JSON.parse(txt);
        const e = ej.error || {};
        detail = (e.message || '') + (e.status ? ' [' + e.status + ']' : '');
        if (e.errors && e.errors[0] && e.errors[0].reason) detail += ' (' + e.errors[0].reason + ')';
      } catch (x) {}
      throw new Error('HTTP ' + r.status + ' — ' + detail);
    }
    const j = await r.json();
    let jWork = { messages: [] };
    try { if (rWork.ok) jWork = await rWork.json(); } catch (e) {}
    const workIds = new Set((jWork.messages || []).map((m) => m.id));
    // mescla os IDs das duas buscas, sem duplicar
    const ids = [...new Set([...(j.messages || []).map((m) => m.id), ...(jWork.messages || []).map((m) => m.id)])];

    const messages = (await Promise.all(ids.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=full`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        const from = header(m.payload, 'From');
        const html = htmlBody(m.payload);
        const bodyText = plainBody(m.payload) || m.snippet || '';
        const isWork = workIds.has(id) || /^\s*\(m\)/i.test(header(m.payload, 'Subject') || '');
        let sender = from.replace(/<.*>/, '').replace(/"/g, '').trim() || from;
        let email = (from.match(/<(.+)>/) || [null, from])[1];
        if (isWork) {
          // e-mail corporativo encaminhado: tenta extrair o remetente ORIGINAL do corpo (rótulos De/From/Sender/Remetente)
          const re = /^\s*(?:De|From|Sender|Remetente)\s*:\s*(.+)$/im;
          let m1 = bodyText.match(re);
          if (!m1 && html) { const stripped = html.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' '); m1 = stripped.match(re); }
          if (m1) {
            const raw = m1[1].trim();
            const em = (raw.match(/<([^>]+)>/) || [null, null])[1];
            const nm = raw.replace(/<.*>/, '').replace(/"/g, '').trim();
            if (nm) sender = nm;
            if (em) email = em;
          }
        }
        const when = m.internalDate ? Number(m.internalDate) : Date.now();
        // horário LOCAL (Brasil) embutido como offset -03:00 na própria string ISO — assim
        // .slice(0,10)/.slice(11,16), já usados na tela, e o sort por string continuam
        // funcionando, mas mostrando a hora certa em vez da hora UTC do servidor (Vercel).
        const { date: brD, time: brT } = brDateTime(when);
        return {
          id,
          threadId: m.threadId,
          sender,
          email,
          subject: header(m.payload, 'Subject') || '(sem assunto)',
          snippet: m.snippet || '',
          body: (plainBody(m.payload) || m.snippet || '').slice(0, 4000),
          html: (html || '').slice(0, 200000),
          messageId: header(m.payload, 'Message-ID'),
          references: header(m.payload, 'References'),
          date: `${brD}T${brT}:00-03:00`,
          work: isWork,
          link: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        };
      } catch (e) { return null; }
    }))).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));

    return Response.json({ connected: true, messages });
  } catch (e) {
    return Response.json({ connected: true, messages: [], error: String(e.message || e) });
  }
}

/**
 * POST
 *  { id, action: 'read' | 'unread' | 'archive' | 'trash' }
 *  { id, threadId, to, subject, messageId, references, reply: '...' }  -> envia resposta
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ error: 'Google não conectado.' }, { status: 400 });

  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const b = await req.json();

  try {
    if (b.action) {
      const mods = {
        read: { removeLabelIds: ['UNREAD'] },
        unread: { addLabelIds: ['UNREAD'] },
        archive: { removeLabelIds: ['INBOX', 'UNREAD'] },
      };
      if (b.action === 'trash') {
        const r = await fetch(`${G}/messages/${b.id}/trash`, { method: 'POST', headers: h });
        if (!r.ok) throw new Error('trash HTTP ' + r.status);
      } else {
        const body = mods[b.action];
        if (!body) throw new Error('ação inválida');
        const r = await fetch(`${G}/messages/${b.id}/modify`, { method: 'POST', headers: h, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('modify HTTP ' + r.status);
      }
      return Response.json({ ok: true });
    }

    if (b.compose) {
      const to = b.to, subject = b.subject || '(sem assunto)';
      const lines = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
      ];
      const raw = Buffer.from(lines.join('\r\n') + '\r\n\r\n' + b.compose, 'utf8')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const r = await fetch(`${G}/messages/send`, { method: 'POST', headers: h, body: JSON.stringify({ raw }) });
      const j = await r.json();
      if (!r.ok) throw new Error('send: ' + JSON.stringify(j).slice(0, 200));
      return Response.json({ ok: true, id: j.id });
    }

    if (b.compose) {
      const lines = [
        `To: ${b.to}`,
        `Subject: =?UTF-8?B?${Buffer.from(b.subject || '', 'utf8').toString('base64')}?=`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
      ];
      const raw = Buffer.from(lines.join('\r\n') + '\r\n\r\n' + (typeof b.compose === 'string' ? b.compose : (b.body || '')), 'utf8')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const r = await fetch(`${G}/messages/send`, { method: 'POST', headers: h, body: JSON.stringify({ raw }) });
      const j = await r.json();
      if (!r.ok) throw new Error('send: ' + JSON.stringify(j).slice(0, 200));
      return Response.json({ ok: true, id: j.id });
    }

    if (b.reply) {
      const subject = (b.subject || '').startsWith('Re:') ? b.subject : 'Re: ' + (b.subject || '');
      const lines = [
        `To: ${b.to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
      ];
      if (b.messageId) {
        lines.push(`In-Reply-To: ${b.messageId}`);
        lines.push(`References: ${[b.references, b.messageId].filter(Boolean).join(' ')}`);
      }
      const raw = Buffer.from(lines.join('\r\n') + '\r\n\r\n' + b.reply, 'utf8')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const r = await fetch(`${G}/messages/send`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ raw, threadId: b.threadId || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error('send: ' + JSON.stringify(j).slice(0, 200));

      // marca o original como lido
      if (b.id) {
        await fetch(`${G}/messages/${b.id}/modify`, { method: 'POST', headers: h, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });
      }
      return Response.json({ ok: true, id: j.id });
    }

    return Response.json({ error: 'Requisição inválida.' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
