import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';

const API = 'https://api.ticktick.com/open/v1';

async function tt(token, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : {}; } catch (e) { j = { raw: text }; }
  if (!r.ok) throw new Error((j && j.errorMessage) || ('HTTP ' + r.status) + ' ' + text.slice(0, 160));
  return j;
}

/**
 * GET /api/ticktick
 * Lê os projetos e as tarefas abertas de cada um, normalizadas para o app.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'ticktick');
  if (!token) return Response.json({ connected: false, tasks: [], projects: [] });

  try {
    const projects = await tt(token, 'GET', '/project');
    const projList = [{ id: 'inbox', name: 'Inbox' }, ...(projects || []).map((p) => ({ id: p.id, name: p.name, color: p.color }))];

    const tasks = [];
    for (const p of projList) {
      try {
        const data = await tt(token, 'GET', `/project/${p.id}/data`);
        (data.tasks || []).forEach((tk) => {
          tasks.push({
            id: tk.id,
            projectId: tk.projectId || p.id,
            projectName: p.name,
            title: tk.title,
            notes: tk.content || tk.desc || '',
            date: tk.dueDate ? String(tk.dueDate).slice(0, 10) : null,
            priority: tk.priority || 0, // 0 none,1 low,3 mid,5 high
            status: tk.status === 2 ? 'done' : 'planned',
            tags: tk.tags || [],
          });
        });
      } catch (e) { /* projeto sem acesso, ignora */ }
    }
    return Response.json({ connected: true, projects: projList, tasks });
  } catch (e) {
    return Response.json({ connected: true, projects: [], tasks: [], error: String(e.message || e) });
  }
}

/**
 * POST /api/ticktick
 *  { op:'create', title, notes?, date?, priority?, projectId? }
 *  { op:'complete', id, projectId }
 *  { op:'update', id, projectId, patch:{...} }
 *  { op:'delete', id, projectId }
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'ticktick');
  if (!token) return Response.json({ error: 'TickTick não conectado.' }, { status: 400 });

  const b = await req.json();
  try {
    if (b.op === 'create') {
      const body = { title: b.title };
      if (b.notes) body.content = b.notes;
      if (b.date) body.dueDate = b.date + 'T00:00:00+0000';
      if (b.priority) body.priority = b.priority;
      if (b.tags && b.tags.length) body.tags = b.tags;
      if (b.projectId && b.projectId !== 'inbox') body.projectId = b.projectId;
      const j = await tt(token, 'POST', '/task', body);
      return Response.json({ ok: true, id: j.id, task: j });
    }
    if (b.op === 'complete') {
      await tt(token, 'POST', `/project/${b.projectId || 'inbox'}/task/${b.id}/complete`);
      return Response.json({ ok: true });
    }
    if (b.op === 'update') {
      const body = { id: b.id, projectId: b.projectId, ...b.patch };
      if (body.date) { body.dueDate = body.date + 'T00:00:00+0000'; delete body.date; }
      const j = await tt(token, 'POST', `/task/${b.id}`, body);
      return Response.json({ ok: true, task: j });
    }
    if (b.op === 'delete') {
      await tt(token, 'DELETE', `/project/${b.projectId || 'inbox'}/task/${b.id}`);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'op inválida' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
