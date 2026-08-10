'use client';
import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Share } from '@capacitor/share';
import { Camera as CapCamera, CameraResultType, CameraSource } from '@capacitor/camera';
import { StatusBar, Style as StatusBarStyle } from '@capacitor/status-bar';
import { Network } from '@capacitor/network';
import { App as CapApp } from '@capacitor/app';
import { BiometricAuth, BiometryType } from '@aparajita/capacitor-biometric-auth';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';

/* ============================================================
   Recursos nativos (iOS): tudo aqui é seguro de chamar mesmo
   rodando no navegador comum — no-op fora do app nativo.
   ============================================================ */
const isNative = () => typeof window !== 'undefined' && Capacitor.isNativePlatform();
const hapticSuccess = () => { if (isNative()) Haptics.notification({ type: NotificationType.Success }).catch(() => {}); };
const hapticWarning = () => { if (isNative()) Haptics.notification({ type: NotificationType.Warning }).catch(() => {}); };
async function nativeShare(title, text) {
  if (!isNative()) return false;
  try { await Share.share({ title, text }); return true; } catch (e) { return false; }
}

/* ============================================================
   Ponte pros widgets de iOS: espelha a sessão do Supabase pro App
   Group (via SharedAuthPlugin nativo), pra o WidgetKit conseguir
   se autenticar sozinho — ele roda num processo separado, sem
   acesso ao localStorage do WebView. Ver ios/App/LifeControlWidgets.
   ============================================================ */
const SharedAuth = registerPlugin('SharedAuth');
async function syncNativeSession(session) {
  if (!isNative()) return;
  try {
    if (session && session.access_token && session.refresh_token) {
      await SharedAuth.saveSession({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: session.expires_at,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      });
    } else {
      await SharedAuth.clearSession();
    }
  } catch (e) {
    // guarda pra App() mostrar um toast — sem isso, uma falha aqui é 100% invisível
    // (esta função roda antes de qualquer UI existir, em Page()).
    window.__lccNativeSyncError = (e && e.message) || String(e);
  }
}

/* ============================================================
   Supabase (cliente)
   ============================================================ */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

/* ============================================================
   Cache local (IndexedDB): espelha o "kv" do Supabase no navegador,
   pra leitura funcionar offline e escritas feitas sem rede entrarem
   numa fila ("outbox") e serem sincronizadas quando a conexão voltar.
   ============================================================ */
const IDB_NAME = 'lcc_offline_v1', IDB_VERSION = 1;
function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('sem indexeddb')); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(store, key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, 'readonly').objectStore(store).get(key);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbSet(store, entry) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(store, key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbAll(store) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
    rq.onsuccess = () => resolve(rq.result || []);
    rq.onerror = () => reject(rq.error);
  });
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/* ============================================================
   Armazenamento: window.storage apontando para o Supabase, com
   IndexedDB como camada offline (mantem a interface que o app ja usa)
   ============================================================ */
const kvCache = new Map();
async function currentUid() {
  // getSession() lê a sessão persistida localmente (sem chamada de rede
  // quando ainda válida) — permite saber quem é o usuário mesmo offline.
  const { data } = await supabase.auth.getSession();
  return data && data.session && data.session.user ? data.session.user.id : null;
}
async function flushOutbox() {
  if (typeof window === 'undefined' || !navigator.onLine) return;
  const user_id = await currentUid(); if (!user_id) return;
  let pending; try { pending = await idbAll('outbox'); } catch (e) { return; }
  for (const entry of pending) {
    try {
      const { error } = await withTimeout(supabase.from('kv').upsert({ user_id, key: entry.key, value: entry.value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }), 8000);
      if (error) throw error;
      await idbDelete('outbox', entry.key);
    } catch (e) { break; } // ainda sem rede (ou falhando) — tenta de novo na próxima
  }
  try { window.__lccOutboxPending = (await idbAll('outbox')).length; } catch (e) {}
}
function installStorage() {
  if (typeof window === 'undefined') return;
  window.storage = {
    async get(key) {
      if (kvCache.has(key)) return { key, value: kvCache.get(key) };
      const user_id = await currentUid(); if (!user_id) return null;
      if (navigator.onLine) {
        try {
          const { data, error } = await withTimeout(supabase.from('kv').select('value').eq('user_id', user_id).eq('key', key).maybeSingle(), 6000);
          if (!error && data) {
            kvCache.set(key, data.value);
            idbSet('kv', { key, value: data.value }).catch(() => {});
            return { key, value: data.value };
          }
        } catch (e) { /* sem rede/erro — cai pro cache local abaixo */ }
      }
      try {
        const local = await idbGet('kv', key);
        if (local) { kvCache.set(key, local.value); return { key, value: local.value }; }
      } catch (e) {}
      return null;
    },
    async set(key, value) {
      const user_id = await currentUid(); if (!user_id) return null;
      kvCache.set(key, value);
      idbSet('kv', { key, value }).catch(() => {}); // espelha local sempre, mesmo com rede
      try {
        const { error } = await withTimeout(supabase.from('kv').upsert({ user_id, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }), 6000);
        if (error) throw error;
        idbDelete('outbox', key).catch(() => {});
        window.__lccSaveError = null;
        window.__lccOffline = false;
        return { key, value };
      } catch (e) {
        // sem rede: não é um erro de verdade — entra na fila e sincroniza sozinho depois
        idbSet('outbox', { key, value, ts: Date.now() }).catch(() => {});
        window.__lccSaveError = null;
        window.__lccOffline = true;
        return { key, value, queued: true };
      }
    },
    async delete(key) {
      const user_id = await currentUid(); if (!user_id) return null;
      kvCache.delete(key);
      idbDelete('kv', key).catch(() => {});
      try { await supabase.from('kv').delete().eq('user_id', user_id).eq('key', key); } catch (e) {}
      return { key, deleted: true };
    },
    async list(prefix = '') {
      const user_id = await currentUid(); if (!user_id) return { keys: [], prefix };
      try {
        const { data, error } = await supabase.from('kv').select('key').eq('user_id', user_id).like('key', prefix + '%');
        if (!error && data) return { keys: data.map((r) => r.key), prefix };
      } catch (e) {}
      return { keys: [], prefix };
    },
  };
  window.addEventListener('online', () => { flushOutbox(); });
  flushOutbox();
}
async function importExportedJson(text) {
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(items)) throw new Error('JSON sem a lista "items".');
  await window.storage.set('lcc_items_v1', JSON.stringify(items));
  if (parsed.settings) await window.storage.set('lcc_settings_v1', JSON.stringify(parsed.settings));
  return items.length;
}

async function authFetch(path, opts = {}) {
  let { data: sess } = await supabase.auth.getSession();
  let token = sess && sess.session ? sess.session.access_token : '';
  // se nao ha token, tenta renovar a sessao uma vez (evita "sem sessão" por token expirado)
  if (!token) {
    try { const r = await supabase.auth.refreshSession(); if (r && r.data && r.data.session) token = r.data.session.access_token; } catch (e) {}
  }
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  // se deu 401, tenta renovar e repetir uma vez
  if (res.status === 401) {
    try {
      const r = await supabase.auth.refreshSession();
      const t2 = r && r.data && r.data.session ? r.data.session.access_token : '';
      if (t2 && t2 !== token) return fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t2}`, ...(opts.headers || {}) } });
    } catch (e) {}
  }
  return res;
}

// Nome pra saudação antes do usuário preencher "Como se chama" nos Ajustes:
// tira a parte antes do @ do e-mail de login e capitaliza cada palavra
// (joao.silva@x.com -> "Joao Silva"). Sem e-mail, devolve null.
function nameFromEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const local = email.split('@')[0];
  if (!local) return null;
  return local.split(/[._+-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/* ============================================================
   Varredura de e-mails "(Z)" da casa
   ============================================================ */
function houseItemFromClassification(x) {
  const c = x.classification || {};
  const isEvent = c.kind === 'event';
  return {
    type: isEvent ? 'event' : 'task',
    domain: isEvent ? 'personal' : 'home',
    title: c.title || x.zText,
    notes: c.notes || '',
    date: isEvent ? (c.date || null) : null,
    time: isEvent ? (c.time || null) : null,
    meta: { fromEmail: true, houseEmail: true, gmailId: x.id, gmailLink: x.link, why: c.why || '' },
  };
}
async function markHouseEmailProcessed(x) {
  try { await authFetch('/api/house-scan', { method: 'POST', body: JSON.stringify({ messageId: x.id }) }); } catch (e) {}
}
function personEmailOf(p) {
  return (p.meta && ((p.meta.emails && p.meta.emails[0]) || p.meta.email)) || null;
}
// cria (ou soma convidados a) um convite de verdade na Google Agenda — o Google manda o e-mail de convite
async function sendCalendarInvite({ title, date, time, durationMin, notes, attendees, googleEventId }) {
  if (!attendees || !attendees.length) return { ok: false, error: 'Nenhuma pessoa com e-mail cadastrado.' };
  try {
    const r = await authFetch('/api/calendar-invite', { method: 'POST', body: JSON.stringify({ title, date, time, durationMin, notes, attendees, googleEventId }) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
// dispara convites automaticamente pra qualquer evento/compromisso novo ou editado que tenha
// convidados pendentes (meta.inviteePersonIds) ainda não convidados (meta.invitedPersonIds)
async function maybeSendInvites(item, people, updateItem, lang) {
  if (!item || (item.type !== 'event' && item.type !== 'appointment')) return;
  const desired = (item.meta && item.meta.inviteePersonIds) || [];
  const already = (item.meta && item.meta.invitedPersonIds) || [];
  const newIds = desired.filter((id) => !already.includes(id));
  if (!newIds.length) return;
  const newPeople = newIds.map((id) => people.find((p) => p.id === id)).filter(Boolean);
  const attendees = newPeople.map((p) => ({ email: personEmailOf(p), name: p.title })).filter((a) => a.email);
  if (!attendees.length) return;
  const res = await sendCalendarInvite({ title: item.title, date: item.date, time: item.time, notes: item.notes, attendees, googleEventId: item.meta.googleEventId });
  if (!res.ok) return;
  const invitedNow = [...already, ...newPeople.filter((p) => attendees.some((a) => a.email === personEmailOf(p))).map((p) => p.id)];
  const invitedPeople = [...((item.meta && item.meta.invitedPeople) || []), ...newPeople.map((p) => ({ id: p.id, name: p.title, photo: p.meta && p.meta.photo }))];
  updateItem(item.id, { meta: { ...item.meta, invitedPersonIds: invitedNow, invitedPeople, googleEventId: res.eventId || item.meta.googleEventId, googleEventLink: res.link || item.meta.googleEventLink } });
}
// rotina de verificação: junta duplicatas de itens vindos de e-mail "(Z)" que já foram
// persistidas (ex.: de antes da trava de concorrência existir) — mantém 1 por e-mail de origem
function dedupeHouseItems(items, delItem) {
  const byGmailId = new Map();
  const dupes = [];
  (items || []).filter((i) => i.meta && i.meta.houseEmail && i.meta.gmailId).forEach((i) => {
    const key = i.meta.gmailId;
    const kept = byGmailId.get(key);
    if (!kept) { byGmailId.set(key, i); return; }
    // entre duplicatas do mesmo e-mail, mantém a já concluída (se houver) ou a mais antiga
    const keepCur = (kept.status === 'done' ? 1 : 0) - (i.status === 'done' ? 1 : 0) || (kept.createdAt || 0) - (i.createdAt || 0);
    if (keepCur <= 0) dupes.push(i); else { dupes.push(kept); byGmailId.set(key, i); }
  });
  dupes.forEach((i) => delItem(i.id));
  return dupes.length;
}
function normTitle(s) { return String(s || '').trim().toLowerCase(); }
async function markTravelEmailProcessed(messageId) {
  if (!messageId) return;
  try { await authFetch('/api/inbox-scan', { method: 'POST', body: JSON.stringify({ messageId }) }); } catch (e) {}
}
// chave de duplicata pra voos/viagens vindos de e-mail: mesmo tipo+título+data+hora, ou mesmo
// nº de voo na mesma data quando disponível (mais confiável que o título, que a Claude pode variar)
function travelDupeKey(i) {
  const fn = i.meta && i.meta.flightNumber;
  if (fn && i.date) return 'fn:' + normTitle(fn) + ':' + i.date;
  return 'ti:' + i.type + ':' + normTitle(i.title) + ':' + (i.date || '') + ':' + (i.time || '');
}
// rotina de verificação: junta voos/viagens duplicados que vieram de e-mail (aceitos mais de uma vez)
function dedupeTravelItems(items, delItem) {
  const byKey = new Map();
  const dupes = [];
  (items || []).filter((i) => (i.type === 'flight' || i.type === 'trip') && i.meta && i.meta.fromEmail).forEach((i) => {
    const key = travelDupeKey(i);
    const kept = byKey.get(key);
    if (!kept) { byKey.set(key, i); return; }
    const keepCur = (kept.createdAt || 0) - (i.createdAt || 0);
    if (keepCur <= 0) dupes.push(i); else { dupes.push(kept); byKey.set(key, i); }
  });
  dupes.forEach((i) => delItem(i.id));
  return dupes.length;
}

/* ============================================================
   Varredura de e-mails "(Trab)" — lembretes pessoais/de trabalho
   ============================================================ */
function workItemFromClassification(x) {
  const c = x.classification || {};
  const isEvent = c.kind === 'event';
  return {
    type: isEvent ? 'event' : 'task',
    domain: 'personal', // provisório — sempre precisa de decisão (trabalho ou pessoal)
    title: c.title || x.trabText,
    notes: c.notes || '',
    date: isEvent ? (c.date || null) : null,
    time: isEvent ? (c.time || null) : null,
    meta: { fromEmail: true, trabEmail: true, needsDomainDecision: true, gmailId: x.id, gmailLink: x.link, why: c.why || '' },
  };
}
async function markWorkEmailProcessed(x) {
  try { await authFetch('/api/work-scan', { method: 'POST', body: JSON.stringify({ messageId: x.id }) }); } catch (e) {}
}
function isWorkDuplicate(x, items) {
  const wantTitle = normTitle((x.classification && x.classification.title) || x.trabText);
  return (items || []).some((i) => i.meta && i.meta.trabEmail && (i.meta.gmailId === x.id || normTitle(i.title) === wantTitle));
}
let workScanInFlight = false;
async function scanWorkEmails({ addItems, flash, t, lang, items }) {
  if (workScanInFlight) return { added: 0 };
  workScanInFlight = true;
  try {
    const r = await authFetch('/api/work-scan');
    const j = await r.json();
    if (!j.connected) { flash(t('gmailNotConnected')); return { added: 0 }; }
    if (j.error) { flash(j.error); return { added: 0 }; }
    const results = j.results || [];
    const dupes = results.filter((x) => isWorkDuplicate(x, items));
    const fresh = results.filter((x) => !dupes.includes(x));
    const toAdd = fresh.map(workItemFromClassification);
    if (toAdd.length) addItems(toAdd);
    // marca todos (inclusive duplicados) como processados, senão o duplicado reaparece na próxima varredura
    await Promise.all(results.map(markWorkEmailProcessed));
    if (toAdd.length) flash(lang === 'pt' ? `${toAdd.length} lembrete(s) "(Trab)" adicionados — decida trabalho ou pessoal.` : `${toAdd.length} "(Trab)" reminder(s) added — decide work or personal.`);
    return { added: toAdd.length };
  } catch (e) {
    flash(String((e && e.message) || e));
    return { added: 0 };
  } finally {
    workScanInFlight = false;
  }
}

// dedupe: um e-mail já virou item (por gmailId) ou já existe item com o mesmo título vindo de e-mail da casa
function isHouseDuplicate(x, items) {
  const wantTitle = normTitle((x.classification && x.classification.title) || x.zText);
  return (items || []).some((i) => i.meta && i.meta.houseEmail && (i.meta.gmailId === x.id || normTitle(i.title) === wantTitle));
}
// trava global: evita que duas varreduras (ex.: Casa abrindo + botão da Hoje) rodem ao mesmo tempo
// e processem o mesmo e-mail duas vezes antes da label ser aplicada no Gmail
let houseScanInFlight = false;
async function scanHouseEmails({ addItems, flash, t, lang, items }) {
  if (houseScanInFlight) return { added: 0, pending: [] };
  houseScanInFlight = true;
  try {
    const r = await authFetch('/api/house-scan');
    const j = await r.json();
    if (!j.connected) { flash(t('gmailNotConnected')); return { added: 0, pending: [] }; }
    if (j.error) { flash(j.error); return { added: 0, pending: [] }; }
    const results = j.results || [];
    const confirmed = results.filter((x) => x.classification && x.classification.kind !== 'ambiguous' && x.classification.confidence >= 0.6);
    const pending = results.filter((x) => !confirmed.includes(x));
    const dupes = confirmed.filter((x) => isHouseDuplicate(x, items));
    const fresh = confirmed.filter((x) => !dupes.includes(x));
    const toAdd = fresh.map(houseItemFromClassification);
    if (toAdd.length) addItems(toAdd);
    // marca TODOS os confirmados (inclusive duplicados) como processados, senão o duplicado fica sem label e reaparece na próxima varredura
    await Promise.all(confirmed.map(markHouseEmailProcessed));
    if (toAdd.length) {
      const nt = toAdd.filter((i) => i.type === 'task').length, ne = toAdd.filter((i) => i.type === 'event').length;
      const parts = [];
      if (nt) parts.push(nt + ' ' + (lang === 'pt' ? (nt > 1 ? 'tarefas' : 'tarefa') : (nt > 1 ? 'tasks' : 'task')));
      if (ne) parts.push(ne + ' ' + (lang === 'pt' ? (ne > 1 ? 'compromissos' : 'compromisso') : (ne > 1 ? 'events' : 'event')));
      flash((lang === 'pt' ? 'Casa: ' : 'House: ') + parts.join(lang === 'pt' ? ' e ' : ' and ') + (lang === 'pt' ? ' adicionados.' : ' added.'));
    } else if (!pending.length) {
      flash(t('noHouseEmails'));
    }
    return { added: toAdd.length, pending };
  } catch (e) {
    flash(String((e && e.message) || e));
    return { added: 0, pending: [] };
  } finally {
    houseScanInFlight = false;
  }
}

/* ============================================================
   Login (e-mail + senha)
   ============================================================ */

const LC = { bg: '#0A0E17', surface: '#131B2A', border: 'rgba(255,255,255,0.08)', text: '#FFFFFF', text3: '#94A3B8', accent: '#2563EB' };

function Login() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [mode, setMode] = useState('in'); // 'in' = entrar | 'up' = criar
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const go = async () => {
    if (!email.trim() || pass.length < 6) { setErr('Informe e-mail e senha (mínimo 6 caracteres).'); return; }
    setBusy(true); setErr(''); setMsg('');
    const creds = { email: email.trim(), password: pass };
    const { data, error } = mode === 'up'
      ? await supabase.auth.signUp(creds)
      : await supabase.auth.signInWithPassword(creds);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    if (mode === 'up' && data && data.user && !data.session) {
      setMsg('Conta criada. Confirme pelo e-mail e depois entre com sua senha.');
      setMode('in');
    }
    // Com sessão criada, o listener em Page() troca de tela sozinho.
  };

  const inputStyle = { width: '100%', background: '#101017', border: `1px solid ${LC.border}`, borderRadius: 10, color: LC.text, padding: '12px 14px', fontSize: 16, outline: 'none', boxSizing: 'border-box', marginBottom: 10 };

  return (
    <div style={{ background: LC.bg, color: LC.text, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: LC.accent }} />
          <span style={{ fontSize: 17, fontWeight: 700 }}>Life in Control</span>
        </div>
        <p style={{ color: LC.text3, fontSize: 13.5, lineHeight: 1.5, marginBottom: 22 }}>
          {mode === 'up' ? 'Crie sua conta com e-mail e senha.' : 'Entre com seu e-mail e senha.'}
        </p>

        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
          autoComplete="username" placeholder="seu@email.com" style={inputStyle} />
        <input value={pass} onChange={(e) => setPass(e.target.value)} type="password"
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'} placeholder="sua senha"
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }} style={inputStyle} />

        <button onClick={go} disabled={busy}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: 'none', background: LC.accent, color: '#FFFFFF', fontWeight: 600, fontSize: 15, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Aguarde…' : mode === 'up' ? 'Criar conta' : 'Entrar'}
        </button>

        <button onClick={() => { setMode(mode === 'up' ? 'in' : 'up'); setErr(''); setMsg(''); }}
          style={{ width: '100%', marginTop: 10, padding: '10px', borderRadius: 12, background: 'transparent', border: `1px solid ${LC.border}`, color: LC.text3, fontSize: 13, cursor: 'pointer' }}>
          {mode === 'up' ? 'Já tenho conta — entrar' : 'Primeira vez — criar conta'}
        </button>

        {err && <div style={{ color: '#EF4444', fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>{err}</div>}
        {msg && <div style={{ color: LC.accent, fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>{msg}</div>}
      </div>
    </div>
  );
}

/* ============================================================
   App
   ============================================================ */
import {
  Sun, Calendar as CalIcon, LayoutGrid, Sparkles, Plus, Settings as Cog,
  Check, X, Trash2, ChevronRight, ChevronLeft, Clock, AlertTriangle, Download,
  Globe, Send, Loader2, Heart, Home, Wallet, Users, FileText, Car, Plane,
  ListTodo, Newspaper, Utensils, Pill, Stethoscope, ShoppingCart, CircleCheck,
  Circle, Paperclip, Ticket, ArrowRight, Star, UserRound, Activity, Thermometer,
  Wrench, CreditCard, Phone, Mail, MessageSquare, MessageCircle, Power, Snowflake,
  Wind, Lightbulb, Video, TrendingUp, Landmark, Scale, Ruler, Syringe, Gift,
  GraduationCap, Copy, RefreshCw, Filter, Camera, Cloud, CloudRain, CloudSun,
  MapPin, Building2, Pencil, Tv, Radio, Waves, Wifi, WifiOff, Droplet, Lock, Eye, EyeOff, CalendarDays, Search, CheckCheck, Moon, Briefcase, Image as ImageIcon, Link as LinkIcon, Upload, Package, Truck, Mic, HeartPulse, Bell, Dumbbell, Flame, Sparkle, GripVertical,
  Coffee, Sandwich, Soup, Cookie, Share2, Fingerprint, Footprints
} from 'lucide-react';

/* ---------------- palette (BHL Core — Deep Space) ---------------- */
// accent = Primary Accent (Electric Blue); sky = Solar Highlight, reserved for
// the "work" domain so corporate items read distinctly from every other category;
// blue = Secondary Accent (Cyan/Starlight), used for the house/gmail/docs categories.
const THEMES = {
  dark: {
    bg: '#0A0E17', bg2: '#0F1522', surface: '#131B2A', surface2: '#1B2536',
    border: 'rgba(255,255,255,0.08)', borderSoft: 'rgba(255,255,255,0.05)',
    text: '#FFFFFF', text2: '#C7D2E0', text3: '#94A3B8',
    accent: '#2563EB', accentSoft: 'rgba(37,99,235,0.16)',
    rose: '#EF4444', green: '#10B981', blue: '#38BDF8', violet: '#A78BFA',
    teal: '#14B8A6', sky: '#F59E0B',
  },
  light: {
    bg: '#F8FAFC', bg2: '#FFFFFF', surface: '#FFFFFF', surface2: '#F1F5F9',
    border: 'rgba(15,23,42,0.10)', borderSoft: 'rgba(15,23,42,0.06)',
    text: '#0F172A', text2: '#475569', text3: '#64748B',
    accent: '#2563EB', accentSoft: 'rgba(37,99,235,0.12)',
    rose: '#DC2626', green: '#059669', blue: '#0284C7', violet: '#7C3AED',
    teal: '#0D9488', sky: '#B45309',
  },
};
let _theme = 'dark';
if (typeof window !== 'undefined') {
  try { _theme = window.localStorage.getItem('lcc_theme') || 'dark'; } catch (e) {}
}
const C = new Proxy({}, { get: (_, k) => (THEMES[_theme] || THEMES.dark)[k] });
function setTheme(name) {
  _theme = name === 'light' ? 'light' : 'dark';
  try { if (typeof window !== 'undefined') { window.localStorage.setItem('lcc_theme', _theme); document.body.style.background = THEMES[_theme].bg; document.documentElement.style.background = THEMES[_theme].bg; } } catch (e) {}
}
if (typeof window !== 'undefined') { try { document.body.style.background = THEMES[_theme].bg; } catch (e) {} }

/* ---------------- i18n ---------------- */
const L = (pt, en) => ({ pt, en });
const S = {
  goodMorning: L('Bom dia', 'Good morning'), goodAfternoon: L('Boa tarde', 'Good afternoon'), goodEvening: L('Boa noite', 'Good evening'),
  capturePh: L('O que precisa entrar? Uma tarefa, gasto, evento, ideia…', 'What needs to go in? A task, expense, event, idea…'),
  interpret: L('Interpretar', 'Interpret'), thinking: L('Pensando…', 'Thinking…'), save: L('Salvar', 'Save'), confirm: L('Confirmar', 'Confirm'),
  toInbox: L('Guardar', 'Save'), discard: L('Descartar', 'Discard'), cancel: L('Cancelar', 'Cancel'),
  delete: L('Excluir', 'Delete'), edit: L('Editar', 'Edit'), resolve: L('Buscar', 'Search'),
  attention: L('Precisa da sua atenção', 'Needs your attention'), todayPlan: L('O que vai rolar hoje', "Today's plan"),
  longTerm: L('Longo prazo', 'Long term'), nothingToday: L('Nenhum compromisso à frente hoje.', 'Nothing left today.'),
  noAttention: L('Nada urgente agora.', 'Nothing urgent right now.'), noLongTerm: L('Nada marcado à frente.', 'Nothing ahead yet.'),
  home: L('Hoje', 'Today'), messages: L('Mensagens', 'Messages'), calendar: L('Calendário', 'Calendar'),
  dashboard: L('Painel de Controle', 'Dashboard'), dashShort: L('Painel', 'Dashboard'), claude: L('Claude', 'Claude'),
  work: L('Trabalho', 'Work'), purchases: L('Compras', 'Purchases'), tasks: L('Tarefas', 'Tasks'), health: L('Saúde', 'Health'), house: L('Casa', 'Home'), finance: L('Finanças', 'Finance'), kids: L('Filhos', 'Kids'),
  people: L('Contatos', 'Contacts'), docs: L('Documentos', 'Documents'), cars: L('Carros', 'Cars'), travel: L('Viagens', 'Travel'),
  readiness: L('Prontidão', 'Readiness'), sleepScore: L('Sono', 'Sleep'), steps: L('Passos', 'Steps'),
  connectOura: L('Conecte o Oura em Ajustes, ou toque para registrar.', 'Connect Oura in Settings, or tap to log.'),
  weather: L('Clima', 'Weather'), weatherSoon: L('Tempo real (open-meteo) na versão no celular.', 'Live weather in the phone version.'),
  news: L('Notícias', 'News'), newsSoon: L('5 principais dos seus temas — entra com o deploy.', 'Top 5 — arrives at deploy.'),
  seeAll: L('Ver todas', 'See all'), newsExample: L('Exemplos. No deploy vira feed real dos seus temas e a manchete abre no navegador.', 'Examples. At deploy this becomes a real feed and headlines open in the browser.'),
  openBrowser: L('Abrir no navegador', 'Open in browser'), fxHint: L('Cotação comercial, atualizada automaticamente.', 'Market rate, updated automatically.'),
  reloadSamples: L('Recarregar dados de exemplo', 'Reload sample data'), reloadConfirm: L('Substituir tudo pelos dados de exemplo?', 'Replace everything with sample data?'),
  weatherLive: L('Tempo real', 'Live'), feels: L('Sensação', 'Feels'),
  weatherOff: L('Clima indisponível agora.', 'Weather unavailable right now.'), fxOff: L('Cotação indisponível.', 'Rates unavailable.'),
  connections: L('Conexões', 'Connections'), connect: L('Conectar', 'Connect'), disconnect: L('Desconectar', 'Disconnect'),
  connected: L('Conectado', 'Connected'), notConfigured: L('Falta configurar na Vercel', 'Not configured on Vercel'),
  ouraSynced: L('Oura conectado · dados automáticos', 'Oura connected · automatic data'), fromGoogle: L('Google', 'Google'),
  ouraNoData: L('Sem dado do Oura para hoje ainda.', 'No Oura data for today yet.'),
  gmail: L('Gmail', 'Gmail'), unread24: L('Não lidos (24h)', 'Unread (24h)'), markRead: L('Marcar lido', 'Mark read'),
  archive: L('Arquivar', 'Archive'), sendReply: L('Enviar resposta', 'Send reply'), sent: L('Enviado ✓', 'Sent ✓'),
  gmailEmpty: L('Nenhum e-mail não lido nas últimas 24 horas.', 'No unread email in the last 24 hours.'),
  gmailConnect: L('Conecte o Gmail em Ajustes → Conexões.', 'Connect Gmail in Settings → Connections.'),
  writing: L('Escrevendo…', 'Writing…'), openGmail: L('Abrir no Gmail', 'Open in Gmail'),
  refresh: L('Atualizar', 'Refresh'), mapUnavailable: L('Mapa indisponível no momento.', 'Map unavailable right now.'),
  deleteContactConfirm: L('Excluir este contato? Esta ação não pode ser desfeita.', 'Delete this contact? This cannot be undone.'),
  compose: L('Escrever', 'Compose'), newEmail: L('Novo e-mail', 'New email'), to: L('Para', 'To'), subject: L('Assunto', 'Subject'), message: L('Mensagem', 'Message'), send: L('Enviar', 'Send'), rainChance: L('Chance de chuva', 'Rain chance'), humidity: L('Umidade', 'Humidity'),
  wind: L('Vento', 'Wind'), uvIndex: L('Índice UV', 'UV index'), sunriseL: L('Nascer do sol', 'Sunrise'), sunsetL: L('Pôr do sol', 'Sunset'),
  next12h: L('Próximas 12 horas', 'Next 12 hours'), weatherDetail: L('Detalhes do tempo', 'Weather detail'),
  sleepStages: L('Fases do sono', 'Sleep stages'), deepS: L('Profundo', 'Deep'), remS: L('REM', 'REM'), lightS: L('Leve', 'Light'), awakeS: L('Acordado', 'Awake'),
  efficiency: L('Eficiência', 'Efficiency'), lastNight: L('Última noite', 'Last night'), noSleepData: L('Sem dado de sono ainda.', 'No sleep data yet.'),
  weightHistory: L('Histórico de peso', 'Weight history'), addWeight: L('Registrar peso', 'Log weight'), heightSettings: L('Altura fica em Ajustes.', 'Height lives in Settings.'),
  suggestions: L('Sugestões do seu e-mail', 'Suggestions from your email'), scanInbox: L('Buscar viagens no e-mail', 'Scan email for trips'),
  scanning: L('Lendo e-mails…', 'Reading email…'), noSuggestions: L('Nada novo encontrado.', 'Nothing new found.'),
  addPhoto: L('Foto', 'Photo'), photo: L('Foto', 'Photo'),
  deleteConfirmGeneric: L('Tem certeza que deseja excluir? Esta ação não pode ser desfeita.', 'Delete this? This cannot be undone.'),
  on: L('Ligado', 'On'), off: L('Desligado', 'Off'), offline: L('Offline', 'Offline'),
  choose: L('Escolher', 'Choose'), configDevices: L('Aparelhos da Casa', 'Home devices'),
  giftLink: L('Link da compra', 'Purchase link'), giftPrice: L('Preço', 'Price'),
  expiryDate: L('Data de vencimento', 'Expiry date'),
  pullRefresh: L('Puxe para atualizar', 'Pull to refresh'), releaseRefresh: L('Solte para atualizar', 'Release to refresh'), refreshing: L('Atualizando…', 'Refreshing…'),
  openRemote: L('Abrir controle', 'Open remote'), brightness: L('Brilho', 'Brightness'), color: L('Cor', 'Color'), whiteLight: L('Luz branca', 'White'), turnOff: L('Desligar', 'Turn off'),
  acMode: L('Modo', 'Mode'), cold: L('Frio', 'Cool'), hot: L('Quente', 'Heat'), fan: L('Ventilar', 'Fan'), fanSpeed: L('Velocidade', 'Fan speed'),
  power: L('Liga/Desliga', 'Power'), volume: L('Volume', 'Volume'), input: L('Entrada', 'Input'), changeInput: L('Trocar', 'Switch'), back: L('Voltar', 'Back'),
  noKeys: L('Não encontrei as teclas deste controle. Me diga a marca e eu configuro.', 'No keys found for this remote.'),
  irNote: L('Comandos por infravermelho. Se algum botão não responder, me diga qual — ajusto o código dele.', 'IR commands. If a button does not respond, tell me which one.'),
  lastKnown: L('Último estado salvo', 'Last saved state'),
  screenError: L('Algo deu errado nesta tela', 'Something went wrong on this screen'),
  screenErrorHint: L('O resto do app continua funcionando. Tente voltar e abrir de novo.', 'The rest of the app still works. Go back and reopen.'),
  composeNew: L('Escrever e-mail', 'Compose'), toField: L('Para', 'To'), subjectField: L('Assunto', 'Subject'),
  emailBody: L('Mensagem', 'Message'), sendingE: L('Enviando…', 'Sending…'), saveError: L('Erro ao salvar. Tente de novo.', 'Save failed. Try again.'),
  externalItem: L('Item externo — edite no app de origem.', 'External item — edit in the source app.'),
  openThere: L('Abrir no app de origem', 'Open in source app'),
  onlyCommitments: L('Só reuniões', 'Meetings only'), everything: L('Tudo', 'Everything'),
  exams: L('Últimos exames', 'Recent exams'), support: L('Suporte (carteirinhas, vacinação)', 'Support (cards, vaccination)'),
  myKids: L('Minha prole', 'My kids'),
  company: L('Empresa', 'Company'), address: L('Endereço', 'Address'), contact: L('Contato', 'Contact'),
  routeMapNote: L('Rotas dos seus voos cadastrados.', 'Routes from your saved flights.'),
  importStatement: L('Importar extrato', 'Import statement'),
  travelCrawlNote: L('No deploy, um monitor do seu Gmail detecta novas reservas e, pela triagem, adiciona aqui, no calendário e no mapa.', 'At deploy, a Gmail monitor detects new bookings and, via triage, adds them here, to the calendar and map.'),
  snooze: L('Adiar 1 dia', 'Snooze 1 day'), markPaid: L('Marcar como paga', 'Mark paid'), undo: L('Desfazer', 'Undo'), doneLabel: L('Concluído', 'Done'),
  nextTrip: L('Próxima viagem', 'Next trip'), hospedagem: L('Hospedagem', 'Stay'), daysWord: L('dias', 'days'), ongoing: L('em andamento', 'ongoing'),
  boardingSoon: L('Cartão de embarque aparece aqui quando disponível (deploy).', 'Boarding pass shows here when available (deploy).'),
  docsNeeded: L('Documentos da viagem', 'Trip documents'), reservations: L('Reservas e anexos', 'Reservations & files'), tripHubHint: L('Tudo da viagem em um lugar: voos, hotel, reservas e documentos.', 'Everything for the trip in one place: flights, hotel, bookings and documents.'),
  t_income: L('Entrada', 'Income'),
  totalBalance: L('Saldo em contas', 'Accounts balance'), patrimony: L('Patrimônio', 'Net worth'), statement: L('Extrato', 'Statement'), reports: L('Relatórios', 'Reports'), assistant: L('Assistente', 'Assistant'),
  incomeL: L('Entradas', 'Income'), outflow: L('Saídas', 'Outflow'), byCategory: L('Por categoria', 'By category'), byPerson: L('Por pessoa', 'By person'), byMonth: L('Por mês', 'By month'),
  consumption: L('Consumo', 'Spending'), noTx: L('Sem lançamentos no período.', 'No transactions in period.'), addIncome: L('Entrada', 'Income'), addTx: L('Lançamento', 'Transaction'),
  period30: L('30 dias', '30 days'), accountL: L('Conta', 'Account'), categoryL: L('Categoria', 'Category'), allAccounts: L('Todas as contas', 'All accounts'), thisAccountReport: L('Relatório desta conta', 'This account report'),
  finAssistantIntro: L('Sou seu assistente financeiro. Vejo suas contas, extratos e categorias — posso resumir seu mês, achar onde você mais gasta, comparar períodos e sugerir cortes. Não dou recomendação de investimento definitiva.', "I'm your finance assistant. I see your accounts, statements and categories — I can summarize your month, find where you spend most, compare periods and suggest cuts. No definitive investment advice."),
  topCategory: L('Maior categoria', 'Top category'), vsLastMonth: L('vs. mês passado', 'vs. last month'), leftMonth: L('Sobra do mês', 'Left this month'), insights: L('Destaques', 'Highlights'), hideBalance: L('Mostrar/ocultar saldo', 'Show/hide balance'),
  available: L('Disponível', 'Available'), addBalance: L('Cadastrar cartão/saldo', 'Add card/balance'),
  high: L('Alta', 'High'),
  title: L('Título', 'Title'), date: L('Data', 'Date'), time: L('Hora', 'Time'), amount: L('Valor', 'Amount'), cost: L('Custo', 'Cost'),
  person: L('Pessoa', 'Person'), notes: L('Notas', 'Notes'), type: L('Tipo', 'Type'), color: L('Cor', 'Color'),
  settings: L('Ajustes', 'Settings'), language: L('Idioma', 'Language'), name: L('Nome', 'Name'),
  exportData: L('Exportar dados (JSON)', 'Export data (JSON)'), clearData: L('Apagar tudo', 'Erase everything'),
  clearConfirm: L('Apagar todos os dados? Não dá pra desfazer.', 'Erase all data? Cannot be undone.'),
  askClaude: L('Pergunte ao Claude…', 'Ask Claude…'),
  claudeIntro: L('Sou o Claude, dentro do seu app. Vejo tudo o que você cataloga aqui e posso resumir seu dia, achar pendências, somar gastos, sugerir mensagens e ações.', "I'm Claude, inside your app. I see everything you catalog here and can summarize your day, find loose ends, add up spending, draft messages and actions."),
  total: L('Total', 'Total'), thisMonth: L('este mês', 'this month'), spent: L('Gasto', 'Spent'), expiring: L('Vencendo', 'Expiring'),
  quickAdd: L('Adicionar', 'Add'), open: L('Abertas', 'Open'),
  t_task: L('Tarefa', 'Task'), t_event: L('Evento', 'Event'), t_expense: L('Gasto', 'Expense'), t_meal: L('Refeição', 'Meal'), t_exercise: L('Atividade física', 'Exercise'),
  t_med: L('Medicação', 'Medication'), t_appointment: L('Consulta', 'Appointment'), t_document: L('Documento', 'Document'),
  t_vehicle: L('Veículo', 'Vehicle'), t_trip: L('Viagem', 'Trip'), t_flight: L('Voo', 'Flight'), t_shopping: L('Compra', 'Shopping'), t_purchase: L('Pedido', 'Order'), t_condition: L('Condição', 'Condition'), t_allergy: L('Alergia', 'Allergy'), t_medication: L('Medicação', 'Medication'), t_healthMetric: L('Indicador', 'Indicator'),
  t_bill: L('Conta', 'Bill'), t_note: L('Nota', 'Note'), t_person: L('Pessoa', 'Person'), t_account: L('Conta/Cartão', 'Account/Card'),
  t_maintenance: L('Manutenção', 'Maintenance'), t_message: L('Mensagem', 'Message'), t_gift: L('Presente', 'Gift'),
  noPersist: L('Neste ambiente os dados podem não persistir entre sessões.', 'Data may not persist between sessions here.'),
  couldntParse: L('Não consegui interpretar — salvei como nota.', "Couldn't interpret — saved as a note."),
  suggested: L('Sugestão do Claude', 'Claude suggestion'),
  attachments: L('Anexos', 'Attachments'), addFile: L('Foto ou PDF', 'Photo or PDF'),
  trips: L('Viagens', 'Trips'), flights: L('Voos', 'Flights'), thisYear: L('Este ano', 'This year'), allTime: L('Tudo', 'All time'),
  hoursFlown: L('Horas voadas', 'Hours flown'), airportsSeen: L('Aeroportos', 'Airports'), airlinesSeen: L('Companhias', 'Airlines'), flightsCount: L('Voos', 'Flights'),
  flightCode: L('Nº do voo (ex: LA 3414)', 'Flight # (e.g., LA 3414)'), flightHint: L('Trecho e horário: confirme abaixo. Busca ao vivo entra na versão hospedada.', 'Route & time: confirm below. Live lookup arrives hosted.'),
  plate: L('Placa', 'Plate'), renavam: L('Renavam', 'Renavam'), plateHint: L('Auto-preenchimento por placa/Renavam entra na versão hospedada.', 'Auto-fill by plate/Renavam arrives hosted.'),
  week: L('Semana', 'Week'), month: L('Mês', 'Month'), noItemsDay: L('Nada neste dia.', 'Nothing on this day.'),
  markDone: L('Concluir', 'Mark done'), markUndone: L('Reabrir', 'Reopen'),
  important: L('Evento importante', 'Important event'), showOnToday: L('Mostrar saldo na tela Hoje', 'Show balance on Today'),
  accept: L('Aceitar', 'Accept'), yourModules: L('Seus módulos', 'Your modules'), items: L('itens', 'items'),
  nothingHere: L('Nada aqui ainda.', 'Nothing here yet.'), savedOne: L('Item salvo', 'Item saved'),
  photoAudioSoon: L('Foto e áudio na captura chegam na versão hospedada. Por ora, texto.', 'Photo & audio come hosted. Text for now.'),
  maintenance: L('Manutenção', 'Maintenance'), expenses: L('Despesas', 'Expenses'), documents: L('Documentos', 'Documents'),
  linked: L('Relacionados', 'Related'), addExpense: L('Despesa', 'Expense'), addMaint: L('Manutenção', 'Maintenance'), addDoc: L('Documento', 'Document'),
  // messages
  toTriage: L('Para triar', 'To triage'), unread: L('não lidas', 'unread'), reply: L('Responder', 'Reply'),
  draftReply: L('Rascunhar com Claude', 'Draft with Claude'), copy: L('Copiar', 'Copy'), copied: L('Copiado', 'Copied'),
  channel: L('Canal', 'Channel'), sender: L('Remetente', 'Sender'), body: L('Mensagem', 'Message'),
  sendHint: L('Envio real de e-mail/WhatsApp/Teams entra com as integrações (versão hospedada).', 'Real sending arrives with integrations (hosted version).'),
  noMessages: L('Sem mensagens. Conecte suas caixas na versão hospedada, ou adicione manualmente.', 'No messages. Connect your inboxes hosted, or add manually.'),
  // dock
  editDock: L('Barra principal (dock)', 'Main dock'), dockHint: L('Escolha até 5 atalhos para a barra de baixo.', 'Pick up to 5 shortcuts for the bottom bar.'),
  // filters
  fAll: L('Todos', 'All'), fWork: L('Trabalho', 'Work'), fPersonal: L('Pessoal', 'Personal'), fKids: L('Filhos', 'Kids'), fHouse: L('Casa', 'Home'), fHealth: L('Saúde', 'Health'), fShopping: L('Compras', 'Shopping'), fDone: L('Concluídas', 'Done'),
  priorityL: L('Prioridade', 'Priority'), prNormal: L('Normal', 'Normal'), prLow: L('Baixa', 'Low'),
  // finance
  accounts: L('Contas e cartões', 'Accounts & cards'), checking: L('Conta corrente', 'Checking'), credit: L('Cartão de crédito', 'Credit card'), investment: L('Investimentos', 'Investments'), benefit: L('Benefício', 'Benefit'),
  upcomingBills: L('Contas a vencer', 'Upcoming bills'), invested: L('Investido', 'Invested'), kind: L('Tipo de conta', 'Account type'),
  addAccount: L('Conta/Cartão', 'Account/Card'), balance: L('Saldo', 'Balance'), recent: L('Despesas recentes', 'Recent expenses'),
  // health
  weight: L('Peso', 'Weight'), height: L('Altura', 'Height'), bmi: L('IMC', 'BMI'), consultations: L('Consultas', 'Appointments'),
  treatments: L('Tratamentos', 'Treatments'), pharmacy: L('Farmácia', 'Pharmacy'), healthDocs: L('Documentos de saúde', 'Health documents'),
  appleHealth: L('Apple Health / Oura ao vivo entram na versão hospedada.', 'Apple Health / Oura live arrive hosted.'),
  editProfile: L('Peso e altura', 'Weight & height'), logOura: L('Registrar Oura de hoje', "Log today's Oura"),
  // house
  devices: L('Dispositivos', 'Devices'), notConnected: L('Não conectado', 'Not connected'),
  deviceHint: L('Controles reagem ao toque; a ligação real com SmartLife / LG ThinQ / Alexa entra na versão hospedada.', 'Controls respond to touch; real SmartLife / LG ThinQ / Alexa link arrives hosted.'),
  houseTasks: L('Tarefas da casa', 'House tasks'), houseCosts: L('Custos da casa', 'House costs'), cameras: L('Câmeras', 'Cameras'),
  camerasHint: L('Snapshots ao vivo (Mibo) na versão hospedada.', 'Live snapshots (Mibo) hosted.'), staff: L('Equipe / mensagens', 'Staff / messages'),
  addDevice: L('Dispositivo', 'Device'), power: L('Ligar', 'Power'), temp: L('Temperatura', 'Temperature'), fan: L('Ventilação', 'Fan'),
  houseEmails: L('E-mails da casa (Z)', 'House emails (Z)'), checkHouseEmails: L('Verificar e-mails', 'Check emails'),
  checkingHouseEmails: L('Lendo e-mails…', 'Reading emails…'), noHouseEmails: L('Nenhum e-mail novo com "(Z)".', 'No new "(Z)" emails.'),
  houseEmailsNeedsReview: L('Precisam da sua decisão', 'Need your decision'), itIsTask: L('É tarefa', "It's a task"),
  itIsEvent: L('É compromisso', "It's an event"), ignoreEmail: L('Ignorar', 'Ignore'),
  upcomingHouseEvents: L('Próximos compromissos', 'Upcoming events'), gmailNotConnected: L('Conecte o Gmail em Ajustes pra usar isso.', 'Connect Gmail in Settings to use this.'),
  // kids
  school: L('Escola', 'School'), gifts: L('Presentes', 'Gifts'), agenda: L('Agenda', 'Agenda'),
  markKidHint: L('Cadastre em Pessoas com relação "Filho" ou "Filha" para aparecer aqui.', 'Add in People with relationship "Son"/"Daughter" to show here.'),
  // ticktick
  tickHint: L('Estruturado para sincronizar com o TickTick (mão dupla) quando ligarmos a integração.', 'Structured to sync with TickTick (two-way) once we wire it.'),
};
function makeT(lang) { return (k) => (S[k] ? S[k][lang] : k); }

const META = {
  flight: [['airline', 'Companhia', 'Airline'], ['flightNumber', 'Nº do voo', 'Flight #'], ['from', 'Origem', 'From'], ['to', 'Destino', 'To'], ['seat', 'Assento', 'Seat'], ['locator', 'Localizador', 'Locator'], ['aircraft', 'Aeronave', 'Aircraft'], ['durationMin', 'Duração (min)', 'Duration (min)', 'number']],
  trip: [['purpose', 'Motivo', 'Purpose'], ['destination', 'Destino', 'Destination'], ['endDate', 'Volta', 'Return', 'date'], ['locator', 'Reserva', 'Booking'], ['hotel', 'Hotel', 'Hotel']],
  vehicle: [['make', 'Montadora', 'Make'], ['model', 'Modelo', 'Model'], ['year', 'Ano', 'Year', 'number'], ['km', 'KM', 'Odometer', 'number']],
  document: [['tag', 'Etiqueta', 'Tag'], ['number', 'Número', 'Number'], ['issuer', 'Emissor', 'Issuer'], ['holder', 'De quem é', 'Belongs to']],
  med: [['dose', 'Dose', 'Dose'], ['frequency', 'Frequência', 'Frequency']],
  appointment: [['doctor', 'Médico', 'Doctor'], ['specialty', 'Especialidade', 'Specialty'], ['location', 'Local', 'Location']],
  bill: [['payee', 'Beneficiário', 'Payee']],
  maintenance: [['workshop', 'Oficina', 'Workshop'], ['km', 'KM', 'Odometer', 'number'], ['nextKm', 'Próx. revisão (km)', 'Next service (km)', 'number']],
  person: [['relationship', 'Relação', 'Relationship'], ['role', 'Papel', 'Role'], ['company', 'Empresa', 'Company'], ['address', 'Endereço', 'Address'], ['addressComplement', 'Complemento', 'Complement'], ['birthdate', 'Nascimento', 'Birthdate', 'date']],
  account: [['institution', 'Instituição', 'Institution'], ['balance', 'Saldo atual', 'Current balance', 'number']],
  message: [['sender', 'Remetente', 'Sender']],
  income: [['source', 'Origem', 'Source']],
  purchase: [['store', 'Loja', 'Store'], ['tracking', 'Rastreio', 'Tracking']],
  condition: [['status', 'Status', 'Status'], ['since', 'Desde', 'Since', 'date']],
  allergy: [['severity', 'Gravidade', 'Severity'], ['reaction', 'Reação', 'Reaction']],
  medication: [['dose', 'Dose', 'Dose'], ['frequency', 'Frequência', 'Frequency'], ['prescribedBy', 'Prescrito por', 'Prescribed by'], ['startDate', 'Início', 'Start', 'date'], ['endDate', 'Fim (deixe vazio se em uso)', 'End (blank if ongoing)', 'date']],
  meal: [['mealType', 'Tipo de refeição', 'Meal type'], ['calories', 'Calorias (kcal)', 'Calories (kcal)', 'number'], ['proteinG', 'Proteína (g)', 'Protein (g)', 'number'], ['carbsG', 'Carboidrato (g)', 'Carbs (g)', 'number'], ['fatG', 'Gordura (g)', 'Fat (g)', 'number']],
  exercise: [['activityType', 'Atividade', 'Activity'], ['durationMin', 'Duração (min)', 'Duration (min)', 'number'], ['distanceKm', 'Distância (km)', 'Distance (km)', 'number'], ['calories', 'Calorias (kcal)', 'Calories (kcal)', 'number']],
};

// categorias de refeição — ícone/cor por tipo, com um palpite automático pelo horário quando o
// usuário não escolhe manualmente (meta.mealType ausente nos registros já salvos antes disso existir)
const MEAL_TYPES = [
  ['cafe', 'Café da Manhã', 'Breakfast', Coffee, '#D9A441'],
  ['lanche', 'Lanche', 'Snack (meal)', Sandwich, '#5FBF8F'],
  ['almoco', 'Almoço', 'Lunch', Soup, '#E5544B'],
  ['jantar', 'Jantar', 'Dinner', Utensils, '#7FBAF5'],
  ['ceia', 'Ceia', 'Late-night snack', Moon, '#B0A2FF'],
  ['snack', 'Snack', 'Snack', Cookie, '#F59E0B'],
];
const mealTypeInfo = (key) => MEAL_TYPES.find((x) => x[0] === key) || MEAL_TYPES[5];
function guessMealType(hm) {
  if (!hm || !/^\d{2}:\d{2}/.test(hm)) return 'snack';
  const [h, m] = hm.split(':').map(Number);
  const mins = h * 60 + (m || 0);
  if (mins >= 300 && mins < 600) return 'cafe';
  if (mins >= 600 && mins < 720) return 'lanche';
  if (mins >= 720 && mins < 900) return 'almoco';
  if (mins >= 900 && mins < 1080) return 'lanche';
  if (mins >= 1080 && mins < 1290) return 'jantar';
  return 'ceia';
}
const mealTypeOf = (m) => (m.meta && m.meta.mealType) || guessMealType(m.time);

const AIRLINES = { LA: 'LATAM', JJ: 'LATAM', G3: 'GOL', AD: 'Azul', AV: 'Avianca', CM: 'Copa', AA: 'American', UA: 'United', DL: 'Delta', B6: 'JetBlue', AC: 'Air Canada', QR: 'Qatar Airways', EK: 'Emirates', EY: 'Etihad', TK: 'Turkish', TP: 'TAP', IB: 'Iberia', UX: 'Air Europa', AF: 'Air France', KL: 'KLM', LH: 'Lufthansa', BA: 'British Airways', AZ: 'ITA Airways', QF: 'Qantas', JL: 'Japan Airlines', NH: 'ANA', SQ: 'Singapore', CX: 'Cathay Pacific', EI: 'Aer Lingus', LX: 'SWISS', AY: 'Finnair' };
function resolveFlight(code) {
  const m = (code || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z0-9]{2,3}?)(\d{1,4})$/);
  if (!m) return null;
  const carrier = m[1].replace(/\d/g, '') || m[1];
  return { airline: AIRLINES[carrier] || carrier, flightNumber: carrier + ' ' + m[2] };
}
const CAR_COLORS = [['#454545', 'Preto', 'Black'], ['#C7CBD1', 'Prata', 'Silver'], ['#E8E8EA', 'Branco', 'White'], ['#5B8DEF', 'Azul', 'Blue'], ['#E5544B', 'Vermelho', 'Red'], ['#8A8F98', 'Cinza', 'Gray'], ['#4CAF7D', 'Verde', 'Green'], ['#C9A227', 'Dourado', 'Gold']];
const CHANNELS = { email: { icon: Mail, color: C.blue, label: 'E-mail' }, whatsapp: { icon: MessageCircle, color: C.green, label: 'WhatsApp' }, teams: { icon: Users, color: C.violet, label: 'Teams' }, sms: { icon: MessageSquare, color: C.text2, label: 'SMS' } };
const ACCOUNT_KINDS = [['checking', 'Conta corrente', 'Checking'], ['credit', 'Cartão de crédito', 'Credit'], ['investment', 'Investimento', 'Investment'], ['benefit', 'Benefício', 'Benefit']];
const NEWS = [
  { source: 'G1', cat: 'Brasil', title: 'Manchete nacional em destaque do dia (exemplo)', url: 'https://g1.globo.com' },
  { source: 'Estadão', cat: 'Economia', title: 'Mercado: dólar e bolsa no radar dos investidores (exemplo)', url: 'https://www.estadao.com.br/economia' },
  { source: 'BBC Brasil', cat: 'Mundo', title: 'Cobertura internacional em destaque (exemplo)', url: 'https://www.bbc.com/portuguese' },
  { source: 'Tecmundo', cat: 'Tecnologia', title: 'Novidade de tecnologia da semana (exemplo)', url: 'https://www.tecmundo.com.br' },
  { source: 'ge', cat: 'Esporte', title: 'Resultado esportivo que todo mundo comenta (exemplo)', url: 'https://ge.globo.com' },
];

/* ---------------- helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const pad2 = (n) => String(n).padStart(2, '0');
const nowHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const loc = (lang) => (lang === 'pt' ? 'pt-BR' : 'en-US');
function fmtDate(iso, lang) { if (!iso) return ''; return new Date(iso + 'T00:00:00').toLocaleDateString(loc(lang), { weekday: 'short', day: '2-digit', month: 'short' }); }
function fmtLong(iso, lang) { return new Date(iso + 'T00:00:00').toLocaleDateString(loc(lang), { weekday: 'long', day: 'numeric', month: 'long' }); }
function fmtLongPretty(iso, lang) {
  // Capitaliza só o dia da semana e o mês; mantém "de" minúsculo. Ex: "Segunda-feira, 03 de Agosto, 2026"
  const d = new Date(iso + 'T00:00:00');
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  if (lang === 'pt') {
    const wd = cap(d.toLocaleDateString('pt-BR', { weekday: 'long' }));
    const day = String(d.getDate()).padStart(2, '0');
    const mon = cap(d.toLocaleDateString('pt-BR', { month: 'long' }));
    return `${wd}, ${day} de ${mon}, ${d.getFullYear()}`;
  }
  const wd = d.toLocaleDateString('en-US', { weekday: 'long' });
  const mon = d.toLocaleDateString('en-US', { month: 'long' });
  return `${wd}, ${mon} ${d.getDate()}, ${d.getFullYear()}`;
}
function fmtMoney(n, lang) { if (n == null || isNaN(n)) return ''; return new Intl.NumberFormat(loc(lang), { style: 'currency', currency: 'BRL' }).format(n); }
const TYPES = ['task', 'event', 'expense', 'income', 'meal', 'exercise', 'med', 'appointment', 'document', 'vehicle', 'maintenance', 'trip', 'flight', 'shopping', 'purchase', 'bill', 'note', 'person', 'account', 'message', 'gift', 'condition', 'allergy', 'medication', 'healthMetric'];
const DOMAINS = ['personal', 'today', 'health', 'home', 'finance', 'kids', 'docs', 'cars', 'travel', 'work'];
const isMoney = (ty) => ty === 'expense' || ty === 'income' || ty === 'bill' || ty === 'maintenance' || ty === 'purchase';
const CATEGORIES = {
  alimentacao: { pt: 'Alimentação', en: 'Food', icon: Utensils, color: '#5FBF8F' },
  transporte: { pt: 'Transporte', en: 'Transport', icon: Car, color: '#6BA6E6' },
  casa: { pt: 'Moradia', en: 'Home', icon: Home, color: '#5FB3B3' },
  saude: { pt: 'Saúde', en: 'Health', icon: Heart, color: '#EF4444' },
  educacao: { pt: 'Educação', en: 'Education', icon: GraduationCap, color: '#9B8CF0' },
  lazer: { pt: 'Lazer', en: 'Leisure', icon: Ticket, color: '#F59E0B' },
  compras: { pt: 'Compras', en: 'Shopping', icon: ShoppingCart, color: '#7CC0E8' },
  servicos: { pt: 'Contas & serviços', en: 'Bills & services', icon: FileText, color: '#9C9CA8' },
  salario: { pt: 'Renda', en: 'Income', icon: TrendingUp, color: '#5FBF8F' },
  investimento: { pt: 'Investimentos', en: 'Investments', icon: Landmark, color: '#6BA6E6' },
  outros: { pt: 'Outros', en: 'Other', icon: Circle, color: '#8A8F98' },
};
const CAT_KEYS = Object.keys(CATEGORIES);
function deriveCat(i) {
  if (i.meta && i.meta.category && CATEGORIES[i.meta.category]) return i.meta.category;
  if (i.type === 'income') return 'salario';
  const t = (i.title || '').toLowerCase();
  if (/mercado|restaur|ifood|comida|padaria|lanch|bar\b/.test(t)) return 'alimentacao';
  if (/uber|gasolina|posto|99|combust|estacion|pedágio|pedagio/.test(t)) return 'transporte';
  if (/farm|rem[ée]dio|consult|exame|dentista|hospital/.test(t)) return 'saude';
  if (/escola|mensalidade|curso|material/.test(t)) return 'educacao';
  if (/luz|energia|[áa]gua|internet|telefone|fatura|conta de/.test(t)) return 'servicos';
  const map = { home: 'casa', health: 'saude', kids: 'educacao', cars: 'transporte', travel: 'lazer', finance: 'servicos' };
  return map[i.domain] || 'outros';
}
function catOf(i) { return CATEGORIES[deriveCat(i)]; }
const isDebit = (i) => i.type === 'expense' || i.type === 'bill' || i.type === 'maintenance';
const isCredit = (i) => i.type === 'income';
const isTx = (i) => isDebit(i) || isCredit(i);
// saldo calculado: saldo base (digitado ao criar a conta) + soma das transações vinculadas à conta
function accountBalance(acc, items) {
  const base = Number(acc.meta && acc.meta.balance) || 0;
  const txs = items.filter(isTx).filter((i) => i.meta && i.meta.accountId === acc.id);
  const delta = txs.reduce((sum, t) => sum + (isCredit(t) ? 1 : -1) * (Number(t.amount) || 0), 0);
  return base + delta;
}
const monthOf = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
const WD = { pt: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const isMilestoneType = (ty) => ['event', 'appointment', 'trip', 'flight', 'note'].includes(ty);
const isKid = (p) => /filh|fil[ha]|son|daughter|child/i.test((p.meta && (p.meta.relationship || p.meta.role)) || '');
function docCategory(i) {
  const s = (i.title + ' ' + ((i.meta && i.meta.issuer) || '')).toLowerCase();
  if (/passaporte|passport/.test(s)) return 'Passaportes';
  if (/cnh|habilita|driver/.test(s)) return 'CNH';
  if (/rg|identidade|cpf|certid|nascimento|casamento/.test(s)) return 'Identidade';
  if (/plano|sa[úu]de|vacin|carteirinha|exame|hemograma|laudo|health/.test(s) || i.domain === 'health') return 'Saúde';
  if (/seguro|ap[óo]lice|ve[íi]c|ipva|licenciamento/.test(s) || i.domain === 'cars') return 'Veículo';
  if (/boletim|escola|matr[íi]cula/.test(s) || i.domain === 'kids') return 'Escola';
  return 'Outros';
}
const AIRPORTS = {
  GRU: [-46.47, -23.43], CGH: [-46.66, -23.63], GIG: [-43.25, -22.81], BSB: [-47.92, -15.87], SSA: [-38.33, -12.91], REC: [-34.92, -8.13], POA: [-51.17, -29.99], CNF: [-43.97, -19.63],
  LIS: [-9.13, 38.77], MAD: [-3.57, 40.47], CDG: [2.55, 49.01], LHR: [-0.45, 51.47], FCO: [12.25, 41.80], AMS: [4.76, 52.31], FRA: [8.57, 50.03], MXP: [8.72, 45.63], LGW: [-0.19, 51.15],
  JFK: [-73.78, 40.64], EWR: [-74.17, 40.69], MIA: [-80.29, 25.79], LAX: [-118.41, 33.94], ORD: [-87.90, 41.98], MCO: [-81.31, 28.43], IAH: [-95.34, 29.98], SFO: [-122.38, 37.62],
  EZE: [-58.53, -34.82], SCL: [-70.79, -33.39], BOG: [-74.14, 4.70], LIM: [-77.11, -12.02], MEX: [-99.07, 19.44], PTY: [-79.38, 9.07], CUN: [-86.87, 21.04],
  DXB: [55.36, 25.25], DOH: [51.61, 25.27], IST: [28.81, 40.98], NRT: [140.39, 35.77], HND: [139.78, 35.55], SIN: [103.99, 1.36], HKG: [113.91, 22.31],
};

const MODULES = [
  { key: 'work', icon: Briefcase, color: C.sky, filter: (i) => i.domain === 'work' || (i.meta && i.meta.moura), types: ['event', 'appointment', 'task', 'note'], custom: 'work' },
  { key: 'purchases', icon: Package, color: C.accent, filter: (i) => i.type === 'purchase', types: ['purchase'], custom: 'purchases' },
  { key: 'tasks', icon: ListTodo, color: C.accent, filter: (i) => i.type === 'task', types: ['task'] },
  { key: 'health', icon: Heart, color: C.rose, filter: (i) => i.domain === 'health', types: ['appointment', 'meal', 'med', 'expense', 'document', 'note'], custom: 'health' },
  { key: 'house', icon: Home, color: C.blue, filter: (i) => i.domain === 'home', types: ['task', 'shopping', 'expense', 'note'], custom: 'house' },
  { key: 'finance', icon: Wallet, color: C.green, filter: (i) => i.domain === 'finance' || i.type === 'expense' || i.type === 'bill' || i.type === 'account', types: ['account', 'expense', 'bill', 'note'], custom: 'finance' },
  { key: 'kids', icon: Users, color: C.violet, filter: (i) => i.domain === 'kids', types: ['appointment', 'event', 'task', 'shopping', 'gift', 'document', 'note'], custom: 'kids' },
  { key: 'people', icon: UserRound, color: C.sky, filter: (i) => i.type === 'person', types: ['person'], custom: 'people' },
  { key: 'gmail', icon: Mail, color: C.blue, filter: () => false, types: ['message'], custom: 'gmail' },
  { key: 'docs', icon: FileText, color: C.blue, filter: (i) => i.type === 'document' || i.domain === 'docs', types: ['document'], custom: 'docs' },
  { key: 'cars', icon: Car, color: C.teal, filter: (i) => i.domain === 'cars' || i.type === 'vehicle', types: ['vehicle', 'maintenance', 'expense', 'document', 'note'], custom: 'cars' },
  { key: 'travel', icon: Plane, color: C.violet, filter: (i) => i.domain === 'travel' || i.type === 'trip' || i.type === 'flight', types: ['trip', 'flight', 'note'], custom: 'travel' },
];
const moduleByKey = (k) => MODULES.find((m) => m.key === k);
const moduleDomain = (k) => (k === 'house' ? 'home' : k === 'tasks' || k === 'people' ? 'personal' : k);

const SCREEN_ICONS = { home: Sun, messages: MessageSquare, calendar: CalIcon, dashboard: LayoutGrid, claude: Sparkles };
const DOCKABLE = ['home', 'messages', 'calendar', 'dashboard', 'claude', 'tasks', 'finance', 'health', 'house', 'travel', 'cars', 'kids', 'people', 'docs', 'gmail'];
const DEFAULT_DOCK = ['home', 'messages', 'calendar', 'dashboard', 'claude'];
function navIcon(k) { return SCREEN_ICONS[k] || (moduleByKey(k) ? moduleByKey(k).icon : Circle); }
function navLabel(k, t) { return k === 'dashboard' ? t('dashShort') : t(k); }
// menu lateral wide (web/iPad paisagem): navegação fixa e sempre expandida, agrupada —
// "Painel" some daqui (o conteúdo dele entra na Hoje), os módulos passam a ser destinos diretos.
const WIDE_NAV_GROUPS = [
  { label: L('Visão geral', 'Overview'), keys: ['home', 'calendar', 'messages', 'claude'] },
  { label: L('Vida', 'Life'), keys: ['work', 'tasks', 'health', 'house', 'finance', 'kids'] },
  { label: L('Registros', 'Records'), keys: ['people', 'docs', 'cars', 'travel', 'purchases'] },
];
const TUYA_SEED = {
  'eb2a4a8b85c2a8deadb1g8': { show: true, alias: 'Abajur Carol', room: 'Suíte', kind: 'light' },
  'ebce584d586201f762d4ag': { show: true, alias: 'Subwoofer', room: 'Home-office', kind: 'plug' },
  'ebbc591b7da959062dm9im': { show: true, alias: 'TV Suíte', room: 'Suíte', kind: 'tv', ir: '534436288caab546bacb' },
  'eb35a5d8aab7cb6a92jpzr': { show: true, alias: 'Vivo Suíte', room: 'Suíte', kind: 'stb', ir: '534436288caab546bacb' },
  'eb8d3532144aa35a7do3go': { show: true, alias: 'Ar Suíte', room: 'Suíte', kind: 'ac', ir: '534436288caab546bacb' },
  'eb8629b8368eb1b1cfnhnm': { show: true, alias: 'Ar Brinquedoteca', room: 'Quarto Maria', kind: 'ac', ir: '534436288caab5460e50' },
  'ebce4627183df11fbewuyh': { show: true, alias: 'Ar Dudu', room: 'Quarto Dudu', kind: 'ac', ir: '042057708cce4ef3ee58' },
  '467308739c9c1f859136': { show: true, alias: 'Cervejeira', room: 'Cozinha', kind: 'plug' },
  'eb9d5c2de5306c1e93f0rp': { show: true, alias: 'Receiver', room: 'Sala de TV', kind: 'receiver', ir: '04205770e868e76cda25' },
  'eb1312396be3adad2fklrm': { show: true, alias: 'TV Sala', room: 'Sala de TV', kind: 'tv', ir: '04205770e868e76cda25' },
  'eb2a81eee50d3a40e7hwjo': { show: true, alias: 'Vivo Sala', room: 'Sala de TV', kind: 'stb', ir: '04205770e868e76cda25' },
  'ebd58a13d5c1084fb1faaf': { show: true, alias: 'Ar Sala', room: 'Sala de TV', kind: 'ac', ir: '04205770e868e76cda25' },
};
const APP_VERSION = 'v62 · 05ago' + (process.env.GIT_SHA ? ' · ' + process.env.GIT_SHA.slice(0, 7) : '');
const DEFAULT_DEVICES = [
  { id: 'd1', name: 'Ar — Quarto', type: 'ac', on: false, temp: 22, fan: 2 },
  { id: 'd2', name: 'Luz — Sala', type: 'light', on: false },
  { id: 'd3', name: 'Ventilador — Escritório', type: 'fan', on: false, fan: 1 },
];

/* ---------------- storage ---------------- */
if (typeof window !== 'undefined') { try { installStorage(); } catch (e) {} }
const STORE_KEY = 'lcc_items_v1', SETTINGS_KEY = 'lcc_settings_v1';
const hasStore = () => typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function';
const memAtt = {};
async function persistSeeded() { if (hasStore()) { try { await window.storage.set('lcc_seeded_v1', '1'); } catch (e) {} } }
async function loadState() {
  let items = [], settings = null, seeded = false;
  if (hasStore()) {
    try { const r = await window.storage.get(STORE_KEY); if (r && r.value) items = JSON.parse(r.value); } catch (e) {}
    try { const r = await window.storage.get(SETTINGS_KEY); if (r && r.value) settings = JSON.parse(r.value); } catch (e) {}
    try { const r = await window.storage.get('lcc_seeded_v1'); if (r && r.value) seeded = true; } catch (e) {}
  }
  return { items, settings, seeded };
}
async function persistItems(x) { if (hasStore()) { try { await window.storage.set(STORE_KEY, JSON.stringify(x)); } catch (e) {} } }
async function persistSettings(x) { if (hasStore()) { try { await window.storage.set(SETTINGS_KEY, JSON.stringify(x)); } catch (e) {} } }
async function saveAttachment(dataUrl, name, kind) {
  const id = 'att_' + uid();
  if (hasStore()) { try { await window.storage.set('lcc_' + id, JSON.stringify({ dataUrl, name, kind })); } catch (e) { memAtt[id] = { dataUrl, name, kind }; } } else memAtt[id] = { dataUrl, name, kind };
  return { id, name, kind };
}
async function loadAttachment(id) {
  if (memAtt[id]) return memAtt[id];
  if (hasStore()) { try { const r = await window.storage.get('lcc_' + id); if (r && r.value) return JSON.parse(r.value); } catch (e) {} }
  return null;
}
function fileToDataUrl(file, maxDim = 1500) {
  return new Promise((resolve, reject) => {
    if (file.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => { const img = new Image(); img.onload = () => {
        let { width: w, height: h } = img; const s = Math.min(1, maxDim / Math.max(w, h));
        const cw = Math.round(w * s), ch = Math.round(h * s); const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch); resolve(cv.toDataURL('image/jpeg', 0.82));
      }; img.onerror = reject; img.src = r.result; };
      r.onerror = reject; r.readAsDataURL(file);
    } else { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); }
  });
}

/* ---------------- Claude ---------------- */
async function callClaude(system, messages) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess && sess.session ? sess.session.access_token : '';
  const res = await fetch('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4096, system, messages }) });
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
async function classifyCaptureFile(b64, mime, lang) {
  const langName = lang === 'pt' ? 'Brazilian Portuguese' : 'US English';
  const system = `You are the capture classifier for a personal life app. Look at the attached image or document (a receipt, invoice, ticket, screenshot, note, etc.) and convert it into one or more items. Output ONLY a JSON array — no prose, no fences. Each item: {"type": one of [task,event,expense,meal,med,appointment,document,trip,flight,shopping,bill,note], "domain": one of [${DOMAINS.join(',')}], "title": short title in ${langName}, "date":"YYYY-MM-DD" or null, "time":"HH:MM" or null, "amount": number or null, "person": string or null, "priority":1|2|3, "confidence":0..1}. Today is ${todayISO()}. Extract amounts, dates and times you can read. If unsure, type "note".`;
  const isPdf = mime === 'application/pdf';
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: b64 } };
  const text = await callClaude(system, [{ role: 'user', content: [block, { type: 'text', text: lang === 'pt' ? 'Extraia os itens desta imagem/documento.' : 'Extract items from this.' }] }]);
  let j = text; const a = text.indexOf('['), b = text.lastIndexOf(']'); if (a !== -1 && b !== -1) j = text.slice(a, b + 1);
  const arr = JSON.parse(j);
  return (Array.isArray(arr) ? arr : [arr]).map((x) => ({
    type: TYPES.includes(x.type) ? x.type : 'note', domain: DOMAINS.includes(x.domain) ? x.domain : 'personal',
    title: String(x.title || 'Item').slice(0, 160), date: x.date || null, time: x.time || null,
    amount: x.amount != null ? Number(x.amount) : null, person: x.person || null, priority: [1, 2, 3].includes(x.priority) ? x.priority : 3, confidence: x.confidence,
  }));
}
// classifica uma foto tirada no captador rápido: se for comida, devolve uma estimativa de
// refeição (calorias/macros) pra confirmar antes de salvar; senão, cai no capturador genérico
async function classifyPhotoSmart(b64, mime, lang) {
  const langName = lang === 'pt' ? 'Brazilian Portuguese' : 'US English';
  const system = `You look at a photo taken from a personal life app's quick-capture button. First decide: is this a photo of a MEAL/FOOD/DRINK about to be eaten or already eaten?
If YES, output ONLY this JSON (no prose, no fences): {"kind":"meal","title":"short dish name in ${langName}","calories":number,"proteinG":number,"carbsG":number,"fatG":number,"confidence":0..1}. Estimate calories and macros as best you can from what's visibly on the plate/glass — a reasonable single-serving estimate, never null.
If NO (it's a receipt, document, screenshot, ticket, note, etc.), output ONLY this JSON: {"kind":"generic","items":[{"type": one of [task,event,expense,meal,med,appointment,document,trip,flight,shopping,bill,note], "domain": one of [${DOMAINS.join(',')}], "title": short title in ${langName}, "date":"YYYY-MM-DD" or null, "time":"HH:MM" or null, "amount": number or null, "person": string or null, "priority":1|2|3, "confidence":0..1}]}. Today is ${todayISO()}.`;
  const block = { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: b64 } };
  const text = await callClaude(system, [{ role: 'user', content: [block, { type: 'text', text: lang === 'pt' ? 'Analise esta foto.' : 'Analyze this photo.' }] }]);
  let j = text; const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a !== -1 && b !== -1) j = text.slice(a, b + 1);
  const x = JSON.parse(j);
  if (x.kind === 'meal') {
    return { kind: 'meal', title: String(x.title || (lang === 'pt' ? 'Refeição' : 'Meal')).slice(0, 140), calories: Number(x.calories) || 0, proteinG: Number(x.proteinG) || 0, carbsG: Number(x.carbsG) || 0, fatG: Number(x.fatG) || 0, confidence: typeof x.confidence === 'number' ? x.confidence : 0.5 };
  }
  const arr = Array.isArray(x.items) ? x.items : [];
  return { kind: 'generic', items: arr.map((it) => ({
    type: TYPES.includes(it.type) ? it.type : 'note', domain: DOMAINS.includes(it.domain) ? it.domain : 'personal',
    title: String(it.title || 'Item').slice(0, 160), date: it.date || null, time: it.time || null,
    amount: it.amount != null ? Number(it.amount) : null, person: it.person || null, priority: [1, 2, 3].includes(it.priority) ? it.priority : 3, confidence: it.confidence,
  })) };
}
// estima calorias/macros a partir só do nome/descrição da refeição digitada à mão (sem foto)
async function estimateMealFromText(text, lang) {
  const langName = lang === 'pt' ? 'Brazilian Portuguese' : 'US English';
  const system = `You estimate nutrition for a personal diet-tracking app, from just a short meal description (no photo). Output ONLY this JSON (no prose, no fences): {"calories":number,"proteinG":number,"carbsG":number,"fatG":number}. Give a reasonable single-serving estimate based on the description, in ${langName === 'Brazilian Portuguese' ? 'typical Brazilian portions' : 'typical portions'}. Never return null — always give your best estimate number.`;
  const t = await callClaude(system, [{ role: 'user', content: text }]);
  let j = t; const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a !== -1 && b !== -1) j = t.slice(a, b + 1);
  const x = JSON.parse(j);
  return { calories: Number(x.calories) || 0, proteinG: Number(x.proteinG) || 0, carbsG: Number(x.carbsG) || 0, fatG: Number(x.fatG) || 0 };
}
async function classifyCapture(raw, lang) {
  const langName = lang === 'pt' ? 'Brazilian Portuguese' : 'US English';
  const system = `You are the capture classifier for a personal life app. Convert the raw note into one or more items, splitting compound notes. Output ONLY a JSON array — no prose, no fences. Each item: {"type": one of [task,event,expense,meal,med,appointment,document,trip,flight,shopping,bill,note], "domain": one of [${DOMAINS.join(',')}], "title": short title in ${langName}, "date":"YYYY-MM-DD" or null, "time":"HH:MM" or null, "amount": number or null, "person": string or null, "priority":1|2|3, "confidence":0..1}. Today is ${todayISO()}. Resolve relative dates. IMPORTANT for "time": always extract the time of day when present, converting Brazilian formats to 24h HH:MM. Examples: "14h"→"14:00", "14hs"→"14:00", "às 14"→"14:00", "9h30"→"09:30", "14:30"→"14:30", "2 da tarde"→"14:00", "meio-dia"→"12:00", "8 da manhã"→"08:00". If an event/appointment/meeting has a time, it MUST be in the time field. If unsure, type "note", domain "personal".`;
  const text = await callClaude(system, [{ role: 'user', content: raw }]);
  let j = text; const a = text.indexOf('['), b = text.lastIndexOf(']'); if (a !== -1 && b !== -1) j = text.slice(a, b + 1);
  const arr = JSON.parse(j);
  return (Array.isArray(arr) ? arr : [arr]).map((x) => ({
    type: TYPES.includes(x.type) ? x.type : 'note', domain: DOMAINS.includes(x.domain) ? x.domain : 'personal',
    title: String(x.title || raw).slice(0, 160), date: x.date || null, time: x.time || null,
    amount: x.amount != null && !isNaN(Number(x.amount)) ? Number(x.amount) : null, person: x.person || null,
    priority: [1, 2, 3].includes(x.priority) ? x.priority : 2, confidence: typeof x.confidence === 'number' ? x.confidence : 0.6,
  }));
}
function buildContext(items) {
  const today = todayISO();
  const open = items.filter((i) => i.type === 'task' && i.status !== 'done').slice(0, 30).map((i) => ({ title: i.title, due: i.date, priority: i.priority, area: i.domain }));
  const events = items.filter((i) => i.date && ['event', 'appointment', 'trip', 'flight'].includes(i.type)).slice(0, 25).map((i) => ({ title: i.title, date: i.date, area: i.domain }));
  const exp = items.filter((i) => i.type === 'expense' && i.amount); const month = today.slice(0, 7);
  // dados de saúde/dieta — mesma seleção usada no "Resumo de hoje" da aba Saúde, pra o Dr. Claude
  // ter acesso completo em qualquer lugar do app que fale com ele (inclusive na aba Dieta).
  const healthMetrics = items.filter((i) => i.type === 'healthMetric' && i.title !== '__checked__').slice(-40).map((i) => ({ indicator: i.title, value: i.amount, unit: i.meta && i.meta.unit, status: i.meta && i.meta.status, date: i.date }));
  const conditions = items.filter((i) => i.type === 'condition' && i.meta && i.meta.status === 'ativa').map((i) => i.title);
  const allergies = items.filter((i) => i.type === 'allergy').map((i) => i.title);
  const medications = items.filter((i) => i.type === 'medication' && !(i.meta && i.meta.endDate)).map((i) => i.title);
  const recentMeals = items.filter((i) => i.type === 'meal' && i.domain === 'health' && i.date >= addDays(today, -14)).map((i) => ({ title: i.title, date: i.date, calories: i.meta && i.meta.calories, proteinG: i.meta && (i.meta.proteinG ?? i.meta.protein), carbsG: i.meta && (i.meta.carbsG ?? i.meta.carbs), fatG: i.meta && (i.meta.fatG ?? i.meta.fat) }));
  const recentExercise = items.filter((i) => i.type === 'exercise' && i.date >= addDays(today, -14)).map((i) => ({ date: i.date, activity: i.meta && i.meta.activityType, durationMin: i.meta && i.meta.durationMin, distanceKm: i.meta && i.meta.distanceKm }));
  const examHistory = buildExamHistory(items);
  return {
    today, openTasks: open, events, monthSpendBRL: exp.filter((i) => (i.date || '').startsWith(month)).reduce((a, b) => a + b.amount, 0),
    health: { metrics: healthMetrics, conditions, allergies, medications, recentMeals, recentExercise, examHistory },
  };
}

/* ---------------- primitives ---------------- */
const card = new Proxy({}, { get: (_, k) => {
  const t = THEMES[_theme] || THEMES.dark;
  if (k === 'background') return t.surface;
  if (k === 'border') return `1px solid ${t.border}`;
  if (k === 'borderRadius') return 20;
  if (k === 'boxShadow') return _theme === 'light' ? '0 1px 3px rgba(0,0,0,0.06)' : '0 1px 0 rgba(255,255,255,0.03) inset';
  return undefined;
}, ownKeys: () => ['background', 'border', 'borderRadius', 'boxShadow'], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
const inputStyle = new Proxy({}, { get: (_, k) => {
  const t = THEMES[_theme] || THEMES.dark;
  const base = { width: '100%', borderRadius: 10, padding: '10px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box' };
  if (k in base) return base[k];
  if (k === 'background') return t.bg2;
  if (k === 'border') return `1px solid ${t.border}`;
  if (k === 'color') return t.text;
  return undefined;
}, ownKeys: () => ['width', 'background', 'border', 'borderRadius', 'color', 'padding', 'fontSize', 'outline', 'boxSizing'], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
const inputStyleBig = { ...inputStyle, padding: '14px 15px', fontSize: 16, borderRadius: 12 };
function haptic(ms = 8) {
  if (isNative()) { Haptics.impact({ style: ms >= 15 ? ImpactStyle.Medium : ImpactStyle.Light }).catch(() => {}); return; }
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}
function Btn({ children, onClick, kind = 'primary', style, disabled }) {
  const kinds = { primary: { background: C.accent, color: '#FFFFFF', border: 'none', fontWeight: 600 }, ghost: { background: 'transparent', color: C.text2, border: `1px solid ${C.border}` }, soft: { background: C.surface2, color: C.text, border: `1px solid ${C.border}` }, danger: { background: 'transparent', color: C.rose, border: `1px solid ${C.rose}55` } };
  return <button onClick={onClick ? (e) => { haptic(); onClick(e); } : undefined} disabled={disabled} style={{ padding: '10px 14px', borderRadius: 12, fontSize: 14, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, ...kinds[kind], ...style }}>{children}</button>;
}
function Chip({ children, active, onClick, color }) {
  return <button onClick={onClick ? (e) => { haptic(); onClick(e); } : undefined} style={{ padding: '6px 11px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap', background: active ? (color ? color + '22' : C.accentSoft) : 'transparent', color: active ? (color || C.accent) : C.text2, border: `1px solid ${active ? (color || C.accent) + '55' : C.border}` }}>{children}</button>;
}
// relógio ao vivo, sempre calculado no navegador (hora local real do usuário) — serve de
// referência visual pra conferir se os horários registrados no app (emails, eventos) batem.
function LiveClock({ style }) {
  const [hm, setHm] = useState(() => nowHM());
  useEffect(() => {
    const id = setInterval(() => setHm(nowHM()), 1000 * 15);
    return () => clearInterval(id);
  }, []);
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{hm}</span>;
}
function Field({ label, children }) {
  return <label style={{ display: 'block', marginBottom: 16 }}><div style={{ fontSize: 12, color: C.text2, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7, fontWeight: 600 }}>{label}</div>{children}</label>;
}
function Empty({ icon: Icon, text }) {
  return <div style={{ ...card, padding: '26px 18px', textAlign: 'center', color: C.text3 }}>{Icon && <Icon size={22} style={{ opacity: 0.6, marginBottom: 8 }} />}<div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{text}</div></div>;
}
function Modal({ children, onClose, wide }) {
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50 }}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, border: `1px solid ${C.border}`, borderBottom: 'none', width: '100%', maxWidth: wide ? 640 : 480, maxHeight: '90vh', overflowY: 'auto', padding: 18, boxSizing: 'border-box' }}>{children}</div>
  </div>;
}
// grade responsiva: uma coluna no celular, se ajusta pra 2+ colunas sozinha em telas maiores (iPad etc.), sem precisar medir viewport em JS
function ResponsiveGrid({ children, min = 220 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 }}>{children}</div>;
}
function SheetHead({ title, onClose, icon: Icon }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
    <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>{Icon && <Icon size={16} style={{ color: C.accent }} />}{title}</div>
    <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer' }}><X size={20} /></button>
  </div>;
}
function SectionTitle({ icon: Icon, label, color }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '18px 2px 10px' }}><Icon size={14} style={{ color: color || C.text2 }} /><span style={{ fontSize: 12.5, color: C.text, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 700 }}>{label}</span></div>;
}
function ScreenTitle({ title, sub }) {
  return <div style={{ margin: '4px 2px 16px' }}><div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.01em' }}>{title}</div>{sub && <div style={{ fontSize: 13, color: C.text3, marginTop: 3 }}>{sub}</div>}</div>;
}
function MiniStat({ label, value, color, small, onClick }) {
  return (
    <div onClick={onClick} style={{ flex: 1, background: C.bg2, borderRadius: 12, padding: '11px 8px', textAlign: 'center', cursor: onClick ? 'pointer' : 'default', border: `1px solid ${onClick ? C.borderSoft : 'transparent'}` }}>
      <div style={{ fontSize: small ? 14 : 19, fontWeight: 700, color: color || C.text }}>{value}</div>
      <div style={{ fontSize: 10.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 2, fontWeight: 600 }}>{label}</div>
    </div>
  );
}
function HintCard({ icon: Icon, text }) {
  return <div style={{ ...card, padding: 12, marginBottom: 10, display: 'flex', gap: 9, alignItems: 'flex-start', background: C.bg2 }}><Icon size={14} style={{ color: C.text3, marginTop: 1, flexShrink: 0 }} /><div style={{ fontSize: 11.5, color: C.text3, lineHeight: 1.5 }}>{text}</div></div>;
}
function typeIcon(type) {
  const m = { task: ListTodo, event: CalIcon, expense: Wallet, income: TrendingUp, meal: Utensils, exercise: Dumbbell, med: Pill, appointment: Stethoscope, document: FileText, vehicle: Car, maintenance: Wrench, trip: Plane, flight: Plane, shopping: ShoppingCart, purchase: Package, bill: Wallet, note: FileText, person: UserRound, account: CreditCard, message: MessageSquare, gift: Gift, condition: HeartPulse, allergy: AlertTriangle, medication: Pill, healthMetric: Activity };
  return m[type] || FileText;
}
function SwipeRow({ children, onLeft, onRight, leftLabel, leftColor, leftIcon: LI, rightLabel, rightColor, rightIcon: RI }) {
  const [dx, setDx] = useState(0);
  const start = useRef(null);
  const armed = useRef(false); // já passou do limiar nesse arrasto — evita repetir o toque tátil
  const onStart = (e) => { start.current = e.touches[0].clientX; armed.current = false; };
  const onMove = (e) => {
    if (start.current == null) return;
    const d = e.touches[0].clientX - start.current;
    // limita e só permite direção com ação definida
    let nd = d;
    if (d > 0 && !onRight) nd = 0;
    if (d < 0 && !onLeft) nd = 0;
    nd = Math.max(-96, Math.min(96, nd));
    const crossed = nd <= -60 || nd >= 60;
    if (crossed && !armed.current) { armed.current = true; haptic(8); }
    else if (!crossed && armed.current) { armed.current = false; }
    setDx(nd);
  };
  const onEnd = () => {
    if (dx <= -60 && onLeft) onLeft();
    else if (dx >= 60 && onRight) onRight();
    setDx(0); start.current = null;
  };
  return (
    <div style={{ position: 'relative', marginBottom: 8, borderRadius: 14, overflow: 'hidden' }}>
      {/* fundos só aparecem enquanto arrasta (evita "glance" de cor nas bordas) */}
      {onLeft && dx < 0 && <div style={{ position: 'absolute', inset: 0, background: leftColor || C.rose, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 20, gap: 6, color: '#fff', fontSize: 12.5, fontWeight: 600 }}>{LI && <LI size={16} />}{leftLabel}</div>}
      {onRight && dx > 0 && <div style={{ position: 'absolute', inset: 0, background: rightColor || C.green, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 20, gap: 6, color: '#fff', fontSize: 12.5, fontWeight: 600 }}>{RI && <RI size={16} />}{rightLabel}</div>}
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} style={{ transform: `translateX(${dx}px)`, transition: start.current == null ? 'transform .2s ease' : 'none', position: 'relative', zIndex: 1 }}>
        {children}
      </div>
    </div>
  );
}
function WorkBadge({ size = 15 }) {
  return (
    <span title="Trabalho" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: size, height: size, borderRadius: 999, background: C.sky }}>
      <Briefcase size={Math.max(8, Math.round(size * 0.6))} color="#1A1200" strokeWidth={2.5} />
    </span>
  );
}
function ItemRow({ item, lang, t, onToggle, onOpen, hideAmount, onDelete }) {
  const overdue = item.type === 'task' && item.status !== 'done' && item.date && item.date < todayISO();
  const Ic = (item.meta && item.meta.purchaseRef) ? Package : typeIcon(item.type); const mile = item.meta && item.meta.milestone;
  const swipeable = item.type === 'task' && !!onDelete;
  const row = (
    <div onClick={() => onOpen(item)} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: swipeable ? 0 : 8, cursor: 'pointer' }}>
      {item.type === 'task' ? (
        <button onClick={(e) => { e.stopPropagation(); onToggle(item.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 1, color: item.status === 'done' ? C.green : C.text3 }}>{item.status === 'done' ? <CircleCheck size={20} style={{ animation: 'pop .32s ease' }} /> : <Circle size={20} />}</button>
      ) : <div style={{ marginTop: 2, color: mile ? C.accent : C.text3 }}><Ic size={18} /></div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 500, color: item.status === 'done' ? C.text3 : C.text, textDecoration: item.status === 'done' ? 'line-through' : 'none', lineHeight: 1.35, display: 'flex', gap: 6, alignItems: 'center' }}>{mile && <Star size={12} style={{ color: C.accent, flexShrink: 0 }} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: C.text2, fontWeight: 500 }}>{t('t_' + item.type)}</span>
          {item.date && <span style={{ fontSize: 11.5, color: overdue ? C.rose : C.text2, display: 'inline-flex', alignItems: 'center', gap: 3 }}>{overdue ? <AlertTriangle size={11} /> : <Clock size={11} />}{fmtDate(item.date, lang)}{item.time ? ' · ' + item.time : ''}</span>}
          {item.amount != null && <span style={{ fontSize: 11.5, color: C.green }}>{hideAmount ? '••••' : fmtMoney(item.amount, lang)}</span>}
          {item.person && <span style={{ fontSize: 11.5, color: C.text3 }}>· {item.person}</span>}
          {item.meta && item.meta.attachments && item.meta.attachments.length > 0 && <Paperclip size={11} style={{ color: C.text3 }} />}
          {item.notes && item.type !== 'message' && item.type !== 'note' && <FileText size={11} style={{ color: C.text3 }} />}
          {item.priority === 1 && item.status !== 'done' && <span style={{ fontSize: 10.5, color: C.accent, border: `1px solid ${C.accent}44`, borderRadius: 999, padding: '1px 7px' }}>{t('high')}</span>}
          {item.meta && item.meta.moura && <WorkBadge />}
          {item.meta && item.meta.external === 'google' && !((item.meta && item.meta.moura)) && <span style={{ fontSize: 10, color: C.blue, border: `1px solid ${C.blue}44`, borderRadius: 999, padding: '1px 7px' }}>Google</span>}
          {item.type === 'document' && item.meta && item.meta.tag && <span style={{ fontSize: 10, color: C.blue, border: `1px solid ${C.blue}44`, borderRadius: 999, padding: '1px 8px' }}>{item.meta.tag}</span>}
          {item.type === 'trip' && item.meta && item.meta.purpose && <span style={{ fontSize: 10, color: item.meta.purpose === 'trabalho' ? C.sky : C.green, border: `1px solid currentColor`, borderRadius: 999, padding: '1px 8px' }}>{item.meta.purpose === 'trabalho' ? (lang === 'pt' ? 'Trabalho' : 'Work') : (lang === 'pt' ? 'Lazer' : 'Leisure')}</span>}
          {item.meta && item.meta.external === 'ticktick' && item.meta.project && <span style={{ fontSize: 10, color: C.violet, border: `1px solid ${C.violet}44`, borderRadius: 999, padding: '1px 7px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>{item.meta.project}</span>}
          {item.meta && item.meta.external === 'ticktick' && <span style={{ fontSize: 10, color: C.green, border: `1px solid ${C.green}44`, borderRadius: 999, padding: '1px 7px' }}>TickTick</span>}
        </div>
      </div>
      {(() => {
        // meta.invitedPeople (novo, vários) ou meta.invitedPersonName (formato antigo, 1 só) — mostra os avatares de quem foi convidado
        const invited = (item.meta && item.meta.invitedPeople) || (item.meta && item.meta.invitedPersonName ? [{ name: item.meta.invitedPersonName, photo: item.meta.invitedPersonPhoto }] : []);
        if (!invited.length) return null;
        return (
          <div style={{ display: 'flex', marginLeft: -6 }}>
            {invited.slice(0, 3).map((p, i) => (
              <div key={p.id || i} title={(lang === 'pt' ? 'Convite enviado: ' : 'Invite sent: ') + p.name} style={{ marginLeft: 6, border: `2px solid ${C.surface}`, borderRadius: 999 }}><Avatar photo={p.photo} name={p.name} size={22} color={C.sky} /></div>
            ))}
          </div>
        );
      })()}
      {onDelete && item.type === 'task' && (
        <button
          onClick={(e) => { e.stopPropagation(); if (confirm(t('deleteConfirmGeneric'))) onDelete(item.id); }}
          title={lang === 'pt' ? 'Excluir' : 'Delete'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, marginTop: -2, color: C.text3, flexShrink: 0 }}
        ><Trash2 size={15} /></button>
      )}
      <ChevronRight size={16} style={{ color: C.text3, marginTop: 2 }} />
    </div>
  );
  if (!swipeable) return row;
  return (
    <SwipeRow
      onRight={() => onToggle(item.id)} rightLabel={item.status === 'done' ? (lang === 'pt' ? 'Reabrir' : 'Reopen') : (lang === 'pt' ? 'Concluir' : 'Done')} rightColor={C.green} rightIcon={CheckCheck}
      onLeft={() => onDelete(item.id)} leftLabel={lang === 'pt' ? 'Excluir' : 'Delete'} leftColor={C.rose} leftIcon={Trash2}
    >
      {row}
    </SwipeRow>
  );
}

/* ---------------- attachments ---------------- */
function AttachThumb({ att, onRemove }) {
  const [d, setD] = useState(null); const [zoom, setZoom] = useState(false);
  useEffect(() => { let m = true; loadAttachment(att.id).then((x) => { if (m) setD(x); }); return () => { m = false; }; }, [att.id]);
  const isImg = att.kind === 'image';
  return (
    <div style={{ position: 'relative' }}>
      <div onClick={() => { if (isImg) setZoom(true); else if (d) { const a = document.createElement('a'); a.href = d.dataUrl; a.download = att.name || 'file.pdf'; a.click(); } }} style={{ width: 66, height: 66, borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden', cursor: 'pointer', background: C.bg2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {isImg && d ? <img src={d.dataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <FileText size={22} style={{ color: C.text3 }} />}
      </div>
      {onRemove && <button onClick={() => onRemove(att.id)} style={{ position: 'absolute', top: -6, right: -6, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 999, width: 20, height: 20, color: C.rose, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>}
      {zoom && d && <div onClick={() => setZoom(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.92)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}><img src={d.dataUrl} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} /></div>}
    </div>
  );
}
function Attachments({ list, lang, t, onAddMany, onRemove }) {
  const ref = useRef(); const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const files = Array.from(e.target.files || []); if (!files.length) return; setBusy(true);
    const newAtts = [];
    for (const f of files) {
      try { const url = await fileToDataUrl(f); const att = await saveAttachment(url, f.name, f.type.startsWith('image/') ? 'image' : 'pdf'); if (att) newAtts.push(att); } catch (err) {}
    }
    if (newAtts.length) onAddMany(newAtts);
    setBusy(false); e.target.value = '';
  };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{t('attachments')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {(list || []).map((a) => <AttachThumb key={a.id} att={a} onRemove={onRemove} />)}
        <button onClick={() => ref.current && ref.current.click()} style={{ width: 66, height: 66, borderRadius: 10, border: `1px dashed ${C.border}`, background: 'transparent', color: C.text3, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10 }}>{busy ? <Loader2 size={18} className="spin" /> : <><Paperclip size={16} />{t('addFile')}</>}</button>
        <input ref={ref} type="file" accept="image/*,application/pdf" multiple onChange={pick} style={{ display: 'none' }} />
      </div>
    </div>
  );
}

/* ---------------- photo avatar ---------------- */
function PhotoCropper({ src, onCancel, onSave }) {
  const [scale, setScale] = useState(1); const [pos, setPos] = useState({ x: 0, y: 0 });
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const drag = useRef(null); const imgRef = useRef(null); const BOX = 240;
  const onDown = (e) => { const p = e.touches ? e.touches[0] : e; drag.current = { sx: p.clientX, sy: p.clientY, ox: pos.x, oy: pos.y }; };
  const onMove = (e) => { if (!drag.current) return; const p = e.touches ? e.touches[0] : e; setPos({ x: drag.current.ox + (p.clientX - drag.current.sx), y: drag.current.oy + (p.clientY - drag.current.sy) }); };
  const onUp = () => { drag.current = null; };
  // dimensão "cover" base (a imagem preenche o círculo em scale=1)
  const base = nat.w && nat.h ? Math.max(BOX / nat.w, BOX / nat.h) : 1;
  const dispW = nat.w * base * scale, dispH = nat.h * base * scale;
  const doSave = () => {
    const img = imgRef.current; if (!img || !nat.w) { setTimeout(doSave, 100); return; }
    const out = 320; const k = out / BOX;
    const canvas = document.createElement('canvas'); canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#131B2A'; ctx.fillRect(0, 0, out, out);
    ctx.save();
    ctx.beginPath(); ctx.arc(out / 2, out / 2, out / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    // replica exatamente a preview: imagem centrada + deslocada por pos, dimensão dispW/dispH
    const drawW = dispW * k, drawH = dispH * k;
    const cx = out / 2 + pos.x * k, cy = out / 2 + pos.y * k;
    ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    ctx.restore();
    try { const url = canvas.toDataURL('image/jpeg', 0.9); onSave(url && url.length > 100 ? url : src); }
    catch (e) { onSave(src); }
  };
  return (
    <Modal onClose={onCancel}>
      <SheetHead title="Ajustar foto" onClose={onCancel} icon={Camera} />
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <div style={{ width: BOX, height: BOX, borderRadius: 999, overflow: 'hidden', position: 'relative', background: '#000', touchAction: 'none', cursor: 'grab', border: `2px solid ${C.accent}` }}
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}>
          <img ref={imgRef} src={src} alt="" draggable={false} onLoad={(e) => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })} style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`, width: dispW || '100%', height: dispH || '100%', maxWidth: 'none', userSelect: 'none' }} />
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}><span>Zoom</span><span style={{ color: C.text3 }}>{Math.round(scale * 100)}%</span></div>
      <input type="range" min="0.5" max="3" step="0.02" value={scale} onChange={(e) => setScale(Number(e.target.value))} style={{ width: '100%', accentColor: C.accent, marginBottom: 6 }} />
      <div style={{ fontSize: 11, color: C.text3, marginBottom: 16, textAlign: 'center' }}>Arraste para centralizar. Diminua o zoom para caber mais, aumente para focar.</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="ghost" onClick={onCancel} style={{ flex: 1 }}>Cancelar</Btn>
        <Btn onClick={doSave} style={{ flex: 1.4 }}>Salvar foto</Btn>
      </div>
    </Modal>
  );
}
function PhotoPicker({ value, t, onChange }) {
  const ref = useRef(); const [busy, setBusy] = useState(false); const [cropSrc, setCropSrc] = useState(null);
  const pick = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCropSrc(String(reader.result));
    reader.readAsDataURL(f);
    e.target.value = '';
  };
  const saveCropped = async (dataUrl) => {
    setBusy(true); setCropSrc(null);
    try { const att = await saveAttachment(dataUrl, 'foto.jpg', 'image'); if (att) onChange(att); } catch (err) {}
    setBusy(false);
  };
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {value ? <AttachThumb att={value} onRemove={() => onChange(null)} />
        : <button onClick={() => ref.current && ref.current.click()} style={{ width: 66, height: 66, borderRadius: 999, border: `1px dashed ${C.border}`, background: 'transparent', color: C.text3, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10 }}>{busy ? <Loader2 size={16} className="spin" /> : <><Camera size={16} />{t('addPhoto')}</>}</button>}
      <input ref={ref} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
      {cropSrc && <PhotoCropper src={cropSrc} onCancel={() => setCropSrc(null)} onSave={saveCropped} />}
    </div>
  );
}

function Avatar({ photo, name, size = 42, color = C.sky }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { let m = true; if (photo && photo.id) loadAttachment(photo.id).then((x) => { if (m && x) setSrc(x.dataUrl); }); return () => { m = false; }; }, [photo && photo.id]);
  return (
    <div style={{ width: size, height: size, borderRadius: 999, background: color + '22', color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.34, fontWeight: 700, flexShrink: 0, overflow: 'hidden' }}>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(name)}
    </div>
  );
}

/* ---------------- unified item form ---------------- */
function AddressAutocomplete({ value, onChange, lang }) {
  const [q, setQ] = useState(value || ''); const [opts, setOpts] = useState([]); const [open, setOpen] = useState(false);
  const timer = useRef();
  useEffect(() => { setQ(value || ''); }, [value]);
  const search = (text) => {
    clearTimeout(timer.current);
    if (!text || text.length < 4) { setOpts([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=br&limit=5&q=${encodeURIComponent(text)}`, { headers: { 'Accept-Language': 'pt-BR' } });
        const j = await r.json();
        setOpts(j || []); setOpen(true);
      } catch (e) { setOpts([]); }
    }, 450);
  };
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={(e) => { setQ(e.target.value); onChange(e.target.value); search(e.target.value); }} onFocus={() => opts.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} style={inputStyle} placeholder={lang === 'pt' ? 'Comece a digitar o endereço...' : 'Start typing address...'} />
      {open && opts.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, marginTop: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
          {opts.map((o, i) => (
            <div key={i} onMouseDown={() => { setQ(o.display_name); onChange(o.display_name); setOpen(false); }} style={{ padding: '9px 12px', fontSize: 12.5, cursor: 'pointer', borderBottom: i < opts.length - 1 ? `1px solid ${C.borderSoft}` : 'none', color: C.text }}>{o.display_name}</div>
          ))}
        </div>
      )}
    </div>
  );
}
function ItemForm({ draft, allowedTypes, lang, t, people = [], accounts = [], onSave, onCancel, onDelete }) {
  const [f, setF] = useState({ priority: 2, status: 'planned', ...draft, meta: { ...(draft.meta || {}) } });
  const [fcode, setFcode] = useState('');
  const [resolving, setResolving] = useState(false); const [resolveMsg, setResolveMsg] = useState('');
  const [mealEstimating, setMealEstimating] = useState(false);
  const up = (patch) => setF((p) => ({ ...p, ...patch }));
  const upMeta = (patch) => setF((p) => ({ ...p, meta: { ...p.meta, ...patch } }));
  const type = f.type; const metaFields = META[type] || []; const attList = f.meta.attachments || [];
  const canSave = (f.title || '').trim() || (type === 'flight' && f.meta.from) || (type === 'vehicle' && (f.meta.make || f.meta.plate)) || (type === 'person' && f.title);
  const doSave = () => {
    let title = (f.title || '').trim();
    if (!title && type === 'flight') title = `${f.meta.from || ''} → ${f.meta.to || ''}`.trim();
    if (!title && type === 'vehicle') title = `${f.meta.make || ''} ${f.meta.model || ''}`.trim();
    if (!title && type === 'trip') title = f.meta.destination || 'Trip';
    const match = people.find((p) => p.title.toLowerCase() === (f.person || '').toLowerCase());
    onSave({ ...f, title: title || t('t_' + type), person: f.person || null, meta: { ...f.meta, personId: match ? match.id : (f.meta.personId || null) }, amount: isMoney(type) ? (f.amount == null || f.amount === '' ? null : Number(f.amount)) : (f.amount ?? null) });
  };
  const doResolve = async () => {
    if (!fcode.trim()) return;
    setResolving(true); setResolveMsg('');
    // fallback local imediato (companhia pelo prefixo)
    const local = resolveFlight(fcode);
    if (local) upMeta({ airline: local.airline, flightNumber: local.flightNumber });
    try {
      const r = await authFetch('/api/flight?flight=' + encodeURIComponent(fcode.trim()) + (f.date ? '&date=' + f.date : ''));
      const j = await r.json();
      if (j.flight) {
        const fl = j.flight;
        upMeta({
          airline: fl.airline || (local && local.airline) || '',
          flightNumber: fl.flightNumber || (local && local.flightNumber) || fcode.trim().toUpperCase(),
          from: fl.depIata || undefined, to: fl.arrIata || undefined,
          aircraft: fl.aircraft || undefined, aircraftReg: fl.aircraftReg || undefined,
          depAirport: fl.depAirport, arrAirport: fl.arrAirport,
          depTerminal: fl.depTerminal, depGate: fl.depGate,
          arrTerminal: fl.arrTerminal, arrGate: fl.arrGate,
          depTime: fl.depTime, arrTime: fl.arrTime, status: fl.status,
        });
        setResolveMsg(lang === 'pt' ? '✓ Voo encontrado' : '✓ Found');
      } else if (j.configured === false) {
        setResolveMsg(lang === 'pt' ? 'Busca automática não configurada — preencha manualmente.' : 'Auto lookup not set up.');
      } else {
        setResolveMsg(lang === 'pt' ? 'Voo não encontrado — preencha manualmente.' : 'Not found.');
      }
    } catch (e) { setResolveMsg(lang === 'pt' ? 'Erro na busca.' : 'Lookup error.'); }
    setResolving(false);
  };
  const doEstimateMeal = async () => {
    if (!(f.title || '').trim()) return;
    setMealEstimating(true);
    try {
      const est = await estimateMealFromText(f.title, lang);
      upMeta({ calories: est.calories, proteinG: est.proteinG, carbsG: est.carbsG, fatG: est.fatG });
    } catch (e) {}
    setMealEstimating(false);
  };
  return (
    <div>
      {allowedTypes.length > 1 && <Field label={t('type')}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{allowedTypes.map((ty) => <Chip key={ty} active={type === ty} onClick={() => up({ type: ty })}>{t('t_' + ty)}</Chip>)}</div></Field>}
      {type === 'flight' && (
        <div style={{ ...card, padding: 12, marginBottom: 12, background: C.bg2 }}>
          <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{t('flightCode')}</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}><input value={fcode} onChange={(e) => setFcode(e.target.value)} placeholder="LA 3414" style={inputStyle} /><Btn kind="soft" onClick={doResolve} disabled={resolving} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{resolving ? <Loader2 size={14} className="spin" /> : <Search size={14} />}{t('resolve')}</Btn></div>
          <div style={{ fontSize: 10.5, color: C.text3, marginBottom: 4 }}>{lang === 'pt' ? 'Data do voo (melhora a busca da aeronave e horário)' : 'Flight date'}</div>
          <input type="date" value={f.date || ''} onChange={(e) => up({ date: e.target.value })} style={{ ...inputStyle, colorScheme: 'dark', width: '100%', maxWidth: '100%', boxSizing: 'border-box', WebkitAppearance: 'none' }} />
          {resolveMsg && <div style={{ fontSize: 11.5, color: resolveMsg.startsWith('✓') ? C.green : C.text3, marginTop: 7 }}>{resolveMsg}</div>}
          {f.meta.aircraft && <div style={{ fontSize: 12, color: C.text2, marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}><Plane size={13} style={{ color: C.violet }} />{lang === 'pt' ? 'Aeronave' : 'Aircraft'}: <b>{f.meta.aircraft}</b>{f.meta.aircraftReg ? ` (${f.meta.aircraftReg})` : ''}</div>}
          {f.meta.depTime && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 4 }}>{lang === 'pt' ? 'Partida' : 'Departure'}: {new Date(f.meta.depTime).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{f.meta.arrTime ? ` → ${new Date(f.meta.arrTime).toLocaleTimeString(lang === 'pt' ? 'pt-BR' : 'en', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>}
          {(f.meta.depGate || f.meta.depTerminal) && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 4 }}>{lang === 'pt' ? 'Embarque' : 'Departure'}: {f.meta.depTerminal ? `T${f.meta.depTerminal}` : ''}{f.meta.depGate ? ` · Portão ${f.meta.depGate}` : ''}</div>}
          <div style={{ fontSize: 11, color: C.text3, marginTop: 7, lineHeight: 1.45 }}>{t('flightHint')}</div>
        </div>
      )}
      {type === 'trip' && (
        <div style={{ ...card, padding: 12, marginBottom: 12, background: C.bg2 }}>
          <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center' }}><Users size={13} />{lang === 'pt' ? 'Quem vai nesta viagem' : 'Who is traveling'}</div>
          {people.length === 0 ? (
            <div style={{ fontSize: 11.5, color: C.text3, lineHeight: 1.5 }}>{lang === 'pt' ? 'Você ainda não cadastrou pessoas. Adicione familiares na aba Painel → Pessoas e eles aparecerão aqui para você vincular à viagem.' : 'No people yet. Add them in Dashboard → People.'}</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {people.map((p) => {
                  const sel = (f.meta.travelers || []).includes(p.id);
                  return <Chip key={p.id} active={sel} onClick={() => { const cur = f.meta.travelers || []; upMeta({ travelers: sel ? cur.filter((x) => x !== p.id) : [...cur, p.id] }); }}>{p.title}</Chip>;
                })}
              </div>
              <div style={{ fontSize: 11, color: C.text3, marginTop: 8, lineHeight: 1.45 }}>{lang === 'pt' ? 'Os selecionados ficam vinculados à viagem — cartões de embarque, reservas e documentos aparecem conectados.' : 'Selected people are linked to this trip.'}</div>
            </>
          )}
        </div>
      )}
      {type === 'vehicle' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={t('plate')}><input value={f.meta.plate || ''} onChange={(e) => upMeta({ plate: e.target.value.toUpperCase() })} style={inputStyle} placeholder="ABC1D23" /></Field>
            <Field label={t('renavam')}><input value={f.meta.renavam || ''} onChange={(e) => upMeta({ renavam: e.target.value })} style={inputStyle} /></Field>
          </div>
          <div style={{ fontSize: 11, color: C.text3, margin: '-4px 2px 10px', lineHeight: 1.45 }}>{t('plateHint')}</div>
        </>
      )}
      {type === 'message' && (
        <Field label={t('channel')}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{Object.entries(CHANNELS).map(([ck, cv]) => <Chip key={ck} active={f.meta.channel === ck} onClick={() => upMeta({ channel: ck })} color={cv.color}>{cv.label}</Chip>)}</div></Field>
      )}
      {type === 'account' && (
        <Field label={t('kind')}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{ACCOUNT_KINDS.map(([kk, ptn, enn]) => <Chip key={kk} active={f.meta.kind === kk} onClick={() => upMeta({ kind: kk })}>{lang === 'pt' ? ptn : enn}</Chip>)}</div></Field>
      )}
      {type === 'account' && (
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><Field label={lang === 'pt' ? 'Saldo inicial' : 'Initial balance'}><input type="number" step="0.01" value={f.meta.balance ?? ''} onChange={(e) => upMeta({ balance: e.target.value === '' ? null : Number(e.target.value) })} style={inputStyle} placeholder="0,00" /></Field></div>
          <div style={{ flex: 1 }}><Field label={lang === 'pt' ? 'Data inicial' : 'Start date'}><input type="date" value={f.meta.startDate || ''} onChange={(e) => upMeta({ startDate: e.target.value || null })} style={{ ...inputStyle, colorScheme: _theme === 'light' ? 'light' : 'dark' }} /></Field></div>
        </div>
      )}
      {type === 'account' && <div style={{ fontSize: 11, color: C.text3, marginTop: -4, marginBottom: 10, lineHeight: 1.4 }}>{lang === 'pt' ? 'O saldo inicial é o ponto de partida. As transações importadas depois somam/subtraem sobre ele. A data inicial ajuda o Claude a entender a linha do tempo do extrato.' : 'Initial balance is the starting point; imported transactions adjust it.'}</div>}
      {['expense', 'income', 'bill'].includes(type) && (
        <>
          {accounts.length > 0 && <Field label={t('accountL')}><select value={f.meta.accountId || ''} onChange={(e) => upMeta({ accountId: e.target.value || null })} style={{ ...inputStyle, colorScheme: 'dark' }}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</select></Field>}
          <Field label={t('categoryL')}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{CAT_KEYS.filter((k) => type === 'income' ? ['salario', 'investimento', 'outros'].includes(k) : k !== 'salario').map((k) => { const cc = CATEGORIES[k]; return <Chip key={k} active={(f.meta.category || deriveCat(f)) === k} onClick={() => upMeta({ category: k })} color={cc.color}>{cc[lang]}</Chip>; })}</div></Field>
        </>
      )}
      <Field label={type === 'person' ? t('name') : type === 'message' ? t('title') : t('title')}><input value={f.title || ''} onChange={(e) => up({ title: e.target.value })} style={inputStyle} placeholder={type === 'flight' ? 'GRU → LIS' : ''} /></Field>
      {type === 'task' && (
        <Field label={t('priorityL')}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Chip active={f.priority === 1} onClick={() => up({ priority: 1 })} color={C.accent}>⭐ {t('important')}</Chip>
            <Chip active={f.priority === 2} onClick={() => up({ priority: 2 })}>{t('prNormal')}</Chip>
            <Chip active={f.priority === 3} onClick={() => up({ priority: 3 })}>{t('prLow')}</Chip>
          </div>
        </Field>
      )}
      {type === 'task' && (
        <div onClick={() => up({ domain: f.domain === 'work' ? 'personal' : 'work', meta: { ...f.meta, moura: f.domain !== 'work' } })} style={{ ...card, padding: '11px 13px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <div style={{ width: 40, height: 24, borderRadius: 999, background: f.domain === 'work' ? C.sky : C.surface2, position: 'relative', flexShrink: 0 }}>
            <span style={{ position: 'absolute', top: 3, left: f.domain === 'work' ? 19 : 3, width: 18, height: 18, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {f.domain === 'work' && <WorkBadge size={13} />}
            <span style={{ fontSize: 13, color: C.text }}>{lang === 'pt' ? 'É uma tarefa de trabalho?' : 'Work task?'}</span>
          </div>
        </div>
      )}
      {type === 'task' && (
        <Field label={lang === 'pt' ? 'Lista (TickTick)' : 'List (TickTick)'}><input value={f.meta.project || ''} onChange={(e) => upMeta({ project: e.target.value })} style={inputStyle} placeholder={lang === 'pt' ? 'Ex: Casa, Projetos...' : 'e.g. Home, Projects...'} /></Field>
      )}
      {type === 'task' && people.length > 0 && (
        <Field label={lang === 'pt' ? 'Pessoas envolvidas' : 'Involved people'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {people.map((p) => {
              const ids = (f.meta.peopleIds || []);
              const on = ids.includes(p.id);
              return <Chip key={p.id} active={on} onClick={() => upMeta({ peopleIds: on ? ids.filter((x) => x !== p.id) : [...ids, p.id] })}>{p.title}</Chip>;
            })}
          </div>
        </Field>
      )}
      {!['person', 'account', 'message'].includes(type) && (
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><Field label={t('date')}><input type="date" value={f.date || ''} onChange={(e) => up({ date: e.target.value || null })} style={{ ...inputStyle, colorScheme: 'dark' }} /></Field></div>
          <div style={{ flex: 1 }}><Field label={t('time')}><input type="time" value={f.time || ''} onChange={(e) => up({ time: e.target.value || null })} style={{ ...inputStyle, colorScheme: 'dark' }} /></Field></div>
        </div>
      )}
      {(type === 'event' || type === 'appointment') && people.length > 0 && (
        <Field label={lang === 'pt' ? 'Convidar (envia convite de verdade por e-mail)' : 'Invite (sends a real calendar invite by email)'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {people.map((p) => {
              const ids = f.meta.inviteePersonIds || [];
              const on = ids.includes(p.id);
              const already = (f.meta.invitedPersonIds || []).includes(p.id);
              return <Chip key={p.id} active={on} onClick={() => upMeta({ inviteePersonIds: on ? ids.filter((x) => x !== p.id) : [...ids, p.id] })}>{p.title}{already ? ' ✓' : ''}</Chip>;
            })}
          </div>
          {(f.meta.inviteePersonIds || []).length > 0 && <div style={{ fontSize: 10.5, color: C.text3, marginTop: 6 }}>{lang === 'pt' ? '✓ = já foi convidado antes' : '✓ = already invited'}</div>}
        </Field>
      )}
      {isMoney(type) && <Field label={type === 'maintenance' ? t('cost') : t('amount')}><input type="number" value={f.amount ?? ''} onChange={(e) => up({ amount: e.target.value })} style={inputStyle} placeholder="0,00" /></Field>}
      {type === 'meal' && (
        <Btn kind="soft" onClick={doEstimateMeal} disabled={mealEstimating || !(f.title || '').trim()} style={{ width: '100%', marginBottom: 12, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}>
          {mealEstimating ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{mealEstimating ? (lang === 'pt' ? 'Consultando...' : 'Estimating...') : (lang === 'pt' ? 'Estimar calorias com IA' : 'Estimate calories with AI')}
        </Btn>
      )}
      {metaFields.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {metaFields.map(([k, ptL, enL, it]) => {
            const OPTS = {
              relationship: lang === 'pt' ? ['', 'Eu mesmo', 'Cônjuge', 'Filho', 'Filha', 'Pai', 'Mãe', 'Irmão', 'Irmã', 'Avô', 'Avó', 'Primo(a)', 'Tio(a)', 'Terceiro'] : ['', 'Myself', 'Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Grandfather', 'Grandmother', 'Cousin', 'Uncle/Aunt', 'Other'],
              role: lang === 'pt' ? ['', 'Usuário', 'Médico', 'Babá', 'Empregada', 'Motorista', 'Porteiro', 'Outro'] : ['', 'User', 'Doctor', 'Nanny', 'Housekeeper', 'Driver', 'Doorman', 'Other'],
            };
            if (OPTS[k]) {
              return <div key={k} style={{ gridColumn: type === 'message' ? '1 / -1' : 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><select value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: e.target.value })} style={{ ...inputStyle, colorScheme: _theme === 'light' ? 'light' : 'dark', appearance: 'none', WebkitAppearance: 'none' }}>{OPTS[k].map((o) => <option key={o} value={o}>{o || (lang === 'pt' ? '— selecione —' : '— select —')}</option>)}</select></Field></div>;
            }
            if (k === 'purpose' && type === 'trip') {
              return <div key={k} style={{ gridColumn: 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><div style={{ display: 'flex', gap: 6 }}>{['trabalho', 'lazer'].map((s) => <Chip key={s} active={f.meta.purpose === s} onClick={() => upMeta({ purpose: s })} color={s === 'trabalho' ? C.sky : C.green}>{lang === 'pt' ? (s === 'trabalho' ? 'Trabalho' : 'Lazer') : (s === 'trabalho' ? 'Work' : 'Leisure')}</Chip>)}</div></Field></div>;
            }
            if (k === 'tracking' && type === 'purchase') {
              return (
                <React.Fragment key="purchase-tracking-acc">
                  <div><Field label={lang === 'pt' ? ptL : enL}><input value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: e.target.value })} style={inputStyle} /></Field></div>
                  {accounts.length > 0 && <div><Field label={lang === 'pt' ? 'Pago com' : 'Paid with'}><select value={f.meta.accountId || ''} onChange={(e) => upMeta({ accountId: e.target.value || null })} style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none' }}>
                    <option value="">{lang === 'pt' ? '— não vinculado —' : '— not linked —'}</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                  </select></Field></div>}
                </React.Fragment>
              );
            }
            if (k === 'mealType' && type === 'meal') {
              return <div key={k} style={{ gridColumn: '1 / -1' }}><Field label={lang === 'pt' ? ptL : enL}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{MEAL_TYPES.map(([mk, ptn, enn, Ic, col]) => <Chip key={mk} active={(f.meta.mealType || guessMealType(f.time)) === mk} onClick={() => upMeta({ mealType: mk })} color={col}><span style={{ display: 'flex', gap: 5, alignItems: 'center' }}><Ic size={12} />{lang === 'pt' ? ptn : enn}</span></Chip>)}</div></Field></div>;
            }
            if (k === 'status' && type === 'condition') {
              return <div key={k} style={{ gridColumn: 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><div style={{ display: 'flex', gap: 6 }}>{['ativa', 'resolvida'].map((s) => <Chip key={s} active={f.meta.status === s} onClick={() => upMeta({ status: s })} color={s === 'ativa' ? C.rose : C.green}>{lang === 'pt' ? (s === 'ativa' ? 'Ativa' : 'Resolvida') : (s === 'ativa' ? 'Active' : 'Resolved')}</Chip>)}</div></Field></div>;
            }
            if (k === 'severity' && type === 'allergy') {
              return <div key={k} style={{ gridColumn: 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{['leve', 'moderada', 'grave'].map((s) => <Chip key={s} active={f.meta.severity === s} onClick={() => upMeta({ severity: s })} color={s === 'grave' ? C.rose : s === 'moderada' ? C.accent : C.text2}>{lang === 'pt' ? s : s}</Chip>)}</div></Field></div>;
            }
            if (k === 'prescribedBy' && type === 'medication' && people.some((p) => p.meta && /m[ée]dic/i.test(p.meta.role || ''))) {
              const docs = people.filter((p) => p.meta && /m[ée]dic/i.test(p.meta.role || ''));
              return <div key={k} style={{ gridColumn: 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><select value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: e.target.value })} style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none' }}>
                <option value="">{lang === 'pt' ? '— selecione —' : '— select —'}</option>
                {docs.map((p) => <option key={p.id} value={p.title}>{p.title}</option>)}
              </select></Field></div>;
            }
            if (k === 'holder' && type === 'document') {
              return <div key={k} style={{ gridColumn: 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><select value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: e.target.value })} style={{ ...inputStyle, colorScheme: _theme === 'light' ? 'light' : 'dark', appearance: 'none', WebkitAppearance: 'none' }}>
                <option value="">{lang === 'pt' ? '— selecione —' : '— select —'}</option>
                {people.map((p) => <option key={p.id} value={p.title}>{p.title}</option>)}
              </select></Field></div>;
            }
            if (k === 'address') {
              if (!f.meta.phones && f.meta.phone) upMeta({ phones: [f.meta.phone] });
              if (!f.meta.emails && f.meta.email) upMeta({ emails: [f.meta.email] });
              const phones = f.meta.phones || (f.meta.phone ? [f.meta.phone] : ['']);
              const emails = f.meta.emails || (f.meta.email ? [f.meta.email] : ['']);
              const fmtPhone = (v) => {
                const d = String(v).replace(/\D/g, '').slice(0, 13);
                let n = d; if (!n.startsWith('55')) n = '55' + n;
                const ddd = n.slice(2, 4), p1 = n.slice(4, 9), p2 = n.slice(9, 13);
                let out = '+55'; if (ddd) out += ` (${ddd}`; if (ddd.length === 2) out += ')'; if (p1) out += ` ${p1}`; if (p2) out += `-${p2}`;
                return out;
              };
              return (
                <React.Fragment key="contacts">
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Field label={lang === 'pt' ? 'Telefones' : 'Phones'}>
                      {phones.map((ph, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                          <input type="tel" value={ph} onChange={(e) => { const arr = [...phones]; arr[idx] = fmtPhone(e.target.value); upMeta({ phones: arr }); }} placeholder="+55 (11) 99999-9999" style={inputStyle} />
                          {phones.length > 1 && <button onClick={() => upMeta({ phones: phones.filter((_, i) => i !== idx) })} style={{ background: 'none', border: 'none', color: C.rose, cursor: 'pointer', padding: '0 6px' }}><X size={16} /></button>}
                        </div>
                      ))}
                      <button onClick={() => upMeta({ phones: [...phones, ''] })} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', padding: '2px 0' }}><Plus size={13} />{lang === 'pt' ? 'Adicionar telefone' : 'Add phone'}</button>
                    </Field>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Field label={lang === 'pt' ? 'E-mails' : 'Emails'}>
                      {emails.map((em, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                          <input type="email" value={em} onChange={(e) => { const arr = [...emails]; arr[idx] = e.target.value; upMeta({ emails: arr }); }} placeholder="nome@email.com" style={inputStyle} />
                          {emails.length > 1 && <button onClick={() => upMeta({ emails: emails.filter((_, i) => i !== idx) })} style={{ background: 'none', border: 'none', color: C.rose, cursor: 'pointer', padding: '0 6px' }}><X size={16} /></button>}
                        </div>
                      ))}
                      <button onClick={() => upMeta({ emails: [...emails, ''] })} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', padding: '2px 0' }}><Plus size={13} />{lang === 'pt' ? 'Adicionar e-mail' : 'Add email'}</button>
                    </Field>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}><Field label={lang === 'pt' ? ptL : enL}><AddressAutocomplete value={f.meta[k] ?? ''} onChange={(v) => upMeta({ [k]: v })} lang={lang} /></Field></div>
                </React.Fragment>
              );
            }
            if (k === 'phone') {
              const fmtPhone = (v) => {
                const d = String(v).replace(/\D/g, '').slice(0, 13);
                let n = d; if (!n.startsWith('55')) n = '55' + n;
                const ddd = n.slice(2, 4), p1 = n.slice(4, 9), p2 = n.slice(9, 13);
                let out = '+55'; if (ddd) out += ` (${ddd}`; if (ddd.length === 2) out += ')'; if (p1) out += ` ${p1}`; if (p2) out += `-${p2}`;
                return out;
              };
              return <div key={k} style={{ gridColumn: 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><input type="tel" value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: fmtPhone(e.target.value) })} placeholder="+55 (11) 99999-9999" style={{ ...inputStyle, colorScheme: _theme === 'light' ? 'light' : 'dark' }} /></Field></div>;
            }
            return <div key={k} style={{ gridColumn: type === 'message' ? '1 / -1' : 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><input type={it === 'number' ? 'number' : it === 'date' ? 'date' : 'text'} value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: e.target.value })} placeholder={k === 'tag' ? (lang === 'pt' ? 'Ex: Exame de sangue, Bruno...' : 'e.g. Blood test, Bruno...') : undefined} style={{ ...inputStyle, colorScheme: _theme === 'light' ? 'light' : 'dark' }} /></Field></div>;
          })}
        </div>
      )}
      {(type === 'person' || type === 'vehicle' || type === 'gift' || type === 'shopping') && (
        <Field label={t('photo')}>
          <PhotoPicker value={f.meta.photo} t={t} onChange={(att) => upMeta({ photo: att })} />
        </Field>
      )}
      {(type === 'gift' || type === 'shopping') && (
        <>
          <Field label={t('giftLink')}><input value={f.meta.link || ''} onChange={(e) => upMeta({ link: e.target.value })} placeholder="https://..." style={inputStyle} /></Field>
          <Field label={t('giftPrice')}><input type="number" step="0.01" value={f.amount || ''} onChange={(e) => setF((p) => ({ ...p, amount: Number(e.target.value) }))} style={inputStyle} /></Field>
        </>
      )}
      {type === 'purchase' && (
        <Field label={lang === 'pt' ? 'Status' : 'Status'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['paid', 'shipped', 'delivered'].map((s) => <Chip key={s} active={f.meta.stage === s} onClick={() => upMeta({ stage: s, deliveredDate: s === 'delivered' ? (f.meta.deliveredDate || todayISO()) : f.meta.deliveredDate })}>{PURCHASE_STAGES[s][lang]}</Chip>)}
          </div>
        </Field>
      )}
      {type === 'document' && (
        <Field label={lang === 'pt' ? 'Categoria' : 'Category'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['work', 'Trabalho', 'Work'], ['health', 'Saúde', 'Health'], ['personal', 'Pessoais', 'Personal'], ['kids', 'Filhos', 'Kids']].map(([k, ptL, enL]) => (
              <Chip key={k} active={f.domain === k} onClick={() => up({ domain: k })}>{lang === 'pt' ? ptL : enL}</Chip>
            ))}
          </div>
        </Field>
      )}
      {type === 'document' && f.domain === 'health' && (
        <div onClick={() => upMeta({ isExam: !f.meta.isExam })} style={{ ...card, padding: '11px 13px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <div style={{ width: 40, height: 24, borderRadius: 999, background: f.meta.isExam ? C.green : C.surface2, position: 'relative', flexShrink: 0 }}>
            <span style={{ position: 'absolute', top: 3, left: f.meta.isExam ? 19 : 3, width: 18, height: 18, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{lang === 'pt' ? 'É um exame médico' : 'Medical exam'}</div>
            <div style={{ fontSize: 11, color: C.text3, marginTop: 1 }}>{lang === 'pt' ? 'Marque para o Dr. Claude analisar os indicadores' : 'Mark so Dr. Claude analyzes it'}</div>
          </div>
        </div>
      )}
      {type === 'vehicle' && (
        <Field label={t('color')}><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{CAR_COLORS.map(([hex, ptn, enn]) => <button key={hex} onClick={() => upMeta({ color: hex })} title={lang === 'pt' ? ptn : enn} style={{ width: 30, height: 30, borderRadius: 8, background: hex, cursor: 'pointer', border: f.meta.color === hex ? `2px solid ${C.accent}` : `1px solid ${C.border}` }} />)}</div></Field>
      )}
      {type === 'account' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, cursor: 'pointer' }} onClick={() => upMeta({ showOnToday: !f.meta.showOnToday })}>
          <div style={{ color: f.meta.showOnToday ? C.green : C.text3 }}>{f.meta.showOnToday ? <CircleCheck size={20} /> : <Circle size={20} />}</div>
          <span style={{ fontSize: 13.5 }}>{t('showOnToday')}</span>
        </label>
      )}
      {isMilestoneType(type) && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, cursor: 'pointer' }} onClick={() => upMeta({ milestone: !f.meta.milestone })}>
          <div style={{ color: f.meta.milestone ? C.accent : C.text3 }}>{f.meta.milestone ? <Star size={20} fill={C.accent} /> : <Star size={20} />}</div>
          <div><div style={{ fontSize: 13.5 }}>{lang === 'pt' ? 'Marcar como importante ⭐' : 'Mark as important'}</div><div style={{ fontSize: 11, color: C.text3, marginTop: 1 }}>{lang === 'pt' ? 'Fixa este item em destaque no topo da aba Hoje (seção “Longo prazo”)' : 'Pins to Today highlights'}</div></div>
        </label>
      )}
      {!['note', 'person', 'account', 'vehicle', 'message', 'document'].includes(type) && (
        <Field label={t('person')}>
          <input list="lcc-people" value={f.person || ''} onChange={(e) => up({ person: e.target.value || null })} style={inputStyle} />
          <datalist id="lcc-people">{people.map((p) => <option key={p.id} value={p.title} />)}</datalist>
        </Field>
      )}
      <Field label={type === 'message' ? t('body') : t('notes')}><textarea value={f.notes || ''} onChange={(e) => up({ notes: e.target.value })} rows={type === 'message' ? 3 : 2} style={{ ...inputStyle, resize: 'none' }} /></Field>
      <Attachments list={attList} lang={lang} t={t} onAddMany={(arr) => upMeta({ attachments: [...attList, ...arr] })} onRemove={(id) => upMeta({ attachments: attList.filter((x) => x.id !== id) })} />
      {onDelete && f.type === 'task' && <Btn kind="soft" onClick={() => up({ status: f.status === 'done' ? 'planned' : 'done' })} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}>{f.status === 'done' ? <><Circle size={15} />{t('markUndone')}</> : <><CircleCheck size={15} />{t('markDone')}</>}</Btn>}
      <div style={{ display: 'flex', gap: 8 }}>
        {onDelete && <Btn kind="danger" onClick={onDelete}><Trash2 size={15} /></Btn>}
        <Btn kind="ghost" onClick={onCancel} style={{ flex: 1 }}>{t('cancel')}</Btn>
        <Btn onClick={doSave} disabled={!canSave} style={{ flex: 1.4 }}>{t('save')}</Btn>
      </div>
    </div>
  );
}
function AddModal({ title, icon, draft, allowedTypes, lang, t, people, accounts = [], onClose, onSave, extraToggle }) {
  return <Modal onClose={onClose}><SheetHead title={title} onClose={onClose} icon={icon} /><ItemForm draft={draft} allowedTypes={allowedTypes} lang={lang} t={t} people={people} accounts={accounts} onCancel={onClose} onSave={onSave} extraToggle={extraToggle} /></Modal>;
}

/* ---------------- capture ---------------- */
function DraftReview({ drafts, lang, t, onDone, onCancel }) {
  const [rows, setRows] = useState(drafts.map((d) => ({ ...d, include: true })));
  const upd = (i, patch) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const included = rows.filter((r) => r.include).map(({ include, confidence, ...x }) => x);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Sparkles size={12} style={{ color: C.accent }} />{t('suggested')}</div>
      {rows.map((r, i) => (
        <div key={i} style={{ ...card, padding: 12, marginBottom: 8, opacity: r.include ? 1 : 0.45 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <button onClick={() => upd(i, { include: !r.include })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: r.include ? C.green : C.text3 }}>{r.include ? <CircleCheck size={19} /> : <Circle size={19} />}</button>
            <input value={r.title} onChange={(e) => upd(i, { title: e.target.value })} style={{ ...inputStyle, padding: '7px 9px', fontSize: 13.5 }} />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select value={r.type} onChange={(e) => upd(i, { type: e.target.value })} style={{ ...inputStyle, width: 'auto', padding: '6px 8px', fontSize: 12.5 }}>{['task', 'event', 'expense', 'meal', 'med', 'appointment', 'document', 'trip', 'flight', 'shopping', 'bill', 'note'].map((ty) => <option key={ty} value={ty}>{t('t_' + ty)}</option>)}</select>
            <input type="date" value={r.date || ''} onChange={(e) => upd(i, { date: e.target.value || null })} style={{ ...inputStyle, width: 'auto', padding: '6px 8px', fontSize: 12.5, colorScheme: 'dark' }} />
            {isMoney(r.type) && <input type="number" placeholder="R$" value={r.amount ?? ''} onChange={(e) => upd(i, { amount: e.target.value === '' ? null : Number(e.target.value) })} style={{ ...inputStyle, width: 90, padding: '6px 8px', fontSize: 12.5 }} />}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <Btn kind="ghost" onClick={onCancel} style={{ flex: 1 }}>{t('cancel')}</Btn>
        <Btn kind="soft" onClick={() => onDone(included, 'inbox')} style={{ flex: 1.2 }}>{t('toInbox')}</Btn>
        <Btn onClick={() => onDone(included, 'planned')} style={{ flex: 1.2 }}>{t('confirm')}</Btn>
      </div>
    </div>
  );
}
function MealConfirmModal({ draft, lang, t, onSave, onCancel }) {
  const [title, setTitle] = useState(draft.title);
  const [calories, setCalories] = useState(draft.calories);
  const [proteinG, setProteinG] = useState(draft.proteinG);
  const [carbsG, setCarbsG] = useState(draft.carbsG);
  const [fatG, setFatG] = useState(draft.fatG);
  return (
    <Modal onClose={onCancel}>
      <SheetHead title={lang === 'pt' ? 'Registrar refeição' : 'Log meal'} onClose={onCancel} icon={Flame} />
      <Field label={lang === 'pt' ? 'O que é' : 'What is it'}><input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyleBig} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label={lang === 'pt' ? 'Calorias (kcal)' : 'Calories (kcal)'}><input type="number" value={calories} onChange={(e) => setCalories(Number(e.target.value) || 0)} style={inputStyleBig} /></Field>
        <Field label={lang === 'pt' ? 'Proteína (g)' : 'Protein (g)'}><input type="number" value={proteinG} onChange={(e) => setProteinG(Number(e.target.value) || 0)} style={inputStyleBig} /></Field>
        <Field label={lang === 'pt' ? 'Carboidrato (g)' : 'Carbs (g)'}><input type="number" value={carbsG} onChange={(e) => setCarbsG(Number(e.target.value) || 0)} style={inputStyleBig} /></Field>
        <Field label={lang === 'pt' ? 'Gordura (g)' : 'Fat (g)'}><input type="number" value={fatG} onChange={(e) => setFatG(Number(e.target.value) || 0)} style={inputStyleBig} /></Field>
      </div>
      <div style={{ fontSize: 11, color: C.text3, margin: '4px 0 16px', lineHeight: 1.4 }}>{lang === 'pt' ? 'Estimativa da IA a partir da foto — ajuste se quiser antes de salvar.' : "AI estimate from the photo — adjust if you'd like before saving."}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="ghost" onClick={onCancel} style={{ flex: 1 }}>{t('cancel')}</Btn>
        <Btn onClick={() => onSave({ title, calories, proteinG, carbsG, fatG })} style={{ flex: 1.4 }}>{t('save')}</Btn>
      </div>
    </Modal>
  );
}
function normDevText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Tenta interpretar um comando de dispositivo tipo "desligar abajur carol" / "ligar ar da sala".
 *  Devolve {handled:false} se não parecer um comando de dispositivo, ou {handled:true, message} após executar. */
async function tryDeviceCommand(raw, lang) {
  const norm = normDevText(raw);
  const onMatch = /\b(ligar?|liga|acend[ae]r?|acende)\b/.exec(norm);
  const offMatch = /\b(desligar?|desliga|apag[ae]r?|apaga)\b/.exec(norm);
  const m = onMatch || offMatch;
  if (!m) return { handled: false };
  const wantOn = !!onMatch;
  let rest = norm.replace(m[0], '').replace(/\b(o|a|os|as|do|da|de|dos|das|luz|luzes|ar|condicionado|por favor|pfv)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (rest.length < 2) return { handled: false };
  const restWords = rest.split(' ').filter(Boolean);

  let best = null, bestScore = 0;
  Object.entries(TUYA_SEED).forEach(([id, meta]) => {
    const aliasWords = normDevText(meta.alias).split(' ').filter(Boolean);
    const score = restWords.filter((w) => aliasWords.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = { id, meta }; }
  });
  if (!best || bestScore === 0) return { handled: false };

  const acao = wantOn ? (lang === 'pt' ? 'ligado' : 'on') : (lang === 'pt' ? 'desligado' : 'off');
  try {
    if (best.meta.kind === 'ac') {
      // ar-condicionado via infravermelho: não existe telemetria real de volta do aparelho físico,
      // então avisamos honestamente que o comando foi ENVIADO (não "confirmado") — mesma limitação de qualquer controle IR.
      if (!best.meta.ir) return { handled: true, message: lang === 'pt' ? `${best.meta.alias} não tem controle remoto configurado.` : `${best.meta.alias} has no IR remote configured.` };
      await authFetch('/api/tuya', { method: 'POST', body: JSON.stringify({ ir: 'ac', infrared_id: best.meta.ir, remote_id: best.id, acCode: 'all', acValue: { power: wantOn ? 1 : 0, mode: 'cold', temp: 23, wind: 'auto' } }) });
      // pequena espera pra dar tempo do IR transmitir antes de qualquer novo comando ser digitado
      await new Promise((res) => setTimeout(res, 1200));
      return { handled: true, message: `${best.meta.alias}: comando de ${wantOn ? (lang === 'pt' ? 'ligar' : 'turn on') : (lang === 'pt' ? 'desligar' : 'turn off')} enviado por infravermelho (sem confirmação de retorno do aparelho) ✓` };
    }

    // interruptor simples (luz/tomada): manda o comando e CONFIRMA de verdade lendo o status de volta
    const r = await authFetch('/api/tuya');
    const j = await r.json();
    const dev = (j.devices || []).find((d) => d.id === best.id);
    if (!dev) return { handled: true, message: lang === 'pt' ? `Não encontrei "${best.meta.alias}" conectado agora.` : `Couldn't find "${best.meta.alias}" online.` };
    const code = tuyaSwitchCode(dev.status) || (best.meta.kind === 'light' ? 'switch_led' : 'switch_1');
    const rc = await authFetch('/api/tuya', { method: 'POST', body: JSON.stringify({ deviceId: best.id, code, value: wantOn }) });
    const rj = await rc.json();
    if (!rj.ok) return { handled: true, message: (lang === 'pt' ? 'Erro ao comandar: ' : 'Command error: ') + (rj.error || '?') };
    // confirma de verdade: espera um instante e relê o status real do dispositivo na nuvem Tuya
    await new Promise((res) => setTimeout(res, 900));
    try {
      const rv = await authFetch('/api/tuya'); const jv = await rv.json();
      const dv = (jv.devices || []).find((d) => d.id === best.id);
      const confirmed = dv && dv.status && dv.status[code] === wantOn;
      return { handled: true, message: confirmed ? `${best.meta.alias} ${acao} ✓` : `${best.meta.alias}: ${lang === 'pt' ? 'comando enviado, aguardando confirmação do dispositivo...' : 'command sent, awaiting device confirmation...'}` };
    } catch (e) {
      return { handled: true, message: `${best.meta.alias} ${acao} ✓` };
    }
  } catch (e) {
    return { handled: true, message: (lang === 'pt' ? 'Erro ao comandar dispositivo.' : 'Device command error.') };
  }
}
function QuickCapture({ lang, t, addItems, flash, items, onOpen }) {
  const [text, setText] = useState(''); const [loading, setLoading] = useState(false); const [drafts, setDrafts] = useState(null);
  const [searching, setSearching] = useState(false); const [sq, setSq] = useState('');
  const [listening, setListening] = useState(false);
  const [mealDraft, setMealDraft] = useState(null);
  const recRef = useRef();
  const fileRef = useRef();
  const toggleVoice = () => {
    if (listening) { recRef.current && recRef.current.stop(); return; }
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { flash(lang === 'pt' ? 'Ditado por voz não é suportado neste navegador.' : 'Voice input not supported in this browser.'); return; }
    const rec = new SR();
    rec.lang = lang === 'pt' ? 'pt-BR' : 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onerror = () => { setListening(false); flash(lang === 'pt' ? 'Não entendi. Tente de novo.' : "Didn't catch that."); };
    rec.onend = () => setListening(false);
    rec.onresult = (e) => { const t = e.results[0][0].transcript; setText((p) => (p ? p + ' ' : '') + t); };
    recRef.current = rec;
    try { rec.start(); } catch (e) { setListening(false); }
  };
  const run = async () => { if (!text.trim()) return; setLoading(true);
    try {
      const dev = await tryDeviceCommand(text.trim(), lang);
      if (dev.handled) { flash(dev.message); setText(''); setLoading(false); return; }
      setDrafts(await classifyCapture(text.trim(), lang));
    } catch (e) { addItems([{ type: 'note', domain: 'personal', title: text.trim(), priority: 3, status: 'inbox' }]); flash(t('couldntParse')); setText(''); }
    setLoading(false); };
  const pickImage = (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setLoading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result).split(',')[1];
      try {
        const res = await classifyPhotoSmart(b64, file.type, lang);
        if (res.kind === 'meal') setMealDraft(res); else setDrafts(res.items);
      } catch (err) { flash(lang === 'pt' ? 'Não consegui ler a imagem.' : "Couldn't read image."); }
      setLoading(false);
    };
    reader.readAsDataURL(file);
  };
  const captureNative = async () => {
    if (!isNative()) { fileRef.current && fileRef.current.click(); return; }
    haptic(8);
    setLoading(true);
    try {
      const photo = await CapCamera.getPhoto({ resultType: CameraResultType.Base64, source: CameraSource.Prompt, quality: 80, allowEditing: false });
      const mime = photo.format === 'png' ? 'image/png' : 'image/jpeg';
      const res = await classifyPhotoSmart(photo.base64String, mime, lang);
      if (res.kind === 'meal') setMealDraft(res); else setDrafts(res.items);
    } catch (err) {
      const msg = (err && err.message) || '';
      // cancelar o seletor não é erro — qualquer outra coisa a gente mostra, senão o
      // botão parece simplesmente não fazer nada quando algo dá errado de verdade.
      if (!/cancel/i.test(msg)) flash((lang === 'pt' ? 'Câmera: ' : 'Camera: ') + (msg || (lang === 'pt' ? 'erro desconhecido' : 'unknown error')));
    }
    setLoading(false);
  };
  const saveMeal = (m) => {
    addItems([{ type: 'meal', domain: 'health', title: m.title, date: todayISO(), time: nowHM(), meta: { calories: m.calories, proteinG: m.proteinG, carbsG: m.carbsG, fatG: m.fatG, source: 'photo' } }]);
    flash(lang === 'pt' ? 'Refeição registrada ✓' : 'Meal logged ✓');
    setMealDraft(null);
  };
  const results = sq.trim().length >= 2 ? (items || []).filter((i) => (i.title || '').toLowerCase().includes(sq.toLowerCase()) || (i.notes || '').toLowerCase().includes(sq.toLowerCase())).slice(0, 30) : [];
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ ...card, padding: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('capturePh')} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} style={{ ...inputStyle, background: 'transparent', border: 'none' }} />
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={pickImage} style={{ display: 'none' }} />
        <button onClick={() => setSearching(true)} title={lang === 'pt' ? 'Buscar no app' : 'Search app'} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', padding: '9px 4px' }}><Search size={17} /></button>
        <button onClick={toggleVoice} title={lang === 'pt' ? 'Ditar por voz' : 'Voice input'} style={{ background: listening ? C.rose + '22' : 'none', border: 'none', color: listening ? C.rose : C.text3, cursor: 'pointer', padding: '9px 4px', borderRadius: 8 }}><Mic size={17} /></button>
        <button onClick={captureNative} disabled={loading} title={lang === 'pt' ? 'Foto (refeição, recibo, etc.)' : 'Photo (meal, receipt, etc.)'} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', padding: '9px 4px' }}>{loading ? <Loader2 size={17} className="spin" /> : <Camera size={17} />}</button>
        <Btn onClick={run} disabled={loading || !text.trim()} style={{ padding: '9px 13px' }}>{loading ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}</Btn>
      </div>
      {drafts && <DraftReview drafts={drafts} lang={lang} t={t} onDone={(arr, status) => { if (arr.length) addItems(arr.map((x) => ({ ...x, status }))); flash(arr.length + ' ✓'); setDrafts(null); setText(''); }} onCancel={() => setDrafts(null)} />}
      {mealDraft && <MealConfirmModal draft={mealDraft} lang={lang} t={t} onSave={saveMeal} onCancel={() => setMealDraft(null)} />}
      {searching && (
        <Modal onClose={() => { setSearching(false); setSq(''); }}>
          <SheetHead title={lang === 'pt' ? 'Buscar no app' : 'Search'} onClose={() => { setSearching(false); setSq(''); }} icon={Search} />
          <input autoFocus value={sq} onChange={(e) => setSq(e.target.value)} placeholder={lang === 'pt' ? 'Digite pelo menos 2 letras...' : 'Type to search...'} style={{ ...inputStyle, marginBottom: 12 }} />
          {sq.trim().length >= 2 && results.length === 0 && <Empty icon={Search} text={lang === 'pt' ? 'Nada encontrado.' : 'Nothing found.'} />}
          <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            {results.map((r) => <ItemRow key={r.id} item={r} lang={lang} t={t} onToggle={() => {}} onOpen={(it) => { setSearching(false); setSq(''); onOpen && onOpen(it); }} />)}
          </div>
        </Modal>
      )}
    </div>
  );
}
function CaptureSheet({ lang, t, onClose, addItems, flash }) {
  const [text, setText] = useState(''); const [loading, setLoading] = useState(false); const [drafts, setDrafts] = useState(null); const ref = useRef();
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  const run = async () => { if (!text.trim()) return; setLoading(true);
    try { setDrafts(await classifyCapture(text.trim(), lang)); } catch (e) { addItems([{ type: 'note', domain: 'personal', title: text.trim(), priority: 3, status: 'inbox' }]); flash(t('couldntParse')); onClose(); }
    setLoading(false); };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={lang === 'pt' ? 'Capturar' : 'Capture'} onClose={onClose} icon={Sparkles} />
      {!drafts ? (
        <>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('capturePh')} rows={3} style={{ ...inputStyle, resize: 'none', marginBottom: 12 }} />
          <Btn onClick={run} disabled={loading || !text.trim()} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>{loading ? <><Loader2 size={16} className="spin" />{t('thinking')}</> : <><Sparkles size={16} />{t('interpret')}</>}</Btn>
          <div style={{ fontSize: 11.5, color: C.text3, marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>{t('photoAudioSoon')}</div>
        </>
      ) : <DraftReview drafts={drafts} lang={lang} t={t} onDone={(arr, status) => { if (arr.length) addItems(arr.map((x) => ({ ...x, status }))); flash(arr.length + ' ✓'); onClose(); }} onCancel={() => setDrafts(null)} />}
    </Modal>
  );
}

/* ---------------- Claude chat (screen + overlay) ---------------- */
function Chat({ items, lang, t, name, seed, heightStyle }) {
  const [msgs, setMsgs] = useState([]); const [input, setInput] = useState(''); const [loading, setLoading] = useState(false); const endRef = useRef(); const seeded = useRef(false);
  const system = `You are Claude, embedded in ${name}'s personal life app — the brilliant mind behind everything. You see all data the user catalogs. Answer concisely in ${lang === 'pt' ? 'Brazilian Portuguese' : 'US English'}, using the JSON to reason about tasks, events, spending, messages and loose ends; you can also draft messages, texts and suggest next actions. Never give definitive medical or financial advice — add a one-line caution and suggest a professional if asked. When the topic is health: weigh EVERY piece of data under "health" equally — registered conditions, allergies, medications, recent meals/exercise, AND health.examHistory (past lab and imaging exam findings/reports) are just as important as the numeric health.metrics. Do not focus only on lab numbers; the narrative exam findings and the person's full medical history matter just as much for understanding them as a patient. Today: ${todayISO()}. Data: ${JSON.stringify(buildContext(items))}`;
  const push = async (next) => { setMsgs(next); setLoading(true);
    try { const reply = await callClaude(system, next.map((mm) => ({ role: mm.role, content: mm.content }))); setMsgs((p) => [...p, { role: 'assistant', content: reply || '…' }]); }
    catch (e) { setMsgs((p) => [...p, { role: 'assistant', content: lang === 'pt' ? 'Não consegui responder agora.' : "Couldn't respond just now." }]); }
    setLoading(false); };
  useEffect(() => { if (seed && !seeded.current) { seeded.current = true; push([{ role: 'user', content: seed }]); } }, [seed]);
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ behavior: 'smooth' }); }, [msgs, loading]);
  const send = () => { if (!input.trim() || loading) return; push([...msgs, { role: 'user', content: input.trim() }]); setInput(''); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...heightStyle }}>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        {msgs.length === 0 && <div style={{ ...card, padding: 18, marginTop: 8, display: 'flex', gap: 12, alignItems: 'flex-start' }}><Sparkles size={18} style={{ color: C.accent, marginTop: 2 }} /><div style={{ fontSize: 13.5, color: C.text2, lineHeight: 1.55 }}>{t('claudeIntro')}</div></div>}
        {msgs.map((mm, i) => <div key={i} style={{ display: 'flex', justifyContent: mm.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}><div style={{ maxWidth: '82%', padding: '10px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: mm.role === 'user' ? C.accent : C.surface, color: mm.role === 'user' ? '#FFFFFF' : C.text, border: mm.role === 'user' ? 'none' : `1px solid ${C.borderSoft}` }}>{mm.content}</div></div>)}
        {loading && <div style={{ color: C.text3, fontSize: 13, padding: '8px 4px', display: 'flex', gap: 7, alignItems: 'center' }}><Loader2 size={14} className="spin" />{t('thinking')}</div>}
        <div ref={endRef} />
      </div>
      <div style={{ ...card, padding: 6, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('askClaude')} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} style={{ ...inputStyle, background: 'transparent', border: 'none' }} />
        <Btn onClick={send} disabled={loading || !input.trim()} style={{ padding: '9px 12px' }}><Send size={16} /></Btn>
      </div>
    </div>
  );
}
function ClaudeScreen(props) { return <Chat {...props} heightStyle={{ height: 'calc(100vh - 150px)' }} />; }
function ClaudeOverlay({ seed, onClose, ...rest }) {
  return <Modal onClose={onClose}><SheetHead title="Claude" onClose={onClose} icon={Sparkles} /><Chat {...rest} seed={seed} heightStyle={{ height: '62vh' }} /></Modal>;
}

/* ---------------- Weather (sample) ---------------- */
/* Codigos WMO do open-meteo -> icone + descricao */
const WMO = {
  0: ['sun', 'Céu limpo', 'Clear sky'], 1: ['partly', 'Predominantemente limpo', 'Mainly clear'],
  2: ['partly', 'Parcialmente nublado', 'Partly cloudy'], 3: ['cloud', 'Nublado', 'Overcast'],
  45: ['cloud', 'Névoa', 'Fog'], 48: ['cloud', 'Névoa com geada', 'Rime fog'],
  51: ['rain', 'Garoa leve', 'Light drizzle'], 53: ['rain', 'Garoa', 'Drizzle'], 55: ['rain', 'Garoa forte', 'Dense drizzle'],
  56: ['rain', 'Garoa congelante', 'Freezing drizzle'], 57: ['rain', 'Garoa congelante', 'Freezing drizzle'],
  61: ['rain', 'Chuva leve', 'Light rain'], 63: ['rain', 'Chuva', 'Rain'], 65: ['rain', 'Chuva forte', 'Heavy rain'],
  66: ['rain', 'Chuva congelante', 'Freezing rain'], 67: ['rain', 'Chuva congelante', 'Freezing rain'],
  71: ['cloud', 'Neve leve', 'Light snow'], 73: ['cloud', 'Neve', 'Snow'], 75: ['cloud', 'Neve forte', 'Heavy snow'],
  77: ['cloud', 'Grãos de neve', 'Snow grains'],
  80: ['rain', 'Pancadas leves', 'Light showers'], 81: ['rain', 'Pancadas', 'Showers'], 82: ['rain', 'Pancadas fortes', 'Violent showers'],
  85: ['cloud', 'Pancadas de neve', 'Snow showers'], 86: ['cloud', 'Pancadas de neve', 'Snow showers'],
  95: ['rain', 'Trovoada', 'Thunderstorm'], 96: ['rain', 'Trovoada com granizo', 'Thunderstorm, hail'], 99: ['rain', 'Trovoada com granizo', 'Thunderstorm, hail'],
};
function wmo(code, lang) { const e = WMO[code] || WMO[3]; return { kind: e[0], label: lang === 'pt' ? e[1] : e[2] }; }
function wxIcon(k) { return k === 'sun' ? Sun : k === 'rain' ? CloudRain : k === 'cloud' ? Cloud : CloudSun; }

function WeatherDetail({ wx: wxHome, lang, t, onClose }) {
  const [searchedWx, setSearchedWx] = useState(null); const [searchedName, setSearchedName] = useState(null);
  const [q, setQ] = useState(''); const [opts, setOpts] = useState([]); const [searching, setSearching] = useState(false);
  const wx = searchedWx || wxHome;
  const searchCity = async (text) => {
    if (!text || text.length < 3) { setOpts([]); return; }
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(text)}&count=5&language=${lang === 'pt' ? 'pt' : 'en'}`);
      const j = await r.json();
      setOpts(j.results || []);
    } catch (e) { setOpts([]); }
  };
  const pickCity = async (c) => {
    setSearching(true); setOpts([]); setQ('');
    try {
      const r = await fetch(`/api/live?lat=${c.latitude}&lon=${c.longitude}`);
      const j = await r.json();
      if (j.weather) { setSearchedWx(j.weather); setSearchedName([c.name, c.admin1, c.country].filter(Boolean).join(', ')); }
    } catch (e) {}
    setSearching(false);
  };
  const days = wx.days || [];
  const [di, setDi] = useState(0);
  const d0 = days[di] || {};
  const hourly = (wx.hourlyByDay && wx.hourlyByDay[d0.date]) || (di === 0 ? wx.hours : null) || [];
  const rows = [
    [t('rainChance'), d0.rainProb != null ? d0.rainProb + '%' : '—', CloudRain, C.blue],
    [lang === 'pt' ? 'Chuva prevista' : 'Rain', d0.rainMm != null ? String(d0.rainMm).replace('.', ',') + ' mm' : '—', CloudRain, C.sky],
    [t('uvIndex'), d0.uv != null ? String(d0.uv) : '—', Sun, C.accent],
    [t('wind'), d0.windMax != null ? d0.windMax + ' km/h' : (wx.wind != null ? wx.wind + ' km/h' : '—'), Wind, C.text2],
    [t('sunriseL'), d0.sunrise || '—', Sun, C.accent],
    [t('sunsetL'), d0.sunset || '—', CloudSun, C.violet],
  ];
  if (di === 0 && wx.humidity != null) rows.splice(2, 0, [t('humidity'), wx.humidity + '%', Cloud, C.teal]);

  // grafico de temperatura por hora
  const temps = hourly.filter((h) => h.temp != null);
  let chart = null;
  if (temps.length > 1) {
    const vals = temps.map((h) => h.temp); const min = Math.min(...vals), max = Math.max(...vals); const span = (max - min) || 1;
    const W = 300, H = 64;
    const padL = 24; // espaço pro eixo de temperatura na esquerda
    const padT = 12; // espaço no topo pra rótulo do ponto mais quente nunca cortar
    const padB = 6;
    const plotW = W - padL;
    const plotH = H - padT - padB;
    const pts = temps.map((h, i) => [padL + (temps.length === 1 ? plotW / 2 : (i / (temps.length - 1)) * plotW), padT + plotH - ((h.temp - min) / span) * plotH]);
    const dPath = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const hasRain = temps.some((h) => h.rain != null && h.rain > 0);
    const barW = plotW / temps.length * 0.6;
    // ponto de maior chuva (pra rotular só o pico, sem poluir)
    const maxRainIdx = hasRain ? temps.reduce((best, h, i) => (h.rain || 0) > (temps[best].rain || 0) ? i : best, 0) : -1;
    chart = (
      <div style={{ ...card, padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 11.5, color: C.text2, fontWeight: 600 }}>{lang === 'pt' ? 'Temperatura e chuva ao longo do dia' : 'Temperature & rain'}</span>
          <span style={{ fontSize: 10, color: C.text3, display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}><span style={{ width: 8, height: 2, background: C.accent, display: 'inline-block' }} />°C</span>
            <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}><span style={{ width: 7, height: 7, background: C.sky + '99', display: 'inline-block', borderRadius: 1 }} />% chuva</span>
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 76, display: 'block', overflow: 'visible' }} preserveAspectRatio="none">
          {/* eixo Y de temperatura: min/max sempre visiveis, fixos por dia */}
          <text x={0} y={H - padB} fontSize="7" fill={C.text3}>{Math.round(min)}°</text>
          <text x={0} y={padT + 3} fontSize="7" fill={C.text3}>{Math.round(max)}°</text>
          <line x1={padL - 3} y1={padT - 4} x2={padL - 3} y2={H - padB} stroke={C.borderSoft} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {hasRain && temps.map((h, i) => {
            if (h.rain == null || h.rain <= 0) return null;
            const x = padL + (temps.length === 1 ? plotW / 2 : (i / (temps.length - 1)) * plotW);
            const bh = (h.rain / 100) * (plotH - 4);
            return (
              <g key={i}>
                <rect x={x - barW / 2} y={H - padB - bh} width={barW} height={bh} fill={C.sky} opacity="0.28" rx="1" />
                {i === maxRainIdx && <text x={x} y={H - padB - bh - 3} fontSize="7" fill={C.sky} textAnchor="middle">{Math.round(h.rain)}%</text>}
              </g>
            );
          })}
          <path d={dPath} fill="none" stroke={C.accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2" fill={C.accent} />)}
          {/* rotula o ponto mais quente e o mais frio, pra dar contexto sem poluir todos os pontos */}
          {(() => {
            const iMax = vals.indexOf(max), iMin = vals.indexOf(min);
            return [iMax, iMin].filter((v, idx, arr) => arr.indexOf(v) === idx).map((i) => (
              <text key={i} x={pts[i][0]} y={Math.max(7, pts[i][1] - 5)} fontSize="7" fill={C.accent} textAnchor="middle">{Math.round(temps[i].temp)}°</text>
            ));
          })()}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: C.text3, marginTop: 4, paddingLeft: `${(padL / W) * 100}%` }}>
          {temps.filter((_, i) => i % Math.ceil(temps.length / 6) === 0).map((h, i) => <span key={i}>{h.h}</span>)}
        </div>
      </div>
    );
  }

  return (
    <Modal onClose={onClose}>
      <SheetHead title={searchedName || t('weatherDetail')} onClose={onClose} icon={CloudSun} />
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input value={q} onChange={(e) => { setQ(e.target.value); searchCity(e.target.value); }} placeholder={lang === 'pt' ? 'Buscar outra cidade...' : 'Search another city...'} style={inputStyle} />
        {searching && <Loader2 size={15} className="spin" style={{ position: 'absolute', right: 10, top: 10, color: C.text3 }} />}
        {opts.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, marginTop: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
            {opts.map((c, i) => (
              <div key={i} onMouseDown={() => pickCity(c)} style={{ padding: '9px 12px', fontSize: 12.5, cursor: 'pointer', borderBottom: i < opts.length - 1 ? `1px solid ${C.borderSoft}` : 'none', color: C.text }}>{[c.name, c.admin1, c.country].filter(Boolean).join(', ')}</div>
            ))}
          </div>
        )}
      </div>
      {searchedWx && <button onClick={() => { setSearchedWx(null); setSearchedName(null); setDi(0); }} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', marginBottom: 10 }}><ChevronLeft size={13} />{lang === 'pt' ? 'Voltar pra minha localização' : 'Back to my location'}</button>}
      {/* seletor de dia */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12, paddingBottom: 4 }}>
        {days.map((d, i) => {
          const wd = i === 0 ? (lang === 'pt' ? 'Hoje' : 'Today') : WD[lang][new Date(d.date + 'T00:00:00').getDay()];
          const on = i === di; const kind = wmo(d.code, lang).kind;
          const Ic = wxIcon(kind);
          return (
            <button key={i} onClick={() => setDi(i)} style={{ flex: '0 0 auto', minWidth: 58, padding: '9px 6px', borderRadius: 12, border: `1px solid ${on ? C.accent : C.border}`, background: on ? C.accentSoft : 'transparent', cursor: 'pointer', textAlign: 'center' }}>
              <div style={{ fontSize: 10.5, color: on ? C.accent : C.text2, fontWeight: 600 }}>{wd}</div>
              <Ic size={16} style={{ color: kind === 'sun' ? '#F59E0B' : kind === 'rain' ? C.sky : C.text2, margin: '5px auto 4px' }} />
              <div style={{ fontSize: 10 }}><span style={{ color: C.rose }}>{d.hi}°</span> <span style={{ color: C.blue }}>{d.lo}°</span></div>
            </button>
          );
        })}
      </div>
      <div style={{ ...card, padding: 16, marginBottom: 12, textAlign: 'center' }}>
        <div style={{ fontSize: 13.5 }}>{wmo(d0.code, lang).label}</div>
        <div style={{ fontSize: 12, color: C.text2, marginTop: 3 }}><span style={{ color: C.rose, fontWeight: 700 }}>↑{d0.hi}°</span> <span style={{ color: C.blue, fontWeight: 700 }}>↓{d0.lo}°</span></div>
      </div>
      {chart}
      <div style={{ ...card, padding: 4 }}>
        {rows.map(([l, v, Ic, col], i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 12px', borderTop: i ? `1px solid ${C.borderSoft}` : 'none' }}>
            <span style={{ fontSize: 12.5, color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}><Ic size={13} style={{ color: col }} />{l}</span>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function WeatherCard({ lang, t, wx, loading }) {
  const [open, setOpen] = useState(false);
  if (!wx) {
    return (
      <div style={{ ...card, padding: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, color: C.text3 }}>
        {loading ? <Loader2 size={16} className="spin" /> : <CloudSun size={16} />}
        <span style={{ fontSize: 12.5 }}>{loading ? t('thinking') : t('weatherOff')}</span>
      </div>
    );
  }
  const now = wmo(wx.code, lang);
  const NowIcon = wxIcon(now.kind); const nowColor = now.kind === 'sun' ? '#F59E0B' : now.kind === 'rain' ? C.sky : now.kind === 'cloud' ? C.text2 : '#F59E0B';
  return (
    <div onClick={() => setOpen(true)} style={{ ...card, padding: 14, marginBottom: 10, cursor: 'pointer' }}>
      {open && <WeatherDetail wx={wx} lang={lang} t={t} onClose={() => setOpen(false)} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <NowIcon size={32} style={{ color: nowColor }} />
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1 }}>{wx.temp}°</div>
            <div style={{ fontSize: 12, color: C.text3, marginTop: 3 }}>{now.label}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11.5, color: C.text3, lineHeight: 1.6 }}>
          {wx.feels != null && <div>{t('feels')} {wx.feels}°</div>}
          <div><span style={{ color: C.rose, fontWeight: 700 }}>↑{wx.hi}°</span> <span style={{ color: C.blue, fontWeight: 700 }}>↓{wx.lo}°</span> <ChevronRight size={11} style={{ verticalAlign: 'middle', color: C.text3 }} /></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {(wx.days || []).slice(1, 6).map((d, i) => {
          const I = wxIcon(wmo(d.code, lang).kind);
          const wd = WD[lang][new Date(d.date + 'T00:00:00').getDay()];
          return (
            <div key={i} style={{ flex: 1, textAlign: 'center', background: C.bg2, borderRadius: 10, padding: '8px 2px' }}>
              <div style={{ fontSize: 10, color: C.text3 }}>{wd}</div>
              <I size={16} style={{ color: wmo(d.code, lang).kind === 'sun' ? '#F59E0B' : wmo(d.code, lang).kind === 'rain' ? C.sky : C.text2, margin: '5px auto' }} />
              <div style={{ fontSize: 10.5 }}><span style={{ color: C.rose }}>{d.hi}°</span><span style={{ color: C.blue }}> {d.lo}°</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Today ---------------- */
function CompactScore({ label, value, color, onClick }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <button onClick={onClick} style={{ ...card, flex: 1, padding: '10px 12px', cursor: onClick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 34, height: 34, borderRadius: 999, background: value == null ? C.surface2 : `conic-gradient(${color} ${v * 3.6}deg, ${C.surface2} 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <div style={{ width: 25, height: 25, borderRadius: 999, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700, color: value == null ? C.text3 : color }}>{value == null ? '–' : value}</div>
      </div>
      <span style={{ fontSize: 12, color: C.text2, textAlign: 'left', lineHeight: 1.2 }}>{label}</span>
    </button>
  );
}
function ScoreRing({ label, value, color, onClick, locked }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <button onClick={locked ? undefined : onClick} style={{ ...card, flex: 1, padding: 12, cursor: locked ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 62, height: 62, borderRadius: 999, background: value == null ? C.surface2 : `conic-gradient(${color} ${v * 3.6}deg, ${C.surface2} 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 48, height: 48, borderRadius: 999, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, color: value == null ? C.text3 : color }}>{value == null ? '–' : value}</div>
      </div>
      <span style={{ fontSize: 11.5, color: C.text2 }}>{label}</span>
    </button>
  );
}
function WellnessLog({ current, lang, t, onSave, onClose }) {
  const [r, setR] = useState(current.readiness ?? ''); const [s, setS] = useState(current.sleep ?? '');
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('logOura')} onClose={onClose} icon={Activity} />
      <Field label={t('readiness') + ' (0–100)'}><input type="number" value={r} onChange={(e) => setR(e.target.value)} style={inputStyle} /></Field>
      <Field label={t('sleepScore') + ' (0–100)'}><input type="number" value={s} onChange={(e) => setS(e.target.value)} style={inputStyle} /></Field>
      <Btn onClick={() => { onSave({ readiness: r === '' ? null : Number(r), sleep: s === '' ? null : Number(s) }); onClose(); }} style={{ width: '100%' }}>{t('save')}</Btn>
    </Modal>
  );
}
function InfoCard({ icon: Icon, title, sub, right, onClick, accent }) {
  return (
    <div onClick={onClick} style={{ ...card, padding: 14, marginBottom: 10, cursor: onClick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 12, background: accent ? C.accentSoft : C.surface, borderColor: accent ? C.accent + '33' : C.borderSoft }}>
      <Icon size={18} style={{ color: accent ? C.accent : C.text2 }} />
      <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 2, lineHeight: 1.4 }}>{sub}</div></div>
      {right}
    </div>
  );
}
function TodayScreen({ items, lang, t, greeting, name, toggleTask, onOpen, addItems, delItem, flash, health, setHealth, goModule, openClaude, goNews, ouraOn, ttItems = [], news, newsLoading, onRefreshNews, openAccount, todayAccountId }) {
  const [logOpen, setLogOpen] = useState(false); const [ask, setAsk] = useState('');
  const [quickAttn, setQuickAttn] = useState(false);
  const [zBusy, setZBusy] = useState(false);
  const [horo, setHoro] = useState(null); const [horoLoading, setHoroLoading] = useState(false); const [horoOpen, setHoroOpen] = useState(false);
  const openHoroscope = () => {
    setHoroOpen(true);
    if (horo) return;
    setHoroLoading(true);
    authFetch('/api/horoscope').then((r) => r.json()).then((j) => { setHoro(j); setHoroLoading(false); }).catch(() => { setHoro({ text: null, error: 'network' }); setHoroLoading(false); });
  };
  const checkHouseEmailsNow = () => {
    setZBusy(true);
    scanHouseEmails({ addItems, flash, t, lang, items }).then((res) => {
      setZBusy(false);
      if (res.pending.length) flash((lang === 'pt' ? `${res.pending.length} e-mail(s) da casa precisam da sua decisão na aba Casa.` : `${res.pending.length} house email(s) need your decision in the House tab.`));
    });
  };

  const [live, setLive] = useState(null); const [liveLoading, setLiveLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = (lat, lon) => {
      const q = lat != null ? `?lat=${lat}&lon=${lon}` : '';
      fetch('/api/live' + q).then((r) => r.json()).then((j) => { if (alive) { setLive(j); setLiveLoading(false); } })
        .catch(() => { if (alive) setLiveLoading(false); });
    };
    // usa localizacao em cache se ja obtida nesta sessao (evita pedir toda vez)
    if (typeof window !== 'undefined' && window.__lccGeo) {
      load(window.__lccGeo.lat, window.__lccGeo.lon);
    } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
      // rede de segurança: no WebView nativo do iOS, getCurrentPosition pode nunca
      // chamar nem sucesso nem erro se faltar a permissão declarada no app — sem isso,
      // o clima/câmbio (que dependem do mesmo load()) travariam "pensando" pra sempre.
      let settled = false;
      const finish = (lat, lon) => { if (settled) return; settled = true; load(lat, lon); };
      const fallback = setTimeout(() => finish(null, null), 4500);
      navigator.geolocation.getCurrentPosition(
        (p) => { clearTimeout(fallback); const lat = p.coords.latitude.toFixed(3), lon = p.coords.longitude.toFixed(3); if (typeof window !== 'undefined') window.__lccGeo = { lat, lon }; finish(lat, lon); },
        () => { clearTimeout(fallback); finish(null, null); },
        { timeout: 4000, maximumAge: 1800000 }
      );
    } else load(null, null);
    return () => { alive = false; };
  }, []);
  const today = todayISO(); const hm = nowHM(); const w = health[today] || {};
  const isImportant = (tags) => (tags || []).some((tg) => String(tg).toLowerCase() === 'importante' || String(tg).toLowerCase() === 'important');
  const ttImportant = ttItems.filter((i) => i.status !== 'done' && isImportant(i._tags));
  // contas a pagar que vencem HOJE (last warning) + contas atrasadas ainda em aberto
  const billsDue = items.filter((i) => i.type === 'bill' && i.status !== 'done' && i.date && i.date <= today);
  const localAttention = items.filter((i) => i.type === 'task' && i.status !== 'done' && (i.priority === 1 || (i.date && i.date < today)) && !String(i.id).startsWith('tt_'));
  // Contas vencendo hoje primeiro, depois tarefas 'Importante' do TickTick, depois locais urgentes
  const attention = [...billsDue, ...ttImportant, ...localAttention].slice(0, 5);
  // curadoria: até 3 tarefas da casa em aberto, priorizando marcadas como importante, depois atrasadas, depois as mais antigas
  const houseTasksOpen = items.filter((i) => i.domain === 'home' && i.type === 'task' && i.status !== 'done');
  const houseTaskScore = (i) => (i.priority === 1 ? 2 : 0) + (i.date && i.date < today ? 1 : 0);
  const houseTasksTop = [...houseTasksOpen].sort((a, b) => houseTaskScore(b) - houseTaskScore(a) || (a.createdAt || 0) - (b.createdAt || 0)).slice(0, 3);
  const todayItems = items.filter((i) => i.date === today && i.status !== 'done' && i.type !== 'task').sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  // próximas 24h: de agora até a mesma hora de amanhã — só compromissos de verdade (nunca
  // encomendas/entregas nem refeições, que não são um compromisso pessoal ou de trabalho)
  const tomorrow = addDays(today, 1);
  const in24hItems = items.filter((i) => i.status !== 'done' && i.type !== 'task' && i.type !== 'purchase' && i.type !== 'meal' && !(i.meta && i.meta.purchaseRef) && (
    (i.date === today && (!i.time || i.time >= hm)) ||
    (i.date === tomorrow && (!i.time || i.time <= hm))
  )).sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')));
  const next5 = in24hItems.slice(0, 5);
  const balances = items.filter((i) => i.type === 'account' && i.meta && i.meta.showOnToday);
  const longTerm = items.filter((i) => i.date && i.date > today && ((i.meta && i.meta.milestone) || i.type === 'trip')).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 300, letterSpacing: '-.02em' }}>{name ? <>{greeting()}, <span style={{ fontWeight: 600 }}>{name}</span>.</> : <>{greeting()}.</>}</div>
          <div style={{ color: C.text3, fontSize: 13.5, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>{fmtLongPretty(today, lang)}<span style={{ color: C.text3 }}>·</span><LiveClock /></div>
        </div>
        <div title={t('fxHint')} style={{ ...card, padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, minWidth: 104 }}>
          {live && live.fx ? live.fx.map((fx) => (
            <div key={fx.code} style={{ display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, color: C.text3, fontWeight: 600 }}>{fx.code}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{Number(fx.value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              {fx.pct != null && <span style={{ fontSize: 9, fontWeight: 700, color: fx.pct < 0 ? C.rose : C.green }}>{fx.pct < 0 ? '▼' : '▲'}{Math.abs(fx.pct).toFixed(2).replace('.', ',')}%</span>}
            </div>
          )) : (
            <div style={{ fontSize: 10, color: C.text3, display: 'flex', alignItems: 'center', gap: 5 }}>
              {liveLoading ? <Loader2 size={11} className="spin" /> : null}{liveLoading ? 'USD · EUR' : t('fxOff')}
            </div>
          )}
        </div>
      </div>
      <QuickCapture lang={lang} t={t} addItems={addItems} flash={flash} items={items} onOpen={onOpen} />
      <WeatherCard lang={lang} t={t} wx={live && live.weather} loading={liveLoading} />
      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <CompactScore label={t('readiness')} value={w.readiness ?? null} color={C.green} onClick={() => goModule('health')} />
        <CompactScore label={t('sleepScore')} value={w.sleep ?? null} color={C.violet} onClick={() => goModule('health')} />
        {(() => {
          const acc = (todayAccountId && items.find((i) => i.id === todayAccountId && i.type === 'account')) || items.find((i) => i.type === 'account' && /alelo/i.test(i.title || ''));
          const val = acc ? accountBalance(acc, items) : null;
          const nome = acc ? acc.title.replace(/\s*-.*$/, '').slice(0, 10) : 'Alelo';
          const balCol = val != null && val < 0 ? C.rose : C.accent;
          return (
            <button onClick={() => acc ? openAccount(acc.id) : goModule('finance')} style={{ ...card, flex: 1, padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 34, height: 34, borderRadius: 999, background: balCol + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><CreditCard size={16} style={{ color: balCol }} /></div>
              <div style={{ textAlign: 'left', minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 700, color: val != null ? balCol : C.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val != null ? fmtMoney(val, lang) : '—'}</div><div style={{ fontSize: 10.5, color: C.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</div></div>
            </button>
          );
        })()}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 2px 10px' }}>
        <span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}><AlertTriangle size={14} style={{ color: C.rose }} />{t('attention')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={checkHouseEmailsNow} disabled={zBusy} title={t('checkHouseEmails')} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 3 }}>{zBusy ? <Loader2 size={15} className="spin" /> : <Mail size={15} />}</button>
          <button onClick={() => setQuickAttn(true)} title={lang === 'pt' ? 'Adicionar algo pra não esquecer' : 'Add a reminder'} style={{ background: 'none', border: 'none', color: C.rose, cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 3 }}><Plus size={16} /></button>
        </div>
      </div>
      {attention.length === 0 ? <Empty icon={Check} text={t('noAttention')} /> : attention.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} onDelete={delItem} />)}
      {quickAttn && <AddModal title={lang === 'pt' ? 'Pra não esquecer' : "Don't forget"} icon={AlertTriangle} draft={{ type: 'task', domain: 'personal', priority: 1, date: today }} allowedTypes={['task']} lang={lang} t={t} onClose={() => setQuickAttn(false)} onSave={(x) => { addItems([{ ...x, status: 'planned' }]); flash(t('savedOne')); setQuickAttn(false); }} />}
      {houseTasksOpen.length > 0 && <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 2px 10px' }}>
          <span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}><Home size={14} style={{ color: C.blue }} />{t('houseTasks')}</span>
          {houseTasksOpen.length > 3 && <button onClick={() => goModule('house')} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: 11.5 }}>{lang === 'pt' ? `ver todas (${houseTasksOpen.length})` : `see all (${houseTasksOpen.length})`}</button>}
        </div>
        {houseTasksTop.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} onDelete={delItem} />)}
      </>}
      <SectionTitle icon={Clock} label={lang === 'pt' ? 'O que vai rolar nas próximas 24h' : 'Next 24 hours'} color={C.accent} />
      {next5.length === 0 ? <Empty icon={Sun} text={t('nothingToday')} /> : <div style={{ ...card, padding: 14 }}><MiniPlanner items={next5} lang={lang} t={t} onOpen={onOpen} today={today} /></div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 2px 10px' }}>
        <span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}><Newspaper size={14} style={{ color: C.blue }} />{t('news')}</span>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          {[
            { name: 'LinkedIn', url: 'https://www.linkedin.com/feed', bg: '#0A66C2', svg: <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M20.5 2h-17A1.5 1.5 0 002 3.5v17A1.5 1.5 0 003.5 22h17a1.5 1.5 0 001.5-1.5v-17A1.5 1.5 0 0020.5 2zM8 19H5v-9h3zM6.5 8.25A1.75 1.75 0 118.3 6.5a1.78 1.78 0 01-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0013 14.19a.66.66 0 000 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 012.7-1.4c1.55 0 3.36.86 3.36 3.66z" /></svg> },
            { name: 'X', url: 'https://x.com', bg: '#000', svg: <svg viewBox="0 0 24 24" width="13" height="13" fill="#fff"><path d="M18.9 1.2h3.7l-8 9.1L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9zM17.6 20.6h2L6.5 3.3H4.3z" /></svg> },
            { name: 'Instagram', url: 'https://instagram.com', bg: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285AEB 90%)', svg: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="#fff" stroke="none" /></svg> },
            { name: 'TikTok', url: 'https://www.tiktok.com', bg: '#000', svg: <svg viewBox="0 0 24 24" width="13" height="13" fill="#fff"><path d="M16.6 5.82a4.28 4.28 0 01-1-2.66V3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.59 2.59 0 01-2.59-2.59 2.59 2.59 0 013.2-2.51V9.66a5.66 5.66 0 00-.61-.03A5.68 5.68 0 003.6 15.3a5.68 5.68 0 0011.36 0V8.99a7.31 7.31 0 004.28 1.37V7.27a4.28 4.28 0 01-2.64-1.45z" /></svg> },
          ].map((s) => (
            <a key={s.name} href={s.url} target="_blank" rel="noreferrer" title={s.name} style={{ width: 27, height: 27, borderRadius: 7, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', flexShrink: 0, border: `1px solid ${C.border}`, boxShadow: _theme === 'light' ? 'none' : '0 0 0 1px rgba(255,255,255,0.1)' }}>{s.svg}</a>
          ))}
          <button onClick={openHoroscope} title={lang === 'pt' ? 'Horóscopo' : 'Horoscope'} style={{ width: 27, height: 27, borderRadius: 7, background: 'linear-gradient(135deg, #8B5CF6, #C084FC)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.border}`, cursor: 'pointer', flexShrink: 0 }}><Sparkle size={14} style={{ color: '#fff' }} /></button>
          <button onClick={() => onRefreshNews && onRefreshNews()} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11.5, marginLeft: 2 }}>{newsLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}</button>
        </div>
      </div>
      {horoOpen && (
        <Modal onClose={() => setHoroOpen(false)}>
          <SheetHead title={lang === 'pt' ? 'Horóscopo — Sagitário' : 'Horoscope — Sagittarius'} onClose={() => setHoroOpen(false)} icon={Sparkle} />
          {horoLoading ? (
            <div style={{ padding: 20, textAlign: 'center', color: C.text3, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={14} className="spin" />{lang === 'pt' ? 'Buscando...' : 'Fetching...'}</div>
          ) : horo && horo.text ? (
            <div style={{ fontSize: 14, lineHeight: 1.6, color: C.text }}>{horo.text}</div>
          ) : (
            <div style={{ fontSize: 13, color: C.text3, lineHeight: 1.5 }}>{lang === 'pt' ? 'Não consegui buscar o horóscopo de hoje agora.' : "Couldn't fetch today's horoscope right now."}</div>
          )}
        </Modal>
      )}
      <div style={{ ...card, overflow: 'hidden' }}>
        {news === null ? (
          <div style={{ padding: 18, textAlign: 'center', color: C.text3, fontSize: 12.5, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={13} className="spin" />{lang === 'pt' ? 'Curando…' : 'Curating…'}</div>
        ) : news.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{lang === 'pt' ? 'Sem notícias agora.' : 'No news.'}</div>
        ) : news.slice(0, 5).map((n, i) => {
          const src = (n.source || '').replace(/\.com|\.br|\.co|\.info|\.net/g, '').split('.').pop() || 'web';
          return (
          <div key={i} onClick={goNews} style={{ padding: '11px 14px', borderTop: i ? `1px solid ${C.borderSoft}` : 'none', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13.5, lineHeight: 1.35 }}>{n.title}</div><div style={{ fontSize: 10.5, color: C.text3, marginTop: 3, textTransform: 'uppercase', letterSpacing: '.03em' }}>{src}{n.pub ? ' · ' + timeAgo(n.pub, lang) : ''}</div></div>
            <ChevronRight size={15} style={{ color: C.text3, flexShrink: 0 }} />
          </div>
          );
        })}
      </div>
      <button onClick={goNews} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', fontSize: 12.5, padding: '8px 2px', display: 'flex', alignItems: 'center', gap: 4 }}>{t('seeAll')}<ChevronRight size={14} /></button>
      {logOpen && !ouraOn && <WellnessLog current={w} lang={lang} t={t} onSave={(v) => setHealth((h) => ({ ...h, [today]: v }))} onClose={() => setLogOpen(false)} />}
    </div>
  );
}

/* ---------------- Today — wide (web / iPad landscape) ----------------
   Tela "Hoje" própria pra telas largas: mescla o que antes era o Painel
   (saúde, finanças, próxima viagem) direto na Hoje, num grid de 3 colunas. */
const WIDE_DOMAIN_COLOR = (domain) => ({ work: C.sky, health: C.rose, home: C.blue, finance: C.green, kids: C.violet, travel: C.teal, shopping: C.accent }[domain] || C.accent);
const WIDE_DOMAIN_LABEL_KEY = { work: 'fWork', home: 'fHouse', kids: 'fKids', health: 'fHealth', finance: 'finance', travel: 'travel', shopping: 'fShopping' };
const WIDE_TASK_FILTERS = [
  ['work', 'fWork', (i) => i.domain === 'work'],
  ['personal', 'fPersonal', (i) => !['work', 'home', 'kids', 'health'].includes(i.domain)],
  ['home', 'fHouse', (i) => i.domain === 'home'],
  ['kids', 'fKids', (i) => i.domain === 'kids'],
  ['health', 'fHealth', (i) => i.domain === 'health'],
];
function WideCard({ title, action, onAction, children, style }) {
  return (
    <div style={{ ...card, padding: 18, minWidth: 0, ...style }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 13 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{title}</div>
          {action && <button onClick={onAction} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 11.5, whiteSpace: 'nowrap', flexShrink: 0 }}>{action}</button>}
        </div>
      )}
      {children}
    </div>
  );
}
function HourlyWxChart({ points }) {
  const W = 320, H = 56;
  const temps = points.map((h) => h.temp).filter((v) => v != null);
  if (!temps.length) return null;
  const min = Math.min(...temps), max = Math.max(...temps), span = (max - min) || 1;
  const n = points.length;
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - 12) + 6);
  const y = (v) => 18 + (1 - (v - min) / span) * 22;
  const pathPts = points.map((h, i) => [x(i), h.temp != null ? y(h.temp) : null]);
  const dPath = pathPts.filter((p) => p[1] != null).map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={52} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
        {points.map((h, i) => {
          if (h.rain == null || h.rain <= 0) return null;
          const bh = Math.max(1, (h.rain / 100) * 12);
          return <rect key={i} x={x(i) - 3} y={49 - bh} width={6} height={bh} rx={1} fill={C.teal} opacity={0.55} />;
        })}
        <path d={dPath} fill="none" stroke={C.sky} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {pathPts.map((p, i) => p[1] != null && <circle key={i} cx={p[0]} cy={p[1]} r={2.6} fill={C.sky} />)}
        {points.map((h, i) => h.temp != null && <text key={i} x={x(i)} y={Math.max(9, y(h.temp) - 8)} fontSize="9.5" fontWeight="700" textAnchor="middle" fill={C.text} fontFamily="ui-monospace,Menlo,monospace">{h.temp}°</text>)}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        {points.map((h, i) => <span key={i} style={{ fontSize: 10, color: C.text3 }}>{h.h}</span>)}
      </div>
    </>
  );
}
// clima + câmbio da barra da Hoje wide: geolocalização automática (com cache em
// window.__lccGeo, compartilhado com a Hoje do celular) OU busca manual de cidade
// (geocoding gratuito do open-meteo, mesmo usado em WeatherDetail).
function WeatherBarWide({ lang, t }) {
  const [live, setLive] = useState(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [cityLabel, setCityLabel] = useState(null); // null = localização automática
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cq, setCq] = useState(''); const [copts, setCopts] = useState([]); const [csearching, setCsearching] = useState(false);
  const coordsRef = useRef({ lat: null, lon: null }); // última localização usada (auto ou escolhida) — reusada no auto-refresh
  const load = (lat, lon) => {
    coordsRef.current = { lat, lon };
    setLiveLoading(true);
    const q = lat != null ? `?lat=${lat}&lon=${lon}` : '';
    fetch('/api/live' + q).then((r) => r.json()).then((j) => { setLive(j); setLiveLoading(false); }).catch(() => { setLive((p) => p || { weather: null, fx: null }); setLiveLoading(false); });
  };
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__lccGeo) { load(window.__lccGeo.lat, window.__lccGeo.lon); return; }
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      let settled = false;
      const finish = (lat, lon) => { if (settled) return; settled = true; load(lat, lon); };
      const fallback = setTimeout(() => finish(null, null), 4500);
      navigator.geolocation.getCurrentPosition(
        (p) => { clearTimeout(fallback); const lat = p.coords.latitude.toFixed(3), lon = p.coords.longitude.toFixed(3); if (typeof window !== 'undefined') window.__lccGeo = { lat, lon }; finish(lat, lon); },
        () => { clearTimeout(fallback); finish(null, null); },
        { timeout: 4000, maximumAge: 1800000 }
      );
    } else load(null, null);
  }, []);
  // atualiza clima/câmbio sozinho a cada 10min, na mesma localização em uso (auto ou escolhida)
  useEffect(() => {
    const id = setInterval(() => load(coordsRef.current.lat, coordsRef.current.lon), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const searchCity = (text) => {
    setCq(text);
    if (!text || text.trim().length < 3) { setCopts([]); return; }
    setCsearching(true);
    fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(text)}&count=6&language=${lang === 'pt' ? 'pt' : 'en'}`)
      .then((r) => r.json()).then((j) => setCopts(j.results || [])).catch(() => setCopts([])).finally(() => setCsearching(false));
  };
  const pickCity = (c) => {
    setCityLabel([c.name, c.admin1].filter(Boolean).join(', '));
    setPickerOpen(false); setCq(''); setCopts([]);
    load(c.latitude, c.longitude);
  };
  const useMyLocation = () => {
    setCityLabel(null); setPickerOpen(false); setCq(''); setCopts([]);
    if (typeof window !== 'undefined' && window.__lccGeo) load(window.__lccGeo.lat, window.__lccGeo.lon); else load(null, null);
  };
  const CityPicker = () => (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setPickerOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', padding: 0, marginTop: 2, cursor: 'pointer', color: C.accent }}>
        <MapPin size={10} style={{ color: C.accent }} />
        <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{cityLabel || (lang === 'pt' ? 'Minha localização' : 'My location')}</span>
        <ChevronRight size={9} style={{ color: C.accent, transform: pickerOpen ? 'rotate(90deg)' : 'none' }} />
      </button>
      {pickerOpen && (
        <>
          <div onClick={() => setPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 29 }} />
          <div style={{ position: 'absolute', top: 24, left: 0, width: 240, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,.3)', padding: 10, zIndex: 30 }}>
            <input autoFocus value={cq} onChange={(e) => searchCity(e.target.value)} placeholder={lang === 'pt' ? 'Buscar cidade…' : 'Search city…'} style={{ ...inputStyle, marginBottom: 8, fontSize: 12, padding: '7px 10px' }} />
            {cityLabel && <button onClick={useMyLocation} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 11.5, padding: '4px 2px 8px', display: 'flex', gap: 5, alignItems: 'center' }}><MapPin size={11} />{lang === 'pt' ? 'Usar minha localização' : 'Use my location'}</button>}
            {csearching && <div style={{ fontSize: 11.5, color: C.text3, padding: '4px 2px' }}>{t('thinking')}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 180, overflowY: 'auto' }}>
              {copts.map((c, i) => (
                <div key={i} onMouseDown={() => pickCity(c)} style={{ fontSize: 12, color: C.text2, padding: '7px 8px', borderRadius: 7, cursor: 'pointer' }}>{[c.name, c.admin1, c.country].filter(Boolean).join(', ')}</div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
  const wx = live && live.weather;
  const fx = live && live.fx;
  // ainda não terminou a 1ª carga: barra compacta de "carregando", sem esconder nada permanente
  if (!live && liveLoading) {
    return (
      <div style={{ ...card, flex: 1, minWidth: 340, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10, color: C.text3 }}>
        <Loader2 size={16} className="spin" />
        <span style={{ fontSize: 12.5 }}>{t('thinking')}</span>
      </div>
    );
  }
  const now = wx && wmo(wx.code, lang);
  const NowIcon = now ? wxIcon(now.kind) : CloudSun;
  const nowColor = now ? (now.kind === 'sun' ? '#F59E0B' : now.kind === 'rain' ? C.sky : C.text2) : C.text3;
  const pts = wx ? (wx.hours || []).filter((_, i) => i % 2 === 0).slice(0, 8) : [];
  const peakRain = pts.reduce((best, h) => ((h.rain || 0) > (best && best.rain || 0) ? h : best), null);
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 10, gap: 16, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, boxShadow: card.boxShadow, padding: '14px 20px', flex: 1, minWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 340 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none' }}>
          <NowIcon size={24} style={{ color: nowColor }} />
          <div>
            {wx ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'ui-monospace,SF Mono,Menlo,monospace', whiteSpace: 'nowrap' }}>{wx.temp}°C</div>
                <div style={{ fontSize: 10.5, color: C.text3, whiteSpace: 'nowrap' }}>{now.label}</div>
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: C.text3, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                {t('weatherOff')}
                <button onClick={() => load(coordsRef.current.lat, coordsRef.current.lon)} title={lang === 'pt' ? 'Tentar de novo' : 'Retry'} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', display: 'flex', padding: 0 }}><RefreshCw size={11} className={liveLoading ? 'spin' : ''} /></button>
              </div>
            )}
            <CityPicker />
          </div>
        </div>
        <div style={{ width: 1, alignSelf: 'stretch', background: C.borderSoft, flex: 'none' }} />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {pts.length > 1 ? <HourlyWxChart points={pts} /> : <div style={{ fontSize: 11, color: C.text3 }}>{lang === 'pt' ? 'Sem previsão agora.' : 'No forecast right now.'}</div>}
        </div>
      </div>
      <div style={{ width: 1, alignSelf: 'stretch', background: C.borderSoft, flex: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', rowGap: 8, flex: 'none' }}>
        {peakRain && peakRain.rain > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
              <CloudRain size={13} style={{ color: C.sky }} />
              <div style={{ fontSize: 10, color: C.text3, whiteSpace: 'nowrap' }}>{lang === 'pt' ? 'chuva até' : 'rain up to'} <span style={{ color: C.text, fontWeight: 700 }}>{peakRain.rain}%</span> {lang === 'pt' ? 'às' : 'at'} {peakRain.h}</div>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: C.borderSoft, flex: 'none' }} />
          </>
        )}
        {wx && (wx.days || []).length > 1 && (
          <>
            <div style={{ display: 'flex', gap: 12, flex: 'none' }}>
              {wx.days.slice(1, 3).map((d, i) => {
                const kind = wmo(d.code, lang).kind; const I = wxIcon(kind);
                const wd = WD[lang][new Date(d.date + 'T00:00:00').getDay()];
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 10.5, color: C.text2 }}>{wd}</span>
                    <I size={13} style={{ color: kind === 'sun' ? '#F59E0B' : kind === 'rain' ? C.sky : C.text3 }} />
                    <span style={{ fontSize: 10.5, fontFamily: 'ui-monospace,Menlo,monospace', whiteSpace: 'nowrap' }}>{d.hi}°/{d.lo}°</span>
                  </div>
                );
              })}
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: C.borderSoft, flex: 'none' }} />
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <TrendingUp size={14} style={{ color: C.text3 }} />
          {fx && fx.length > 0 ? (
            <div style={{ fontSize: 10, fontFamily: 'ui-monospace,SF Mono,Menlo,monospace', lineHeight: 1.4 }}>
              {fx.map((x) => (
                <div key={x.code} style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: x.code === 'USD' ? 700 : 400, color: x.code === 'USD' ? C.text : C.text3 }}>
                  {x.code} {Number(x.value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {x.pct != null && <span style={{ color: x.pct < 0 ? C.rose : C.green, fontWeight: 700 }}>{x.pct < 0 ? '▼' : '▲'}{Math.abs(x.pct).toFixed(1)}%</span>}
                </div>
              ))}
            </div>
          ) : <span style={{ fontSize: 10, color: C.text3 }}>{t('fxOff')}</span>}
        </div>
      </div>
    </div>
  );
}
function MiniRing({ label, value, color }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: value == null ? C.surface2 : `conic-gradient(${color} ${v * 3.6}deg, ${C.surface2} 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'ui-monospace,Menlo,monospace', color: value == null ? C.text3 : C.text }}>{value == null ? '–' : value}</div>
        </div>
      </div>
      <span style={{ fontSize: 11, color: C.text2, textAlign: 'center', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}
// Saúde da Hoje wide: dois anéis (prontidão + sono, igual ao par que o app do celular já
// mostra) mais passos — que a Oura já manda no daily_activity, só não estava sendo lido.
function HealthRingWide({ readiness, sleep, steps, lang, t, onClick }) {
  return (
    <button onClick={onClick} style={{ background: 'none', border: 'none', padding: 0, cursor: onClick ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', gap: 12, width: '100%', textAlign: 'left', fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <MiniRing label={t('readiness')} value={readiness} color={C.rose} />
        <MiniRing label={t('sleepScore')} value={sleep} color={C.violet} />
      </div>
      {steps != null && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 10 }}>
          <Footprints size={14} style={{ color: C.text3 }} />
          <span style={{ fontSize: 12.5, color: C.text2 }}>{t('steps')}</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'ui-monospace,Menlo,monospace', color: C.text }}>{steps.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')}</span>
        </div>
      )}
    </button>
  );
}
function TodayWideScreen({ items, lang, t, greeting, name, toggleTask, onOpen, addItems, delItem, flash, health, goModule, goNews, goScreen, ttItems = [], news, newsLoading, onRefreshNews, todayAccountId, groceryList = [], toggleGroceryItem, removeGroceryItem, addGroceryItem, onSaveNews }) {
  const today = todayISO(); const hm = nowHM(); const w = health[today] || {};
  const [taskFilter, setTaskFilter] = useState('work');
  const [financeHidden, setFinanceHidden] = useState(true);
  const [addingGrocery, setAddingGrocery] = useState(false); const [groceryText, setGroceryText] = useState('');

  // só o que ainda vai rolar hoje — o que já passou não é mais "hoje", já é histórico
  const todayItems = items.filter((i) => i.date === today && i.status !== 'done' && i.type !== 'task' && (!i.time || i.time >= hm)).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')).slice(0, 6);
  const savedNewsLinks = new Set(items.filter((i) => i.type === 'note' && i.meta && i.meta.source === 'news').map((i) => i.meta.link).filter(Boolean));
  const openTasksSrc = [...items.filter((i) => i.status !== 'done' && i.type === 'task' && !String(i.id).startsWith('tt_')), ...ttItems.filter((i) => i.status !== 'done')];
  const filteredTasks = openTasksSrc.filter(WIDE_TASK_FILTERS.find((f) => f[0] === taskFilter)[2]).slice(0, 6);
  const houseTasks = items.filter((i) => i.domain === 'home' && i.type === 'task' && i.status !== 'done');
  const kidsTasks = items.filter((i) => i.domain === 'kids' && (i.type === 'task' || i.type === 'event') && i.status !== 'done' && (!i.date || i.date >= today));
  const familyList = [...kidsTasks, ...houseTasks].sort((a, b) => (b.priority === 1 ? 1 : 0) - (a.priority === 1 ? 1 : 0)).slice(0, 4);
  const acc = (todayAccountId && items.find((i) => i.id === todayAccountId && i.type === 'account')) || items.find((i) => i.type === 'account' && /alelo/i.test(i.title || ''));
  const balance = acc ? accountBalance(acc, items) : null;
  const balCol = balance != null && balance < 0 ? C.rose : C.text;
  const billsDue = items.filter((i) => i.type === 'bill' && i.status !== 'done' && i.date && i.date <= addDays(today, 5));
  const trips = items.filter((i) => i.type === 'trip' && i.status !== 'done' && i.date && i.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextTrip = trips[0];
  const nextTripDays = nextTrip ? Math.max(0, Math.ceil((new Date(nextTrip.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000)) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 24, flexWrap: 'wrap', rowGap: 16 }}>
        <div style={{ flex: 'none' }}>
          <div style={{ fontSize: 27, fontWeight: 700, letterSpacing: '-.2px', whiteSpace: 'nowrap' }}>{name ? `${greeting()}, ${name}` : greeting()}</div>
          <div style={{ fontSize: 13.5, color: C.text3, marginTop: 5, whiteSpace: 'nowrap', display: 'flex', gap: 6, alignItems: 'center' }}>{fmtLongPretty(today, lang)} · <LiveClock style={{ fontFamily: 'ui-monospace,SF Mono,Menlo,monospace' }} /></div>
        </div>
        <WeatherBarWide lang={lang} t={t} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <QuickCapture lang={lang} t={t} addItems={addItems} flash={flash} items={items} onOpen={onOpen} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <WideCard title={lang === 'pt' ? 'Compromissos de hoje' : "Today's schedule"} action={lang === 'pt' ? 'Ver calendário' : 'See calendar'} onAction={() => goScreen('calendar')}>
            {todayItems.length === 0 ? <Empty icon={Sun} text={t('nothingToday')} /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {todayItems.map((i) => (
                  <div key={i.id} onClick={() => onOpen(i)} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
                    <div style={{ width: 44, flex: 'none', fontSize: 12, fontFamily: 'ui-monospace,SF Mono,Menlo,monospace', color: C.text3, paddingTop: 2 }}>{i.time || '—'}</div>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: WIDE_DOMAIN_COLOR(i.domain), marginTop: 5, flex: 'none' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{i.title}</div>
                        {i.priority === 1 && <span style={{ fontSize: 9, fontWeight: 700, color: C.rose, background: C.rose + '22', padding: '1px 7px', borderRadius: 6 }}>{lang === 'pt' ? 'Importante' : 'Important'}</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>{t(WIDE_DOMAIN_LABEL_KEY[i.domain] || 'fPersonal')} · {t('t_' + i.type)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </WideCard>

          <WideCard title={lang === 'pt' ? 'Principais tarefas' : 'Top tasks'} action={t('seeAll')} onAction={() => goModule('tasks')}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {WIDE_TASK_FILTERS.map(([key, labelKey]) => <Chip key={key} active={taskFilter === key} onClick={() => setTaskFilter(key)}>{t(labelKey)}</Chip>)}
            </div>
            {filteredTasks.length === 0 ? <Empty icon={Check} text={t('noAttention')} /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {filteredTasks.map((i) => (
                  <div key={i.id} onClick={() => toggleTask(i.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: `1px solid ${C.borderSoft}`, cursor: 'pointer' }}>
                    <Circle size={16} style={{ color: C.text3, flex: 'none' }} />
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div>
                    {i.priority === 1 && <span style={{ fontSize: 9, fontWeight: 700, color: C.rose, background: C.rose + '22', padding: '1px 7px', borderRadius: 6, flex: 'none' }}>{lang === 'pt' ? 'Importante' : 'Important'}</span>}
                  </div>
                ))}
              </div>
            )}
          </WideCard>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <WideCard title={t('health')} action={t('seeAll')} onAction={() => goModule('health')}>
            <HealthRingWide readiness={w.readiness} sleep={w.sleep} steps={w.steps} lang={lang} t={t} onClick={() => goModule('health')} />
          </WideCard>

          <WideCard title={lang === 'pt' ? 'Casa & Família' : 'Home & Family'} action={t('seeAll')} onAction={() => goModule('house')}>
            {familyList.length === 0 ? <Empty icon={Home} text={t('noAttention')} /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {familyList.map((i) => {
                  const isKid = i.domain === 'kids';
                  const initial = isKid && i.person ? i.person.trim()[0].toUpperCase() : null;
                  return (
                    <div key={i.id} onClick={() => onOpen(i)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <div style={{ width: 26, height: 26, borderRadius: '50%', background: isKid ? C.violet : C.blue, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 700 }}>
                        {initial || <Home size={13} />}
                      </div>
                      <div style={{ flex: 1, fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </WideCard>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <WideCard>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t('finance')}</div>
              <button onClick={() => setFinanceHidden((v) => !v)} title={financeHidden ? (lang === 'pt' ? 'Mostrar saldo' : 'Show balance') : (lang === 'pt' ? 'Ocultar saldo' : 'Hide balance')} style={{ width: 26, height: 26, borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.text3 }}>
                {financeHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'ui-monospace,SF Mono,Menlo,monospace', letterSpacing: financeHidden ? 1 : '-.3px', marginBottom: 6, color: financeHidden ? C.text : balCol }}>
              {financeHidden ? '••••••' : (balance != null ? fmtMoney(balance, lang) : '—')}
            </div>
            <div style={{ fontSize: 12, color: C.text3, marginBottom: 12 }}>
              {billsDue.length > 0 ? `${billsDue.length} ${lang === 'pt' ? 'conta(s) a vencer' : 'bill(s) due'}` : (lang === 'pt' ? 'Nenhuma conta a vencer' : 'No bills due')}
            </div>
            <button onClick={() => goModule('finance')} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, padding: 0 }}>{lang === 'pt' ? 'Ver finanças →' : 'See finances →'}</button>
          </WideCard>

          <WideCard title={lang === 'pt' ? 'Compra da semana' : "This week's shopping"}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {groceryList.map((i) => (
                <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
                  <button onClick={() => toggleGroceryItem(i.id)} style={{ width: 18, height: 18, borderRadius: 5, border: i.checked ? 'none' : `1.5px solid ${C.border}`, background: i.checked ? C.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none', padding: 0 }}>
                    {i.checked && <Check size={11} style={{ color: '#fff' }} />}
                  </button>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: i.checked ? C.text3 : C.text2, textDecoration: i.checked ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.text}</div>
                  <button onClick={() => removeGroceryItem(i.id)} style={{ width: 20, height: 20, borderRadius: 6, border: 'none', background: 'transparent', color: C.text3, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}><X size={12} /></button>
                </div>
              ))}
              {addingGrocery ? (
                <form onSubmit={(e) => { e.preventDefault(); addGroceryItem(groceryText); setGroceryText(''); setAddingGrocery(false); }} style={{ padding: '8px 0' }}>
                  <input autoFocus value={groceryText} onChange={(e) => setGroceryText(e.target.value)} onBlur={() => { if (groceryText.trim()) addGroceryItem(groceryText); setGroceryText(''); setAddingGrocery(false); }} placeholder={lang === 'pt' ? 'Novo item…' : 'New item…'} style={{ ...inputStyle, padding: '6px 9px', fontSize: 12.5 }} />
                </form>
              ) : (
                <div onClick={() => setAddingGrocery(true)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', border: `1.5px dashed ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: C.text3 }}><Plus size={10} /></div>
                  <div style={{ fontSize: 12, color: C.text3 }}>{lang === 'pt' ? 'Adicionar item à lista' : 'Add item to list'}</div>
                </div>
              )}
            </div>
          </WideCard>

          {nextTrip && (
            <WideCard>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t('nextTrip')}</div>
                <div style={{ fontSize: 19, fontWeight: 700 }}>{(nextTrip.meta && nextTrip.meta.destination) || nextTrip.title}</div>
                <div style={{ fontSize: 12, color: C.text3 }}>{nextTripDays === 0 ? t('ongoing') : `${lang === 'pt' ? 'em' : 'in'} ${nextTripDays} ${t('daysWord')}`}</div>
                <button onClick={() => goModule('travel')} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, padding: 0, textAlign: 'left' }}>{lang === 'pt' ? 'Ver viagem →' : 'See trip →'}</button>
              </div>
            </WideCard>
          )}
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <WideCard>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', rowGap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{t('news')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {[
                  { name: 'LinkedIn', url: 'https://www.linkedin.com/feed', bg: '#0A66C2', svg: <svg viewBox="0 0 24 24" width="13" height="13" fill="#fff"><path d="M20.5 2h-17A1.5 1.5 0 002 3.5v17A1.5 1.5 0 003.5 22h17a1.5 1.5 0 001.5-1.5v-17A1.5 1.5 0 0020.5 2zM8 19H5v-9h3zM6.5 8.25A1.75 1.75 0 118.3 6.5a1.78 1.78 0 01-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0013 14.19a.66.66 0 000 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 012.7-1.4c1.55 0 3.36.86 3.36 3.66z"/></svg> },
                  { name: 'X', url: 'https://x.com', bg: '#000', svg: <svg viewBox="0 0 24 24" width="12" height="12" fill="#fff"><path d="M18.9 1.2h3.7l-8 9.1L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9zM17.6 20.6h2L6.5 3.3H4.3z"/></svg> },
                  { name: 'Instagram', url: 'https://instagram.com', bg: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285AEB 90%)', svg: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="#fff" stroke="none"/></svg> },
                  { name: 'TikTok', url: 'https://www.tiktok.com', bg: '#000', svg: <svg viewBox="0 0 24 24" width="12" height="12" fill="#fff"><path d="M16.6 5.82a4.28 4.28 0 01-1-2.66V3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.59 2.59 0 01-2.59-2.59 2.59 2.59 0 013.2-2.51V9.66a5.66 5.66 0 00-.61-.03A5.68 5.68 0 003.6 15.3a5.68 5.68 0 0011.36 0V8.99a7.31 7.31 0 004.28 1.37V7.27a4.28 4.28 0 01-2.64-1.45z"/></svg> },
                ].map((s) => (
                  <a key={s.name} href={s.url} target="_blank" rel="noreferrer" title={s.name} style={{ width: 28, height: 28, borderRadius: 8, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', flexShrink: 0, border: `1px solid ${C.border}` }}>{s.svg}</a>
                ))}
              </div>
              <button onClick={() => onRefreshNews && onRefreshNews()} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>{newsLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}</button>
              <button onClick={goNews} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12 }}>{t('seeAll')}</button>
            </div>
          </div>
          {news === null ? (
            <div style={{ padding: 8, textAlign: 'center', color: C.text3, fontSize: 12.5, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={13} className="spin" />{lang === 'pt' ? 'Curando…' : 'Curating…'}</div>
          ) : news.length === 0 ? (
            <div style={{ padding: 8, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{lang === 'pt' ? 'Sem notícias agora.' : 'No news.'}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {news.slice(0, 4).map((n, i) => {
                const src = (n.source || '').replace(/\.com|\.br|\.co|\.info|\.net/g, '').split('.').pop() || 'web';
                const saved = savedNewsLinks.has(n.link);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: i < 3 ? `1px solid ${C.borderSoft}` : 'none', paddingBottom: i < 3 ? 12 : 0 }}>
                    <div onClick={goNews} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>{n.title}</div>
                      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.03em' }}>{src}{n.pub ? ' · ' + timeAgo(n.pub, lang) : ''}</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); if (!saved) onSaveNews && onSaveNews(n); }} title={saved ? (lang === 'pt' ? 'Salvo pra ler depois' : 'Saved for later') : (lang === 'pt' ? 'Salvar pra ler depois' : 'Save for later')} style={{ background: 'none', border: 'none', cursor: saved ? 'default' : 'pointer', color: saved ? C.accent : C.text3, display: 'flex', padding: 2, flex: 'none' }}>
                      <Star size={15} style={{ fill: saved ? C.accent : 'none' }} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </WideCard>
      </div>
    </div>
  );
}

/* ---------------- Messages ---------------- */
function MessageThread({ msg, lang, t, onClose, onSave, onDelete }) {
  const [reply, setReply] = useState(''); const [drafting, setDrafting] = useState(false); const [copied, setCopied] = useState(false);
  const ch = CHANNELS[(msg.meta && msg.meta.channel) || 'email'];
  const draft = async () => { setDrafting(true);
    try { const sys = `Draft a concise, warm reply in ${lang === 'pt' ? 'Brazilian Portuguese' : 'US English'} to this ${ch.label} message. Return only the reply text.`; const r = await callClaude(sys, [{ role: 'user', content: `From: ${msg.meta && msg.meta.sender || ''}\n${msg.notes || msg.title}` }]); setReply(r); }
    catch (e) {} setDrafting(false); };
  const copy = () => { try { navigator.clipboard.writeText(reply); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {} };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={msg.meta && msg.meta.sender || t('t_message')} onClose={onClose} icon={ch.icon} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}><span style={{ fontSize: 11.5, color: ch.color, border: `1px solid ${ch.color}44`, borderRadius: 999, padding: '2px 9px' }}>{ch.label}</span>{msg.date && <span style={{ fontSize: 11.5, color: C.text3 }}>{fmtDate(msg.date, lang)}{msg.time ? ' ' + msg.time : ''}</span>}</div>
      <div style={{ ...card, padding: 14, marginBottom: 14, fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{msg.notes || msg.title}</div>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{t('reply')}</div>
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'none', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Btn kind="soft" onClick={draft} disabled={drafting} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>{drafting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{t('draftReply')}</Btn>
        <Btn kind="soft" onClick={copy} disabled={!reply} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Copy size={14} />{copied ? t('copied') : t('copy')}</Btn>
      </div>
      <div style={{ fontSize: 11, color: C.text3, marginBottom: 12, lineHeight: 1.5 }}>{t('sendHint')}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="danger" onClick={() => { onDelete(msg.id); onClose(); }}><Trash2 size={15} /></Btn>
        <Btn onClick={() => { onSave(msg.id, { meta: { ...msg.meta, unread: false } }); onClose(); }} style={{ flex: 1 }}>{lang === 'pt' ? 'Marcar como lida' : 'Mark read'}</Btn>
      </div>
    </Modal>
  );
}
function MessagesScreen({ items, people, lang, t, setItems, onOpen, toggleTask, addItem, updateItem, delItem, flash }) {
  const [adding, setAdding] = useState(false); const [thread, setThread] = useState(null);
  const [scan, setScan] = useState({ loading: false, list: null, error: null });
  const runScan = () => {
    setScan({ loading: true, list: null, error: null });
    authFetch('/api/inbox-scan').then((r) => r.json())
      .then((j) => setScan({ loading: false, list: j.suggestions || [], error: j.error || null }))
      .catch((e) => setScan({ loading: false, list: [], error: String(e) }));
  };
  const acceptSug = (sg) => {
    const domain = (sg.type === 'flight' || sg.type === 'trip') ? 'travel' : sg.type === 'bill' ? 'finance' : 'personal';
    addItem({ type: sg.type, domain, title: sg.title, date: sg.date, time: sg.time, amount: sg.amount, meta: { ...(sg.meta || {}), fromEmail: true } });
    setScan((p) => ({ ...p, list: (p.list || []).filter((x) => x.key !== sg.key) }));
    flash(t('savedOne'));
  };
  const msgs = items.filter((i) => i.type === 'message').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const triage = items.filter((i) => i.status === 'inbox');
  const unread = msgs.filter((m) => m.meta && m.meta.unread).length;
  const accept = (id) => setItems((p) => p.map((i) => (i.id === id ? { ...i, status: 'planned' } : i)));
  return (
    <div>
      <ScreenTitle title={t('messages')} sub={`${unread} ${t('unread')}`} />
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('t_message')}</Btn>
      <div style={{ ...card, padding: 12, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <Sparkles size={16} style={{ color: C.accent, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 12.5, color: C.text2, lineHeight: 1.4 }}>{t('suggestions')}</span>
        <Btn kind="soft" onClick={runScan} disabled={scan.loading} style={{ padding: '7px 12px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          {scan.loading ? <Loader2 size={13} className="spin" /> : <Mail size={13} />}{scan.loading ? t('scanning') : t('scanInbox')}
        </Btn>
      </div>
      {scan.error && <HintCard icon={AlertTriangle} text={scan.error} />}
      {scan.list && scan.list.length === 0 && !scan.loading && <HintCard icon={Check} text={t('noSuggestions')} />}
      {scan.list && scan.list.map((sg) => {
        const Ic = typeIcon(sg.type);
        return (
          <div key={sg.key} style={{ ...card, padding: 13, marginBottom: 8, borderColor: C.accent + '33' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Ic size={16} style={{ color: C.accent, marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{sg.title}</div>
                <div style={{ fontSize: 11.5, color: C.text2, marginTop: 3 }}>
                  {t('t_' + sg.type)}{sg.date ? ' · ' + fmtDate(sg.date, lang) : ''}{sg.time ? ' ' + sg.time : ''}
                  {sg.meta && sg.meta.from ? ` · ${sg.meta.from}→${sg.meta.to || ''}` : ''}
                </div>
                {sg.why && <div style={{ fontSize: 11, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>{sg.why}</div>}
                {sg.source && sg.source.subject && <div style={{ fontSize: 10.5, color: C.text3, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✉ {sg.source.subject}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Btn kind="soft" onClick={() => acceptSug(sg)} style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Check size={13} />{t('accept')}</Btn>
              <Btn kind="ghost" onClick={() => setScan((p) => ({ ...p, list: p.list.filter((x) => x.key !== sg.key) }))} style={{ padding: '7px 12px', fontSize: 12.5 }}>{t('discard')}</Btn>
              {sg.source && sg.source.link && <a href={sg.source.link} target="_blank" rel="noreferrer" style={{ ...card, padding: '7px 11px', color: C.text2, fontSize: 12, textDecoration: 'none', display: 'flex', alignItems: 'center' }}><Mail size={13} /></a>}
            </div>
          </div>
        );
      })}
      {triage.length > 0 && (
        <>
          <SectionTitle icon={Sparkles} label={t('toTriage')} color={C.accent} />
          {triage.map((i) => (
            <div key={i.id} style={{ marginBottom: 8 }}>
              <ItemRow item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />
              <div style={{ display: 'flex', gap: 8, marginTop: -2, marginBottom: 6, paddingLeft: 4 }}>
                <Btn kind="soft" onClick={() => accept(i.id)} style={{ padding: '6px 12px', fontSize: 12.5, display: 'flex', gap: 5, alignItems: 'center' }}><Check size={13} />{t('accept')}</Btn>
                <Btn kind="ghost" onClick={() => delItem(i.id)} style={{ padding: '6px 12px', fontSize: 12.5 }}>{t('discard')}</Btn>
              </div>
            </div>
          ))}
        </>
      )}
      <SectionTitle icon={MessageSquare} label={t('messages')} color={C.blue} />
      {msgs.length === 0 ? <Empty icon={MessageSquare} text={t('noMessages')} /> : msgs.map((m) => {
        const ch = CHANNELS[(m.meta && m.meta.channel) || 'email']; const Ic = ch.icon; const isUnread = m.meta && m.meta.unread;
        return (
          <div key={m.id} onClick={() => setThread(m)} style={{ ...card, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer', borderColor: isUnread ? ch.color + '55' : C.borderSoft }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: ch.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={16} style={{ color: ch.color }} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: isUnread ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.meta && m.meta.sender || m.title}</div>
              <div style={{ fontSize: 12, color: C.text3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.notes || m.title}</div>
            </div>
            {isUnread && <span style={{ width: 8, height: 8, borderRadius: 999, background: ch.color, flexShrink: 0 }} />}
          </div>
        );
      })}
      {adding && <AddModal title={t('t_message')} icon={MessageSquare} draft={{ type: 'message', domain: 'personal', meta: { channel: 'email', unread: true } }} allowedTypes={['message']} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem(x); flash(t('savedOne')); setAdding(false); }} />}
      {thread && <MessageThread msg={thread} lang={lang} t={t} onClose={() => setThread(null)} onSave={updateItem} onDelete={delItem} />}
    </div>
  );
}

/* ---------------- News ---------------- */
function timeAgo(pub, lang) {
  const t = Date.parse(pub); if (!t) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 60) return (lang === 'pt' ? 'há ' : '') + min + 'min';
  const h = Math.floor(min / 60); if (h < 24) return (lang === 'pt' ? 'há ' : '') + h + 'h';
  const d = Math.floor(h / 24); return (lang === 'pt' ? 'há ' : '') + d + 'd';
}

async function analyzeMealPhoto(b64, mime, lang) {
  const system = `You are a nutrition analyst. Look at the attached food photo and estimate its nutritional content. Respond ONLY with JSON, no prose, no fences: {"title":"short dish name in ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}","calories":number,"protein":number (grams),"carbs":number (grams),"fat":number (grams),"notes":"1 short sentence with any nutrition observation, in ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}"}. These are estimates from a photo, not lab-precise — be reasonable, not overly precise (round numbers).`;
  const text = await callClaude(system, [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: b64 } }, { type: 'text', text: lang === 'pt' ? 'Analise esta refeição.' : 'Analyze this meal.' }] }]);
  let j = text; const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a !== -1 && b !== -1) j = text.slice(a, b + 1);
  const x = JSON.parse(j);
  return { title: String(x.title || 'Refeição').slice(0, 120), calories: Number(x.calories) || null, protein: Number(x.protein) || null, carbs: Number(x.carbs) || null, fat: Number(x.fat) || null, notes: x.notes || '' };
}
function DietAssistant({ meals, lang, t, back }) {
  const [msgs, setMsgs] = useState([]); const [input, setInput] = useState(''); const [loading, setLoading] = useState(false); const endRef = useRef();
  const recent = meals.slice(0, 30).map((m) => ({ title: m.title, date: m.date, calories: m.meta && m.meta.calories, protein: m.meta && m.meta.protein, carbs: m.meta && m.meta.carbs, fat: m.meta && m.meta.fat }));
  const system = `You are the user's personal diet/nutrition assistant inside their health app. Answer concisely in ${lang === 'pt' ? 'Brazilian Portuguese' : 'US English'}. Use the JSON of their recent logged meals (estimated from photos, not lab-precise) to summarize eating patterns, flag gaps (protein too low, too much sugar, irregular meals) and suggest practical adjustments. You are NOT a doctor — never give medical directives, add a short caution and suggest a nutritionist/doctor for anything serious. Today: ${todayISO()}. Recent meals: ${JSON.stringify(recent)}`;
  const push = async (next) => { setMsgs(next); setLoading(true); try { const r = await callClaude(system, next.map((m) => ({ role: m.role, content: m.content }))); setMsgs((p) => [...p, { role: 'assistant', content: r || '…' }]); } catch (e) { setMsgs((p) => [...p, { role: 'assistant', content: lang === 'pt' ? 'Não consegui responder agora.' : "Couldn't respond." }]); } setLoading(false); };
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ behavior: 'smooth' }); }, [msgs, loading]);
  const send = () => { if (!input.trim() || loading) return; push([...msgs, { role: 'user', content: input.trim() }]); setInput(''); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{lang === 'pt' ? 'Dieta' : 'Diet'}</button>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        {msgs.length === 0 && <div style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}><Sparkles size={17} style={{ color: C.accent, marginTop: 2 }} /><div style={{ fontSize: 13.5, color: C.text2, lineHeight: 1.55 }}>{lang === 'pt' ? 'Pergunte sobre seus hábitos alimentares, peça sugestões de ajuste na dieta, ou um resumo da semana.' : 'Ask about your eating habits or get diet suggestions.'}</div></div>}
        {msgs.map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}><div style={{ maxWidth: '82%', padding: '10px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: m.role === 'user' ? C.accent : C.surface, color: m.role === 'user' ? '#FFFFFF' : C.text, border: m.role === 'user' ? 'none' : `1px solid ${C.borderSoft}` }}>{m.content}</div></div>)}
        {loading && <div style={{ color: C.text3, fontSize: 13, padding: '8px 4px', display: 'flex', gap: 7, alignItems: 'center' }}><Loader2 size={14} className="spin" />{t('thinking')}</div>}
        <div ref={endRef} />
      </div>
      <div style={{ ...card, padding: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('askClaude')} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} style={{ ...inputStyle, background: 'transparent', border: 'none' }} />
        <Btn onClick={send} disabled={loading || !input.trim()} style={{ padding: '9px 12px' }}><Send size={16} /></Btn>
      </div>
    </div>
  );
}
function DrClaudeBadge({ size = 20 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.3, background: 'linear-gradient(135deg, #6BA6E6, #5B8DEF)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Stethoscope size={size * 0.6} style={{ color: '#fff' }} />
    </div>
  );
}
// indicadores clinicamente comuns/rotineiros — usados só como desempate na ordenação da tabela
// (o critério principal é quantidade de leituras: quem é medido com mais frequência tende a ser
// o que mais importa acompanhar ao longo do tempo)
const COMMON_INDICATORS = ['Glicemia', 'Hemoglobina Glicada', 'Colesterol Total', 'HDL', 'LDL', 'VLDL', 'Triglicerídeos', 'Creatinina', 'Ureia', 'TSH', 'T4 Livre', 'PCR', 'Hemoglobina', 'Hematócrito', 'Leucócitos', 'Plaquetas', 'Ácido Úrico', 'Vitamina D', 'TGO', 'TGP', 'Ferritina', 'Sódio', 'Potássio'];
const fmtIndNum = (v) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = (iso) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '';
function sortedIndicatorRows(byIndicator) {
  const entries = Object.entries(byIndicator).filter(([k]) => k !== '__checked__');
  const impIndex = (name) => { const i = COMMON_INDICATORS.findIndex((x) => x.toLowerCase() === name.toLowerCase()); return i === -1 ? 999 : i; };
  return entries.slice().sort((a, b) => (b[1].length - a[1].length) || (impIndex(a[0]) - impIndex(b[0])) || a[0].localeCompare(b[0], 'pt'));
}
// tabela: linhas = indicadores, colunas = data do exame (mais recente à esquerda). A tabela NÃO
// leva width:100% de propósito — precisa do tamanho natural do conteúdo pra o scroll horizontal
// funcionar (com width:100% o navegador espreme todas as colunas dentro do espaço visível em vez
// de deixar rolar, o que fazia dar a impressão de "só uma coluna por vez" em telas maiores).
function IndicatorsTable({ rows, lang }) {
  if (!rows.length) return null;
  const allDates = [...new Set(rows.flatMap(([, pts]) => pts.map((p) => p.date).filter(Boolean)))].sort((a, b) => b.localeCompare(a));
  const cellFor = (pts, date) => pts.find((p) => p.date === date);
  const thBase = { padding: '9px 10px', borderBottom: `1px solid ${C.borderSoft}`, fontWeight: 600 };
  const nameColBg = (THEMES[_theme] || THEMES.dark).surface;
  return (
    <div style={{ ...card, padding: 0, marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11.5, whiteSpace: 'nowrap' }}>
          <thead>
            <tr>
              <th style={{ ...thBase, position: 'sticky', left: 0, background: nameColBg, textAlign: 'left', color: C.text2, zIndex: 1 }}>{lang === 'pt' ? 'Indicador' : 'Indicator'}</th>
              {allDates.map((d) => <th key={d} style={{ ...thBase, textAlign: 'right', color: C.text3 }}>{shortDate(d)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, pts]) => (
              <tr key={name}>
                <td style={{ position: 'sticky', left: 0, background: nameColBg, padding: '8px 10px', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.borderSoft}` }}>{name}</td>
                {allDates.map((d) => {
                  const p = cellFor(pts, d);
                  const color = !p ? C.text3 : p.status === 'alto' ? C.rose : p.status === 'baixo' ? C.blue : C.text2;
                  return (
                    <td key={d} title={p && p.refRange ? `ref: ${p.refRange}` : undefined} style={{ textAlign: 'right', padding: '8px 10px', color, fontWeight: p && p.status && p.status !== 'normal' ? 700 : 400, borderBottom: `1px solid ${C.borderSoft}` }}>
                      {p ? `${fmtIndNum(p.value)}${p.unit ? ' ' + p.unit : ''}` : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
// tela dedicada com a tabela completa (sem limite de linhas) — a aba de Histórico Médico só
// mostra uma prévia; aqui não há nenhuma restrição de largura ou de quantidade de indicadores.
function IndicatorsFullScreen({ items, lang, t, back }) {
  const byIndicator = {};
  items.filter((i) => i.type === 'healthMetric').forEach((m) => { const k = m.title; (byIndicator[k] = byIndicator[k] || []).push({ value: m.amount, unit: m.meta && m.meta.unit, refRange: m.meta && m.meta.refRange, status: m.meta && m.meta.status, date: m.date }); });
  const rows = sortedIndicatorRows(byIndicator);
  return (
    <div style={{ paddingBottom: 100 }}>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{lang === 'pt' ? 'Histórico Médico' : 'Medical History'}</button>
      <div style={{ fontSize: 22, fontWeight: 600, margin: '4px 2px 14px' }}>{lang === 'pt' ? `Todos os indicadores (${rows.length})` : `All indicators (${rows.length})`}</div>
      {rows.length === 0 ? <Empty icon={Activity} text={lang === 'pt' ? 'Nenhum indicador ainda.' : 'No indicators yet.'} /> : <IndicatorsTable rows={rows} lang={lang} />}
    </div>
  );
}
function SleepReadinessHistory({ health, lang }) {
  const entries = Object.entries(health || {}).filter(([, v]) => v && (v.sleep != null || v.readiness != null)).sort(([a], [b]) => a.localeCompare(b)).slice(-90);
  if (entries.length < 2) return null;
  const W = 280, H = 60;
  const mk = (key, color) => {
    const pts = entries.map(([d, v], i) => v[key] != null ? [i / (entries.length - 1) * W, H - (v[key] / 100) * (H - 8) - 4] : null).filter(Boolean);
    if (pts.length < 2) return null;
    return <path key={key} d={pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
  };
  const avg = (key) => { const vs = entries.map(([, v]) => v[key]).filter((x) => x != null); return vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) : null; };
  const lastTemp = entries.slice().reverse().find(([, v]) => v.tempDeviation != null);
  const tempAlert = lastTemp && Math.abs(lastTemp[1].tempDeviation) >= 0.5;
  return (
    <div style={{ ...card, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, color: C.text2, fontWeight: 600 }}>{lang === 'pt' ? `Sono, Prontidão & Atividade · últimos ${entries.length} dias` : `Sleep, Readiness & Activity · last ${entries.length} days`}</span>
      </div>
      <div style={{ fontSize: 10, color: C.text3, display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}><span style={{ width: 8, height: 2, background: C.violet, display: 'inline-block' }} />{lang === 'pt' ? 'sono' : 'sleep'} {avg('sleep') ?? '—'}</span>
        <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}><span style={{ width: 8, height: 2, background: C.green, display: 'inline-block' }} />{lang === 'pt' ? 'prontidão' : 'readiness'} {avg('readiness') ?? '—'}</span>
        {avg('activity') != null && <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}><span style={{ width: 8, height: 2, background: C.accent, display: 'inline-block' }} />{lang === 'pt' ? 'atividade' : 'activity'} {avg('activity')}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 64, display: 'block' }} preserveAspectRatio="none">
        {mk('sleep', C.violet)}
        {mk('readiness', C.green)}
        {mk('activity', C.accent)}
      </svg>
      <div style={{ fontSize: 10, color: C.text3, marginTop: 4 }}>{fmtDate(entries[0][0], lang)} — {fmtDate(entries[entries.length - 1][0], lang)}</div>
      {tempAlert && (
        <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, background: C.rose + '14', border: `1px solid ${C.rose}33`, fontSize: 11, color: C.rose, display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertTriangle size={12} />{lang === 'pt' ? `Temperatura corporal ${lastTemp[1].tempDeviation > 0 ? 'acima' : 'abaixo'} do seu normal (${lastTemp[1].tempDeviation > 0 ? '+' : ''}${lastTemp[1].tempDeviation}°) em ${fmtDate(lastTemp[0], lang)}.` : `Body temperature deviation detected on ${fmtDate(lastTemp[0], lang)}.`}
        </div>
      )}
    </div>
  );
}
function MedicalHistoryScreen({ items, people, lang, t, back, addItem, updateItem, flash, health, onOpen, openClaude, goIndicatorsFull }) {
  const [adding, setAdding] = useState(null); // 'condition' | 'allergy' | 'medication'
  const [analyzing, setAnalyzing] = useState(false); const [analyzeProgress, setAnalyzeProgress] = useState('');
  const [dietOpen, setDietOpen] = useState(false); const [mealLoading, setMealLoading] = useState(false);
  const mealFileRef = useRef();
  const meals = items.filter((i) => i.type === 'meal' && i.domain === 'health').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const pickMealPhoto = (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setMealLoading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result).split(',')[1];
      try {
        const info = await analyzeMealPhoto(b64, file.type, lang);
        const att = await saveAttachment(String(reader.result), file.name, 'image');
        addItem({ type: 'meal', domain: 'health', title: info.title, date: todayISO(), time: new Date().toTimeString().slice(0, 5), notes: info.notes, meta: { calories: info.calories, protein: info.protein, carbs: info.carbs, fat: info.fat, attachments: [att] } });
        flash(lang === 'pt' ? 'Refeição registrada ✓' : 'Meal logged ✓');
      } catch (err) { flash(lang === 'pt' ? 'Não consegui analisar a foto.' : "Couldn't analyze photo."); }
      setMealLoading(false);
    };
    reader.readAsDataURL(file);
  };
  if (dietOpen) return <DietAssistant meals={meals} lang={lang} t={t} back={() => setDietOpen(false)} />;
  const healthItems = items.filter((i) => i.domain === 'health');
  const isExamDoc = (i) => i.type === 'document' && (i.meta && i.meta.isExam || /exame|hemograma|resultado|laudo|sangue/i.test(i.title || ''));
  const examDocs = healthItems.filter(isExamDoc);
  const metrics = items.filter((i) => i.type === 'healthMetric');
  const analyzedDocIds = new Set(metrics.map((m) => m.meta && m.meta.sourceDocId).filter(Boolean));
  const unanalyzed = examDocs.filter((d) => !analyzedDocIds.has(d.id) && d.meta && d.meta.attachments && d.meta.attachments.length > 0);
  const conditions = items.filter((i) => i.type === 'condition');
  const allergies = items.filter((i) => i.type === 'allergy');
  const meds = items.filter((i) => i.type === 'medication');
  const activeMeds = meds.filter((m) => !(m.meta && m.meta.endDate));
  const pastMeds = meds.filter((m) => m.meta && m.meta.endDate);
  const doctors = people.filter((p) => p.meta && /m[ée]dic/i.test(p.meta.role || ''));

  // agrupa indicadores por nome
  const byIndicator = {};
  metrics.forEach((m) => { const k = m.title; (byIndicator[k] = byIndicator[k] || []).push({ value: m.amount, unit: m.meta && m.meta.unit, refRange: m.meta && m.meta.refRange, status: m.meta && m.meta.status, date: m.date }); });

  const analyzeDoc = async (doc) => {
    setAnalyzing(true); setAnalyzeProgress(doc.title);
    try {
      const atts = [];
      for (const a of (doc.meta.attachments || []).slice(0, 4)) {
        const full = await loadAttachment(a.id);
        if (full && full.dataUrl) atts.push({ dataUrl: full.dataUrl });
      }
      if (!atts.length) { flash(lang === 'pt' ? 'Este documento não tem anexo pra analisar.' : 'No attachment to analyze.'); setAnalyzing(false); return; }
      const r = await authFetch('/api/health-analyze', { method: 'POST', body: JSON.stringify({ docId: doc.id, attachments: atts, notes: doc.notes, fallbackDate: doc.date }) });
      const j = await r.json();
      if (j.error) {
        // erro de verdade (não confundir com "nada encontrado") — NÃO marca como já analisado, pra poder tentar de novo
        flash((lang === 'pt' ? 'Dr. Claude — erro: ' : 'Dr. Claude — error: ') + j.error);
      } else if (j.indicators && j.indicators.length) {
        j.indicators.forEach((ind) => {
          addItem({ type: 'healthMetric', domain: 'health', title: ind.indicator, amount: ind.value, date: ind.date || doc.date, meta: { unit: ind.unit, refRange: ind.refRange, status: ind.status, sourceDocId: doc.id } });
        });
        flash(`Dr. Claude: ${j.indicators.length} ${lang === 'pt' ? 'indicadores encontrados' : 'indicators found'} ✓`);
      } else {
        flash(lang === 'pt' ? 'Nenhum indicador numérico encontrado neste documento.' : 'No numeric indicators found.');
        // só marca como já analisado quando a resposta foi genuinamente vazia (sem erro)
        addItem({ type: 'healthMetric', domain: 'health', title: '__checked__', amount: 0, date: doc.date, status: 'done', meta: { sourceDocId: doc.id, hidden: true } });
      }
    } catch (e) { flash((lang === 'pt' ? 'Erro ao analisar: ' : 'Analysis error: ') + String(e.message || e)); }
    setAnalyzing(false); setAnalyzeProgress('');
  };
  const analyzeAll = async () => { for (const d of unanalyzed) { await analyzeDoc(d); } };

  const visibleIndicators = Object.entries(byIndicator).filter(([k]) => k !== '__checked__');

  return (
    <div style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 16px', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 6px)' }}>
        <button onClick={back} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', display: 'flex' }}><ChevronLeft size={22} /></button>
        <DrClaudeBadge />
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{lang === 'pt' ? 'Histórico Médico' : 'Medical History'}</div>
          <div style={{ fontSize: 11, color: C.text3 }}>{lang === 'pt' ? 'Curadoria pelo Dr. Claude' : 'Curated by Dr. Claude'}</div>
        </div>
      </div>

      {unanalyzed.length > 0 && (
        <div style={{ ...card, padding: 14, marginBottom: 14, borderColor: C.blue + '44', background: C.blue + '0e' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
            <Sparkles size={16} style={{ color: C.blue, marginTop: 2, flexShrink: 0 }} />
            <div style={{ fontSize: 12.5, color: C.text2, lineHeight: 1.5 }}>{unanalyzed.length} {lang === 'pt' ? `exame(s) ainda não analisado(s) pelo Dr. Claude.` : 'exam(s) not yet analyzed.'}</div>
          </div>
          <Btn onClick={analyzeAll} disabled={analyzing} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}>
            {analyzing ? <><Loader2 size={15} className="spin" />{analyzeProgress || '...'}</> : <><Stethoscope size={15} />{lang === 'pt' ? 'Analisar com Dr. Claude' : 'Analyze with Dr. Claude'}</>}
          </Btn>
        </div>
      )}
      {openClaude && (
        <Btn kind="soft" onClick={() => openClaude(lang === 'pt' ? 'Quero conversar sobre toda a minha saúde — meu histórico médico completo (condições, alergias, medicações, indicadores de exames, achados de exames de imagem, sono).' : 'I want to talk about my overall health — my full medical history (conditions, allergies, medications, exam indicators, imaging findings, sleep).')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}>
          <DrClaudeBadge size={16} />{lang === 'pt' ? 'Conversar com o Dr. Claude sobre minha saúde' : 'Talk to Dr. Claude about my health'}
        </Btn>
      )}

      <SectionTitle icon={Moon} label={lang === 'pt' ? 'Sono & Rotina (Oura)' : 'Sleep & Routine'} color={C.violet} />
      <SleepReadinessHistory health={health} lang={lang} />
      {(!health || Object.keys(health).length < 2) && <HintCard icon={Moon} text={lang === 'pt' ? 'Conecte o Oura Ring pra trazer o histórico de sono aqui.' : 'Connect Oura Ring to see sleep history.'} />}

      <SectionTitle icon={HeartPulse} label={lang === 'pt' ? 'Condições' : 'Conditions'} color={C.rose} />
      {conditions.length === 0 ? <Empty icon={HeartPulse} text={t('nothingHere')} /> : conditions.map((c) => (
        <div key={c.id} onClick={() => onOpen && onOpen(c)} style={{ ...card, padding: 12, marginBottom: 7, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: onOpen ? 'pointer' : 'default' }}>
          <div><div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.title}</div>{c.meta && c.meta.since && <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{lang === 'pt' ? 'desde' : 'since'} {fmtDate(c.meta.since, lang)}</div>}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {c.meta && c.meta.status && <span style={{ fontSize: 10, color: c.meta.status === 'ativa' ? C.rose : C.green, border: `1px solid currentColor`, borderRadius: 999, padding: '2px 8px' }}>{c.meta.status}</span>}
            <Pencil size={13} style={{ color: C.text3, flexShrink: 0 }} />
          </div>
        </div>
      ))}
      <Btn kind="soft" onClick={() => setAdding('condition')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={14} />{lang === 'pt' ? 'Adicionar condição' : 'Add condition'}</Btn>

      <SectionTitle icon={AlertTriangle} label={lang === 'pt' ? 'Alergias' : 'Allergies'} color={C.accent} />
      {allergies.length === 0 ? <Empty icon={AlertTriangle} text={t('nothingHere')} /> : allergies.map((a) => (
        <div key={a.id} onClick={() => onOpen && onOpen(a)} style={{ ...card, padding: 12, marginBottom: 7, cursor: onOpen ? 'pointer' : 'default', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><div style={{ fontSize: 13.5, fontWeight: 600 }}>{a.title}</div>{(a.meta && (a.meta.reaction || a.meta.severity)) && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>{[a.meta.severity, a.meta.reaction].filter(Boolean).join(' · ')}</div>}</div>
          <Pencil size={13} style={{ color: C.text3, flexShrink: 0 }} />
        </div>
      ))}
      <Btn kind="soft" onClick={() => setAdding('allergy')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={14} />{lang === 'pt' ? 'Adicionar alergia' : 'Add allergy'}</Btn>

      <SectionTitle icon={Pill} label={lang === 'pt' ? 'Medicações em uso' : 'Current medications'} color={C.violet} />
      {activeMeds.length === 0 ? <Empty icon={Pill} text={t('nothingHere')} /> : activeMeds.map((m) => (
        <div key={m.id} onClick={() => onOpen && onOpen(m)} style={{ ...card, padding: 12, marginBottom: 7, cursor: onOpen ? 'pointer' : 'default', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div style={{ fontSize: 13.5, fontWeight: 600 }}>{m.title}</div>
          <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>{[m.meta && m.meta.dose, m.meta && m.meta.frequency].filter(Boolean).join(' · ')}</div>
          {m.meta && m.meta.prescribedBy && <div style={{ fontSize: 10.5, color: C.violet, marginTop: 3 }}>Dr(a). {m.meta.prescribedBy}</div>}</div>
          <Pencil size={13} style={{ color: C.text3, flexShrink: 0, marginTop: 2 }} />
        </div>
      ))}
      <Btn kind="soft" onClick={() => setAdding('medication')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={14} />{lang === 'pt' ? 'Adicionar medicação' : 'Add medication'}</Btn>
      {pastMeds.length > 0 && (
        <>
          <SectionTitle icon={Pill} label={lang === 'pt' ? 'Histórico de medicações' : 'Past medications'} color={C.text2} />
          {pastMeds.map((m) => <div key={m.id} onClick={() => onOpen && onOpen(m)} style={{ ...card, padding: 12, marginBottom: 7, opacity: 0.65, cursor: onOpen ? 'pointer' : 'default' }}><div style={{ fontSize: 13, fontWeight: 600 }}>{m.title}</div><div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{fmtDate(m.meta.startDate, lang)} – {fmtDate(m.meta.endDate, lang)}</div></div>)}
        </>
      )}

      <SectionTitle icon={Utensils} label={lang === 'pt' ? 'Dieta' : 'Diet'} color={C.green} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input ref={mealFileRef} type="file" accept="image/*" capture="environment" onChange={pickMealPhoto} style={{ display: 'none' }} />
        <Btn onClick={() => mealFileRef.current && mealFileRef.current.click()} disabled={mealLoading} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>{mealLoading ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}{mealLoading ? (lang === 'pt' ? 'Analisando...' : 'Analyzing...') : (lang === 'pt' ? 'Fotografar refeição' : 'Photo meal')}</Btn>
        <Btn kind="soft" onClick={() => setDietOpen(true)} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 14px' }}><Sparkles size={15} />{lang === 'pt' ? 'Assistente' : 'Assistant'}</Btn>
      </div>
      {meals.length === 0 ? <Empty icon={Utensils} text={lang === 'pt' ? 'Nenhuma refeição registrada ainda.' : 'No meals logged yet.'} /> : meals.slice(0, 8).map((m) => (
        <div key={m.id} style={{ ...card, padding: 12, marginBottom: 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{m.title}</div>
            <span style={{ fontSize: 11, color: C.text3 }}>{fmtDate(m.date, lang)} {m.time || ''}</span>
          </div>
          {m.meta && m.meta.calories != null && (
            <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: C.text2 }}>
              <span>{m.meta.calories} kcal</span>
              {m.meta.protein != null && <span>P: {m.meta.protein}g</span>}
              {m.meta.carbs != null && <span>C: {m.meta.carbs}g</span>}
              {m.meta.fat != null && <span>G: {m.meta.fat}g</span>}
            </div>
          )}
        </div>
      ))}

      {doctors.length > 0 && (
        <>
          <SectionTitle icon={Stethoscope} label={lang === 'pt' ? 'Médicos' : 'Doctors'} color={C.sky} />
          {doctors.map((doc) => {
            const apps = items.filter((i) => i.type === 'appointment' && i.meta && i.meta.doctor === doc.title).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            const prescribed = meds.filter((m) => m.meta && m.meta.prescribedBy === doc.title);
            return (
              <div key={doc.id} style={{ ...card, padding: 13, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <Avatar photo={doc.meta && doc.meta.photo} name={doc.title} size={38} color={C.sky} />
                  <div><div style={{ fontSize: 14, fontWeight: 700 }}>{doc.title}</div><div style={{ fontSize: 11, color: C.text3 }}>{doc.meta && doc.meta.company}</div></div>
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11.5, color: C.text2 }}>
                  <span>{apps.length} {lang === 'pt' ? 'consulta(s)' : 'visit(s)'}</span>
                  <span>{prescribed.length} {lang === 'pt' ? 'prescrição(ões)' : 'prescription(s)'}</span>
                </div>
              </div>
            );
          })}
        </>
      )}

      <SectionTitle icon={Activity} label={lang === 'pt' ? 'Indicadores' : 'Indicators'} color={C.blue} />
      {visibleIndicators.length === 0 ? <Empty icon={Activity} text={lang === 'pt' ? 'Nenhum indicador ainda. Suba exames em Saúde e analise aqui.' : 'No indicators yet.'} /> : (() => {
        const allRows = sortedIndicatorRows(byIndicator);
        const PREVIEW = 20;
        const rows = allRows.slice(0, PREVIEW);
        return (
          <>
            <div style={{ fontSize: 10.5, color: C.text3, marginBottom: 8 }}>{lang === 'pt' ? 'Valores em vermelho/azul estão fora da faixa de referência (alto/baixo). Arraste pra ver mais datas.' : 'Red/blue values are out of reference range. Scroll for more dates.'}</div>
            <IndicatorsTable rows={rows} lang={lang} />
            {allRows.length > PREVIEW && goIndicatorsFull && (
              <Btn kind="soft" onClick={goIndicatorsFull} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}>
                <Activity size={14} />{lang === 'pt' ? `Ver tabela completa (${allRows.length})` : `See full table (${allRows.length})`}
              </Btn>
            )}
          </>
        );
      })()}

      {adding && (
        <AddModal
          title={t('t_' + adding)}
          icon={typeIcon(adding)}
          draft={{ type: adding, domain: 'health', meta: adding === 'condition' ? { status: 'ativa' } : {} }}
          allowedTypes={[adding]}
          lang={lang} t={t} people={people}
          onClose={() => setAdding(null)}
          onSave={(x) => { addItem({ domain: 'health', ...x }); flash(t('savedOne')); setAdding(null); }}
        />
      )}
    </div>
  );
}
function NewsScreen({ lang, t, back, news, loading, onRefresh, onSaveItem, onSendItem, savedNews = [], onUnsave }) {
  const [reader, setReader] = useState(null); // noticia aberta no leitor interno
  const [tab, setTab] = useState('feed'); // feed | saved
  const savedLinks = new Set((savedNews || []).map((x) => x.meta && x.meta.link).filter(Boolean));
  const isSaved = (n) => savedLinks.has(n.link);
  const shareNative = async (n) => {
    const shareData = { title: n.title, text: n.summary || n.title, url: n.link };
    try { if (navigator.share) { await navigator.share(shareData); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    onSendItem && onSendItem(n); // fallback: email
  };
  const list = tab === 'saved'
    ? (savedNews || []).map((it) => ({ title: it.title, link: it.meta && it.meta.link, summary: (it.notes || '').split('\n')[0], theme: (it.meta && it.meta.theme) || 'tech', pub: it.meta && it.meta.pub, source: it.meta && it.meta.source, _saved: it }))
    : (news || []);
  const THEMES = {
    tech: { label: lang === 'pt' ? 'Tecnologia & IA' : 'Tech & AI', color: C.blue },
    financas: { label: lang === 'pt' ? 'Mercado financeiro' : 'Finance', color: C.green },
    negocios: { label: lang === 'pt' ? 'Negócios & M&A' : 'Business & M&A', color: C.accent },
    carros: { label: lang === 'pt' ? 'Carros' : 'Cars', color: C.rose },
    espaco: { label: lang === 'pt' ? 'Espaço & foguetes' : 'Space', color: C.violet },
    aviacao: { label: lang === 'pt' ? 'Aviação' : 'Aviation', color: C.sky },
  };
  const sourceName = (n) => (n.source || '').replace(/\.com|\.br|\.co|\.info|\.net/g, '').split('.').pop() || 'web';

  if (reader) {
    return (
      <div>
        <button onClick={() => setReader(null)} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 10, padding: '4px 0' }}><ChevronLeft size={16} />{t('news')}</button>
        <div style={{ fontSize: 10.5, color: (THEMES[reader.theme] || {}).color || C.accent, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{sourceName(reader)}{reader.pub ? ' · ' + timeAgo(reader.pub, lang) : ''}</div>
        <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.3, marginBottom: 12 }}>{reader.title}</div>
        {reader.summary && <div style={{ ...card, padding: 15, fontSize: 14, lineHeight: 1.6, color: C.text, marginBottom: 12 }}>{reader.summary}</div>}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <a href={reader.link} target="_blank" rel="noreferrer" style={{ flex: 1, textDecoration: 'none' }}><Btn style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><ArrowRight size={15} />{lang === 'pt' ? 'Abrir no site' : 'Open site'}</Btn></a>
          <Btn kind="soft" onClick={() => { if (isSaved(reader)) { onUnsave && onUnsave(reader); } else { onSaveItem && onSaveItem(reader); } }} style={{ display: 'flex', gap: 5, alignItems: 'center', padding: '10px 14px' }}><Star size={14} style={{ color: isSaved(reader) ? C.accent : C.text2, fill: isSaved(reader) ? C.accent : 'none' }} /></Btn>
          <Btn kind="soft" onClick={() => shareNative(reader)} style={{ display: 'flex', gap: 5, alignItems: 'center', padding: '10px 14px' }}><Send size={14} /></Btn>
        </div>
        <div style={{ ...card, padding: 16, textAlign: 'center', color: C.text3 }}>
          <Newspaper size={22} style={{ color: C.text3, marginBottom: 8 }} />
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{lang === 'pt' ? 'Toque em “Abrir no site” para ler a matéria completa na fonte original.' : 'Tap “Open site” to read the full article.'}</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('home')}</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <ScreenTitle title={t('news')} />
        <button onClick={onRefresh} style={{ ...card, padding: '7px 11px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>{loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{t('refresh')}</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <Chip active={tab === 'feed'} onClick={() => setTab('feed')}>{lang === 'pt' ? 'Destaques' : 'Feed'}</Chip>
        <Chip active={tab === 'saved'} onClick={() => setTab('saved')}>⭐ {lang === 'pt' ? 'Salvos' : 'Saved'}{savedNews.length ? ` (${savedNews.length})` : ''}</Chip>
      </div>
      {(!news && loading) ? (
        <div style={{ ...card, padding: 30, textAlign: 'center', color: C.text3, display: 'flex', gap: 9, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={16} className="spin" />{lang === 'pt' ? 'Curando as melhores para você…' : 'Curating…'}</div>
      ) : (list && list.length === 0) ? (
        <Empty icon={tab === 'saved' ? Star : Newspaper} text={tab === 'saved' ? (lang === 'pt' ? 'Nada salvo ainda. Toque na estrela de uma notícia.' : 'Nothing saved yet.') : (lang === 'pt' ? 'Nenhuma notícia agora.' : 'No news.')} />
      ) : (
        (list || []).map((n, i) => {
          const th = THEMES[n.theme] || { label: n.theme, color: C.text3 };
          return (
            <div key={i} onClick={() => setReader(n)} style={{ ...card, padding: 15, marginBottom: 10, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                <span style={{ fontSize: 10.5, color: th.color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{sourceName(n)}</span>
                {n.pub && <span style={{ fontSize: 10, color: C.text3 }}>{timeAgo(n.pub, lang)}</span>}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{n.title}</div>
              {n.summary && <div style={{ fontSize: 12.5, color: C.text2, marginTop: 6, lineHeight: 1.5 }}>{n.summary}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }} onClick={(e) => e.stopPropagation()}>
                <Btn kind="soft" onClick={() => setReader(n)} style={{ flex: 1, fontSize: 12, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><ArrowRight size={13} />{lang === 'pt' ? 'Ler' : 'Read'}</Btn>
                <Btn kind="soft" onClick={() => { if (isSaved(n) || n._saved) { onUnsave && onUnsave(n._saved || n); } else { onSaveItem && onSaveItem(n); } }} style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center', padding: '9px 12px' }}><Star size={13} style={{ color: (isSaved(n) || n._saved) ? C.accent : C.text2, fill: (isSaved(n) || n._saved) ? C.accent : 'none' }} /></Btn>
                <Btn kind="soft" onClick={() => shareNative(n)} style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center', padding: '9px 12px' }}><Send size={13} /></Btn>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/* ---------------- Calendar ---------------- */
const CAL_FILTERS = [['all', 'fAll', null], ['work', 'fWork', 'work'], ['personal', 'fPersonal', 'personal'], ['kids', 'fKids', 'kids'], ['house', 'fHouse', 'home'], ['health', 'fHealth', 'health'], ['shopping', 'fShopping', 'shopping']];
function MiniCalendar({ items, lang, t, toggleTask, onOpen }) {
  const [mode, setMode] = useState('week'); const today = todayISO(); const [sel, setSel] = useState(today); const [vm, setVm] = useState(today.slice(0, 7));
  const dated = (items || []).filter((i) => i.date && i.status !== 'done');
  const onDay = (iso) => dated.filter((i) => i.date === iso);
  const [y, m] = vm.split('-').map(Number);
  const shiftMonth = (d) => { let nm = m + d, ny = y; if (nm < 1) { nm = 12; ny--; } if (nm > 12) { nm = 1; ny++; } setVm(`${ny}-${pad2(nm)}`); };
  const shiftWeek = (d) => setSel(addDays(sel, d * 7));
  let cells = [];
  if (mode === 'month') { const sw = new Date(y, m - 1, 1).getDay(); const di = new Date(y, m, 0).getDate(); for (let i = 0; i < sw; i++) cells.push(null); for (let d = 1; d <= di; d++) cells.push(`${y}-${pad2(m)}-${pad2(d)}`); }
  else { const base = new Date(sel + 'T00:00:00'); const ws = new Date(base); ws.setDate(base.getDate() - base.getDay()); for (let i = 0; i < 7; i++) { const d = new Date(ws); d.setDate(ws.getDate() + i); cells.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); } }
  const dayItems = onDay(sel).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString(loc(lang), { month: 'long', year: 'numeric' });
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
        <Chip active={mode === 'week'} onClick={() => setMode('week')}>{t('week')}</Chip>
        <Chip active={mode === 'month'} onClick={() => setMode('month')}>{t('month')}</Chip>
      </div>
      <div style={{ ...card, padding: 12, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => (mode === 'month' ? shiftMonth(-1) : shiftWeek(-1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronLeft size={20} /></button>
          <span style={{ fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>{mode === 'month' ? monthLabel : `${t('week')} · ${fmtDate(cells[0], lang)}`}</span>
          <button onClick={() => (mode === 'month' ? shiftMonth(1) : shiftWeek(1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronRight size={20} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3, marginBottom: 4 }}>{WD[lang].map((wd) => <div key={wd} style={{ textAlign: 'center', fontSize: 10.5, color: C.text3, padding: '2px 0' }}>{wd}</div>)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
          {cells.map((iso, idx) => {
            if (!iso) return <div key={idx} />;
            const list = onDay(iso); const n = list.length; const isToday = iso === today, isSel = iso === sel;
            return (
              <button key={idx} onClick={() => setSel(iso)} style={{ aspectRatio: '1', border: isSel ? `1px solid ${C.accent}` : '1px solid transparent', background: isSel ? C.accentSoft : isToday ? C.surface2 : 'transparent', borderRadius: 9, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: 2 }}>
                <span style={{ fontSize: 13, color: isToday ? C.accent : C.text, fontWeight: isToday ? 700 : 400 }}>{Number(iso.slice(-2))}</span>
                {n > 0 && <div style={{ display: 'flex', gap: 2 }}>{Array.from({ length: Math.min(n, 3) }).map((_, k) => <span key={k} style={{ width: 4, height: 4, borderRadius: 999, background: C.violet }} />)}</div>}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, margin: '4px 2px 10px', textTransform: 'capitalize', color: sel === today ? C.accent : C.text }}>{sel === today ? t('home') : fmtLong(sel, lang)}</div>
      {mode === 'week' ? <DayPlanner dayItems={dayItems} lang={lang} t={t} onOpen={onOpen} /> : (dayItems.length === 0 ? <Empty icon={CalIcon} text={t('noItemsDay')} /> : dayItems.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />))}
    </div>
  );
}
function eventColors(i) {
  const work = i.domain === 'work' || (i.meta && i.meta.moura);
  if (work) return { bg: _theme === 'light' ? '#FEF3C7' : 'rgba(245,158,11,0.16)', border: C.sky, text: C.sky };
  const map = { personal: C.blue, kids: C.violet, health: C.green, home: C.teal };
  const col = map[i.domain] || C.text2;
  return { bg: col + (_theme === 'light' ? '20' : '1e'), border: col, text: col };
}
function teamsLink(notes) {
  if (!notes) return null;
  const m = String(notes).match(/https:\/\/teams\.microsoft\.com\/[^\s)>\]"']+/i);
  return m ? m[0] : null;
}
// empacota eventos que se sobrepõem em colunas lado a lado (como o Google Calendar) em vez de
// empilhar um em cima do outro. Retorna os mesmos itens com _col (índice da coluna) e _cols
// (total de colunas do grupo que se sobrepõe) anexados.
function layoutColumns(events) {
  const sorted = [...events].sort((a, b) => a._s - b._s || a._e - b._e);
  let columns = []; // fim (min) do último evento colocado em cada coluna
  let cluster = []; let clusterEnd = -Infinity;
  const out = [];
  const flush = () => {
    if (!cluster.length) return;
    const cols = Math.max(...cluster.map((e) => e._col)) + 1;
    cluster.forEach((e) => out.push({ ...e, _cols: cols }));
    cluster = [];
  };
  sorted.forEach((e) => {
    if (e._s >= clusterEnd) { flush(); columns = []; clusterEnd = -Infinity; }
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (columns[c] <= e._s) { columns[c] = e._e; e._col = c; placed = true; break; }
    }
    if (!placed) { columns.push(e._e); e._col = columns.length - 1; }
    clusterEnd = Math.max(clusterEnd, e._e);
    cluster.push(e);
  });
  flush();
  return out;
}
// pequeno emoji/ícone visual pra bater o olho no tipo do evento no calendário
function eventKindBadge(i) {
  if (i.type === 'meal') return <Utensils size={11} />;
  if (i.meta && i.meta.purchaseRef) return <Package size={11} />;
  return null;
}
function DayPlanner({ dayItems, lang, t, onOpen }) {
  const timed = dayItems.filter((i) => i.time && /^\d{2}:\d{2}/.test(i.time));
  const allDay = dayItems.filter((i) => !i.time || !/^\d{2}:\d{2}/.test(i.time));
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const dur = (i) => (i.meta && i.meta.durationMin) || (i.type === 'event' || i.type === 'appointment' ? 60 : 30);
  const withConf = layoutColumns(timed.map((i) => ({ ...i, _s: toMin(i.time), _e: toMin(i.time) + dur(i) })));
  if (timed.length === 0 && allDay.length === 0) return <Empty icon={CalIcon} text={t('noItemsDay')} />;
  // régua fixa 08:00–19:00; só expande se algum compromisso real cair fora dela (nunca corta um evento)
  const startH = Math.min(8, ...withConf.map((i) => Math.floor(i._s / 60)));
  const endH = Math.max(19, ...withConf.map((i) => Math.ceil(i._e / 60)));
  const hours = []; for (let h = startH; h <= endH; h++) hours.push(h);
  const PX = 52; // altura por hora
  const LANE = 50; // px reservados pra régua de horas à esquerda
  const GUT = 6; // px de margem à direita
  return (
    <div>
      {timed.length > 0 && (
        <div style={{ ...card, padding: '8px 8px 8px 0', position: 'relative', marginBottom: allDay.length > 0 ? 10 : 0 }}>
          <div style={{ position: 'relative', height: (endH - startH + 1) * PX }}>
            {hours.map((h, idx) => (
              <div key={h} style={{ position: 'absolute', top: idx * PX, left: 0, right: 0, height: PX, borderTop: `1px solid ${C.borderSoft}`, display: 'flex' }}>
                <span style={{ fontSize: 10, color: C.text3, width: 42, textAlign: 'right', paddingRight: 8, marginTop: -6 }}>{pad2(h)}:00</span>
              </div>
            ))}
            {withConf.map((i) => {
              const top = ((i._s - startH * 60) / 60) * PX;
              const height = Math.max(24, (dur(i) / 60) * PX - 3);
              const col = eventColors(i);
              const link = teamsLink(i.notes);
              const isWork = i.domain === 'work' || (i.meta && i.meta.moura);
              const cols = i._cols || 1;
              const left = `calc(${LANE}px + (100% - ${LANE + GUT}px) * ${i._col / cols})`;
              const width = `calc((100% - ${LANE + GUT}px) / ${cols} - 3px)`;
              const badge = eventKindBadge(i);
              return (
                <div key={i.id} onClick={() => onOpen(i)} style={{ position: 'absolute', top, height, left, width, background: col.bg, borderLeft: `3px solid ${col.border}`, borderRadius: 8, padding: '5px 8px', cursor: 'pointer', overflow: 'hidden', boxSizing: 'border-box', boxShadow: cols > 1 ? `0 0 0 1px ${C.surface}` : 'none' }}>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    {isWork && <WorkBadge size={12} />}
                    {badge && <span style={{ color: col.text, display: 'flex', flexShrink: 0 }}>{badge}</span>}
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: col.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isWork ? (i.title || '').replace(/^\s*\(m\)\s*/i, '') : i.title}</span>
                    {link && <Video size={11} style={{ color: col.text, flexShrink: 0 }} />}
                  </div>
                  <div style={{ fontSize: 10, color: col.text, opacity: 0.8 }}>{i.time}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {allDay.length > 0 && <div>{allDay.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={() => {}} onOpen={onOpen} />)}</div>}
    </div>
  );
}
/* mini-planner compacto (usado na Hoje): barras proporcionais à duração, sem grade de horas fixa (span cruza meia-noite) */
function MiniPlanner({ items, lang, t, onOpen, today }) {
  const dur = (i) => (i.meta && i.meta.durationMin) || (i.type === 'event' || i.type === 'appointment' ? 60 : 30);
  const maxDur = Math.max(60, ...items.map(dur));
  return (
    <div>
      {items.map((i) => {
        const isTom = i.date !== today;
        const isWork = i.domain === 'work' || (i.meta && i.meta.moura);
        const col = eventColors(i);
        const d = dur(i);
        const barH = Math.max(30, Math.min(64, (d / maxDur) * 64));
        return (
          <div key={i.id} onClick={() => onOpen(i)} style={{ display: 'flex', gap: 10, marginBottom: 8, cursor: 'pointer' }}>
            <div style={{ width: 44, flexShrink: 0, textAlign: 'right', paddingTop: 2 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.accent }}>{i.time || '—'}</div>
              <div style={{ fontSize: 9, color: C.text3, textTransform: 'uppercase' }}>{isTom ? (lang === 'pt' ? 'amanhã' : 'tmrw') : (lang === 'pt' ? 'hoje' : 'today')}</div>
            </div>
            <div style={{ width: 3, borderRadius: 999, background: col.border, height: barH, flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
              <div style={{ fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                {isWork && <WorkBadge size={13} />}
                {i.meta && i.meta.milestone && <Star size={12} style={{ color: C.accent }} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isWork ? (i.title || '').replace(/^\s*\(m\)\s*/i, '') : i.title}</span>
              </div>
              <div style={{ fontSize: 11, color: C.text3, marginTop: 1 }}>{t('t_' + i.type)}{i.meta && i.meta.durationMin ? ` · ${i.meta.durationMin} min` : ''}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function CalendarScreen({ items, lang, t, toggleTask, onOpen, onRefresh, onMount }) {
  useEffect(() => { if (onMount) onMount(); }, []);
  const [mode, setMode] = useState('week'); const [spin, setSpin] = useState(false); const today = todayISO(); const [sel, setSel] = useState(today); const [vm, setVm] = useState(today.slice(0, 7)); const [filter, setFilter] = useState(null); const [scope, setScope] = useState('all');
  // 'purchase' fica de fora do calendário: quando um pedido é enviado, um evento (type 'event', domain 'shopping')
  // com a data de chegada é criado automaticamente — é ele que deve aparecer, não a compra em si (que tem a data do pedido).
  const CAL_EXCLUDE = ['account', 'person', 'message', 'vehicle', 'note', 'purchase'];
  const dated = items.filter((i) => i.date && i.status !== 'done' && !CAL_EXCLUDE.includes(i.type) && (scope === 'all' || ['event', 'appointment', 'flight', 'trip', 'document', 'bill'].includes(i.type)) && (!filter || i.domain === filter));
  const onDay = (iso) => dated.filter((i) => i.date === iso);
  const [y, m] = vm.split('-').map(Number);
  const shiftMonth = (d) => { let nm = m + d, ny = y; if (nm < 1) { nm = 12; ny--; } if (nm > 12) { nm = 1; ny++; } setVm(`${ny}-${pad2(nm)}`); };
  const shiftWeek = (d) => setSel(addDays(sel, d * 7));
  let cells = [];
  if (mode === 'month') { const sw = new Date(y, m - 1, 1).getDay(); const di = new Date(y, m, 0).getDate(); for (let i = 0; i < sw; i++) cells.push(null); for (let d = 1; d <= di; d++) cells.push(`${y}-${pad2(m)}-${pad2(d)}`); }
  else { const base = new Date(sel + 'T00:00:00'); const ws = new Date(base); ws.setDate(base.getDate() - base.getDay()); for (let i = 0; i < 7; i++) { const d = new Date(ws); d.setDate(ws.getDate() + i); cells.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); } }
  const dayItems = onDay(sel).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString(loc(lang), { month: 'long', year: 'numeric' });
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 600 }}>{t('calendar')}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Chip active={mode === 'week'} onClick={() => setMode('week')}>{t('week')}</Chip>
          <Chip active={mode === 'month'} onClick={() => setMode('month')}>{t('month')}</Chip>
          {onRefresh && <button onClick={() => { setSpin(true); Promise.resolve(onRefresh()).finally(() => setTimeout(() => setSpin(false), 600)); }} title={t('refresh')} style={{ ...card, padding: 7, color: C.text2, cursor: 'pointer', display: 'flex' }}><RefreshCw size={14} className={spin ? 'spin' : ''} /></button>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <Chip active={scope === 'all'} onClick={() => setScope('all')}>{t('everything')}</Chip>
        <Chip active={scope === 'commit'} onClick={() => setScope('commit')} color={C.blue}>{t('onlyCommitments')}</Chip>
      </div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 4 }}>
        {CAL_FILTERS.map(([k, lk, dom]) => <Chip key={k} active={filter === dom} onClick={() => setFilter(dom)}>{t(lk)}</Chip>)}
      </div>
      <div style={{ ...card, padding: 12, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => (mode === 'month' ? shiftMonth(-1) : shiftWeek(-1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronLeft size={20} /></button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>{mode === 'month' ? monthLabel : `${t('week')} · ${fmtDate(cells[0], lang)}`}</span>
            {sel !== today && <button onClick={() => { setVm(today.slice(0, 7)); setSel(today); }} style={{ background: C.accentSoft, border: 'none', color: C.accent, cursor: 'pointer', fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '3px 10px' }}>{lang === 'pt' ? 'Hoje' : 'Today'}</button>}
          </div>
          <button onClick={() => (mode === 'month' ? shiftMonth(1) : shiftWeek(1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronRight size={20} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3, marginBottom: 4 }}>{WD[lang].map((wd) => <div key={wd} style={{ textAlign: 'center', fontSize: 10.5, color: C.text3, padding: '2px 0' }}>{wd}</div>)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
          {cells.map((iso, idx) => {
            if (!iso) return <div key={idx} />;
            const list = onDay(iso); const n = list.length; const isToday = iso === today, isSel = iso === sel;
            const pinColor = (i) => (i.domain === 'work' || (i.meta && i.meta.moura)) ? C.sky : (i.domain === 'personal' ? C.blue : i.domain === 'kids' ? C.violet : i.domain === 'health' ? C.green : C.text2);
            return (
              <button key={idx} onClick={() => setSel(iso)} style={{ aspectRatio: '1', border: isSel ? `1px solid ${C.accent}` : '1px solid transparent', background: isSel ? C.accentSoft : isToday ? C.surface2 : 'transparent', borderRadius: 9, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: 2 }}>
                <span style={{ fontSize: 13, color: isToday ? C.accent : C.text, fontWeight: isToday ? 700 : 400 }}>{Number(iso.slice(-2))}</span>
                {n > 0 && <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 30 }}>{list.slice(0, 4).map((it, k) => <span key={k} style={{ width: 4, height: 4, borderRadius: 999, background: pinColor(it) }} />)}</div>}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, margin: '4px 2px 10px', textTransform: 'capitalize', color: sel === today ? C.accent : C.text }}>{sel === today ? t('home') : fmtLong(sel, lang)}</div>
      <DayPlanner dayItems={dayItems} lang={lang} t={t} onOpen={onOpen} />
    </div>
  );
}

/* ---------------- Dashboard grid + generic module ---------------- */
// lista vertical com reordenação por arrastar (estilo iOS: segura a alça e arrasta pra cima/baixo).
// Funciona com mouse e touch via Pointer Events — sem lib externa.
function DragReorderList({ orderKeys, onReorder, renderItem, gap = 10 }) {
  const [order, setOrder] = useState(orderKeys);
  useEffect(() => { setOrder(orderKeys); }, [orderKeys.join('|')]);
  const refs = useRef({});
  const drag = useRef(null);
  const [draggingKey, setDraggingKey] = useState(null);
  const [dragY, setDragY] = useState(0);

  const onPointerDown = (key, e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    drag.current = { key, startY: e.clientY, index: order.indexOf(key) };
    setDraggingKey(key); setDragY(0);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.startY;
    setDragY(dy);
    const el = refs.current[drag.current.key];
    if (!el) return;
    const step = el.offsetHeight + gap;
    const shift = Math.round(dy / step);
    if (!shift) return;
    const curIndex = order.indexOf(drag.current.key);
    const newIndex = Math.max(0, Math.min(order.length - 1, curIndex + shift));
    if (newIndex !== curIndex) {
      const next = [...order];
      next.splice(curIndex, 1);
      next.splice(newIndex, 0, drag.current.key);
      setOrder(next);
      drag.current.startY = e.clientY;
      setDragY(0);
    }
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDraggingKey(null); setDragY(0);
    onReorder(order);
  };
  return (
    <div>
      {order.map((key, idx) => {
        const isDragging = key === draggingKey;
        return (
          <div key={key} ref={(el) => (refs.current[key] = el)}
            style={{ marginBottom: gap, transform: isDragging ? `translateY(${dragY}px)` : 'none', transition: isDragging ? 'none' : 'transform .15s', position: 'relative', zIndex: isDragging ? 5 : 1, boxShadow: isDragging ? '0 8px 20px rgba(0,0,0,.25)' : 'none', touchAction: draggingKey ? 'none' : undefined }}>
            {renderItem(key, idx, { onPointerDown: (e) => onPointerDown(key, e), onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, style: { cursor: 'grab', touchAction: 'none' } })}
          </div>
        );
      })}
    </div>
  );
}
function DashboardScreen({ items, lang, t, open, gmailCount, goNews, order, setOrder }) {
  const [editing, setEditing] = useState(false);
  // ordena os modulos conforme a ordem salva; novos modulos vao para o fim
  const ordered = [...MODULES].sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  const byKey = {}; MODULES.forEach((m) => { byKey[m.key] = m; });
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <ScreenTitle title={t('dashboard')} sub={t('yourModules')} />
        <button onClick={() => setEditing((v) => !v)} style={{ ...card, padding: '7px 11px', color: editing ? C.accent : C.text2, cursor: 'pointer', fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}>{editing ? <><Check size={13} />{lang === 'pt' ? 'Pronto' : 'Done'}</> : <><Pencil size={13} />{lang === 'pt' ? 'Ordenar' : 'Reorder'}</>}</button>
      </div>
      {/* Card de Noticias em destaque */}
      <button onClick={goNews} style={{ ...card, padding: 15, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, width: '100%', marginBottom: 10, border: `1px solid ${C.blue}33`, color: C.text }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: C.blue + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Newspaper size={19} style={{ color: C.blue }} /></div>
        <div style={{ flex: 1 }}><div style={{ fontSize: 14.5, fontWeight: 600, color: C.text }}>{t('news')}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>{lang === 'pt' ? 'Curadoria do seu interesse' : 'Curated for you'}</div></div>
        <ChevronRight size={18} style={{ color: C.text3 }} />
      </button>
      {editing ? (
        <DragReorderList orderKeys={ordered.map((m) => m.key)} onReorder={setOrder} renderItem={(key, idx, handleProps) => {
          const mo = byKey[key]; const count = mo.key === 'gmail' ? (gmailCount || 0) : items.filter(mo.filter).length; const Ic = mo.icon;
          return (
            <div style={{ ...card, padding: 15, display: 'flex', alignItems: 'center', gap: 11 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: mo.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={18} style={{ color: mo.color }} /></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600 }}>{t(mo.key)}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>{count} {t('items')}</div></div>
              <div {...handleProps} style={{ ...handleProps.style, color: C.text3, padding: 6 }}><GripVertical size={18} /></div>
            </div>
          );
        }} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {ordered.map((mo) => { const count = mo.key === 'gmail' ? (gmailCount || 0) : items.filter(mo.filter).length; const Ic = mo.icon; return (
            <button key={mo.key} onClick={() => open(mo)} style={{ ...card, padding: 15, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 92, alignItems: 'flex-start', border: 'none', color: C.text, width: '100%' }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: mo.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={18} style={{ color: mo.color }} /></div>
              <div><div style={{ fontSize: 14, fontWeight: 600 }}>{t(mo.key)}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>{count} {t('items')}</div></div>
            </button>
          ); })}
        </div>
      )}
    </div>
  );
}
function ModuleHeader({ module, t, back }) {
  const Ic = module.icon;
  return <>
    <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('dashboard')}</button>
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, background: module.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={20} style={{ color: module.color }} /></div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{t(module.key)}</div>
    </div>
  </>;
}
const TASK_FILTERS = [['fAll', (i) => i.status !== 'done'], ['fWork', (i) => i.domain === 'work' && i.status !== 'done'], ['fPersonal', (i) => !['work', 'home', 'kids'].includes(i.domain) && i.status !== 'done'], ['fHouse', (i) => i.domain === 'home' && i.status !== 'done'], ['fKids', (i) => i.domain === 'kids' && i.status !== 'done'], ['fDone', (i) => i.status === 'done']];
function ModuleScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, addItems, updateItem, delItem, flash, ttConnected, ttProjects, onCreateTick, reloadTick, setPendingCount }) {
  const [adding, setAdding] = useState(false); const [tf, setTf] = useState(0); const [toTick, setToTick] = useState(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [workScan, setWorkScan] = useState({ loading: false });
  const needsDomain = items.filter((i) => i.meta && i.meta.needsDomainDecision);
  useEffect(() => { if (module.key === 'tasks' && setPendingCount) setPendingCount('work', needsDomain.length); }, [module.key, needsDomain.length]);
  const runWorkScan = () => {
    setWorkScan({ loading: true });
    scanWorkEmails({ addItems, flash, t, lang, items: itemsRef.current }).then(() => setWorkScan({ loading: false }));
  };
  const scannedOnMount = useRef(false);
  useEffect(() => {
    if (module.key !== 'tasks') return;
    if (scannedOnMount.current) return;
    scannedOnMount.current = true;
    runWorkScan();
  }, [module.key]);
  const decideDomain = (item, domain) => updateItem(item.id, { domain, meta: { ...item.meta, needsDomainDecision: false } });
  const [workFilter, setWorkFilter] = useState('all'); // para aba trabalho: all | events | tasks
  const [docCat, setDocCat] = useState('all'); // para aba documentos: all | work | health | personal | kids
  const [taskSrc, setTaskSrc] = useState('all'); // filtro de origem, acima de tudo: all | ticktick | rest
  const isTT = (i) => !!(i.meta && i.meta.external === 'ticktick');
  const [ttProjectFilter, setTtProjectFilter] = useState(null); // filtro por lista do TickTick
  useEffect(() => { if (taskSrc === 'ticktick' && tf !== 0 && tf !== 5) setTf(0); }, [taskSrc]);
  const [grace, setGrace] = useState({}); // id -> true: recem concluida, ainda visivel por 5s
  const graceToggle = (id) => {
    const it = items.find((x) => x.id === id) || {};
    const wasDone = it.status === 'done';
    toggleTask(id);
    if (!wasDone) {
      setGrace((g) => ({ ...g, [id]: true }));
      setTimeout(() => setGrace((g) => { const n = { ...g }; delete n[id]; return n; }), 5000);
    } else {
      setGrace((g) => { const n = { ...g }; delete n[id]; return n; });
    }
  };
  const base = items.filter(module.filter);
  const list = (module.key === 'tasks' ? base.filter((i) => !(i.meta && i.meta.needsDomainDecision)
      && (taskSrc === 'all' || (taskSrc === 'ticktick' ? isTT(i) : !isTT(i)))
      && (TASK_FILTERS[tf][1](i) || (tf !== 5 && grace[i.id]))
      && (!ttProjectFilter || (i.meta && i.meta.project) === ttProjectFilter))
    : module.key === 'work' ? base.filter((i) => workFilter === 'all' ? true : workFilter === 'events' ? (i.type === 'event' || i.type === 'appointment') : i.type === 'task') : module.key === 'docs' ? base.filter((i) => docCat === 'all' ? true : docCat === 'kids' ? (i.domain === 'kids' || (i.meta && i.meta.kid)) : i.domain === docCat) : base).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let hi = null;
  if (module.key === 'docs') { const soon = items.filter((i) => i.type === 'document' && i.date && i.date <= addDays(todayISO(), 60)).length; hi = { label: `${t('expiring')} (60d)`, value: String(soon), color: soon ? C.rose : C.text2 }; }
  else if (module.key === 'tasks') hi = { label: t('open'), value: String(list.filter((i) => i.status !== 'done').length), color: C.accent };
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {module.key === 'tasks' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 11.5, color: C.text3, display: 'flex', gap: 5, alignItems: 'center' }}><Mail size={12} />{lang === 'pt' ? 'Lembretes "(Trab)"' : '"(Trab)" reminders'}</span>
          <button onClick={runWorkScan} disabled={workScan.loading} style={{ ...card, padding: '5px 10px', color: C.text2, cursor: 'pointer', fontSize: 11, display: 'flex', gap: 5, alignItems: 'center' }}>{workScan.loading ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}{lang === 'pt' ? 'Verificar' : 'Check'}</button>
        </div>
      )}
      {module.key === 'tasks' && needsDomain.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8 }}>{lang === 'pt' ? `Precisam de decisão (${needsDomain.length})` : `Need a decision (${needsDomain.length})`}</div>
          {needsDomain.map((i) => {
            const Ic = typeIcon(i.type);
            return (
              <div key={i.id} style={{ ...card, padding: 13, marginBottom: 8, borderColor: C.accent + '33' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
                  <Ic size={16} style={{ color: C.accent, marginTop: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{i.title}</div>
                    <div style={{ fontSize: 11.5, color: C.text2, marginTop: 3 }}>{t('t_' + i.type)}{i.date ? ' · ' + fmtDate(i.date, lang) : ''}{i.time ? ' ' + i.time : ''}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn kind="soft" onClick={() => decideDomain(i, 'work')} style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Briefcase size={13} />{lang === 'pt' ? 'Trabalho' : 'Work'}</Btn>
                  <Btn kind="soft" onClick={() => decideDomain(i, 'personal')} style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><UserRound size={13} />{lang === 'pt' ? 'Pessoal' : 'Personal'}</Btn>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {module.key === 'tasks' && ttConnected && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button onClick={() => reloadTick && reloadTick()} style={{ ...card, padding: '5px 10px', color: C.text2, cursor: 'pointer', fontSize: 11, display: 'flex', gap: 5, alignItems: 'center' }}><RefreshCw size={11} />{t('refresh')}</button>
        </div>
      )}
      {module.key === 'tasks' && !ttConnected && <HintCard icon={RefreshCw} text={t('tickHint')} />}
      {module.key === 'tasks' && ttConnected && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <Chip active={taskSrc === 'all'} onClick={() => setTaskSrc('all')}>{lang === 'pt' ? 'Tudo' : 'All'}</Chip>
          <Chip active={taskSrc === 'ticktick'} onClick={() => setTaskSrc('ticktick')} color={C.green}>TickTick</Chip>
          <Chip active={taskSrc === 'rest'} onClick={() => setTaskSrc('rest')} color={C.accent}>{lang === 'pt' ? 'Demais' : 'Rest'}</Chip>
        </div>
      )}
      {module.key === 'tasks' && <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 4, WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)', maskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)' }}>{TASK_FILTERS.map(([lk], idx) => (idx !== 0 && idx !== 5 && taskSrc === 'ticktick') ? null : <Chip key={lk} active={tf === idx} onClick={() => setTf(idx)}>{t(lk)}</Chip>)}</div>}
      {module.key === 'tasks' && taskSrc !== 'rest' && (() => {
        const projects = [...new Set(base.filter((i) => isTT(i) && i.meta && i.meta.project).map((i) => i.meta.project))];
        if (!projects.length) return null;
        return (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 6, WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)', maskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)' }}>
            <Chip active={!ttProjectFilter} onClick={() => setTtProjectFilter(null)} color={C.violet}>{lang === 'pt' ? 'Todas as listas' : 'All lists'}</Chip>
            {projects.map((p) => <Chip key={p} active={ttProjectFilter === p} onClick={() => setTtProjectFilter(p)} color={C.violet}>{p}</Chip>)}
          </div>
        );
      })()}
      {module.key === 'work' && <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}><Chip active={workFilter === 'all'} onClick={() => setWorkFilter('all')}>{lang === 'pt' ? 'Tudo' : 'All'}</Chip><Chip active={workFilter === 'events'} onClick={() => setWorkFilter('events')} color={C.accent}>{lang === 'pt' ? 'Reuniões' : 'Meetings'}</Chip><Chip active={workFilter === 'tasks'} onClick={() => setWorkFilter('tasks')} color={C.blue}>{lang === 'pt' ? 'Tarefas' : 'Tasks'}</Chip></div>}
      {module.key === 'docs' && <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 6 }}>{[['all', 'Tudo', 'All'], ['work', 'Trabalho', 'Work'], ['health', 'Saúde', 'Health'], ['personal', 'Pessoais', 'Personal'], ['kids', 'Filhos', 'Kids']].map(([k, ptL, enL]) => <Chip key={k} active={docCat === k} onClick={() => setDocCat(k)}>{lang === 'pt' ? ptL : enL}</Chip>)}</div>}
      {hi && <div style={{ ...card, padding: 16, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: 12.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.05em' }}>{hi.label}</span><span style={{ fontSize: 22, fontWeight: 600, color: hi.color }}>{hi.value}</span></div>}
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('quickAdd')}</Btn>
      {list.length === 0 ? <Empty icon={module.icon} text={t('nothingHere')} /> : list.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={module.key === 'tasks' ? graceToggle : toggleTask} onOpen={onOpen} onDelete={delItem} />)}
      {module.key === 'tasks' && ttConnected && <div style={{ fontSize: 10.5, color: C.text3, textAlign: 'center', marginTop: 16, display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'center' }}><RefreshCw size={10} style={{ color: C.green }} />{lang === 'pt' ? 'Sincronizado com o TickTick' : 'Synced with TickTick'}</div>}
      {adding && <AddModal title={`${t('quickAdd')} · ${t(module.key)}`} icon={Plus} draft={{ type: module.types[0], domain: module.key === 'docs' ? (docCat !== 'all' ? docCat : 'personal') : moduleDomain(module.key) }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => {
        if (module.key === 'tasks' && ttConnected && toTick && x.type === 'task') { onCreateTick && onCreateTick({ title: x.title, notes: x.notes, date: x.date, priority: x.priority === 1 ? 5 : x.priority === 2 ? 3 : 0, tags: x.priority === 1 ? ['Importante'] : [] }); flash(lang === 'pt' ? 'Criado no TickTick ✓' : 'Created in TickTick ✓'); }
        else { addItem({ domain: module.key === 'docs' ? (x.domain || 'personal') : moduleDomain(module.key), ...x }); flash(t('savedOne')); }
        setAdding(false);
      }} extraToggle={module.key === 'tasks' && ttConnected ? { label: lang === 'pt' ? 'Criar no TickTick' : 'Create in TickTick', value: toTick, onChange: setToTick } : null} />}
    </div>
  );
}

/* ---------------- Documents dashboard ---------------- */
function DocsScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash }) {
  const [adding, setAdding] = useState(false); const [cat, setCat] = useState('all'); const [q, setQ] = useState('');
  const docs = items.filter((i) => i.type === 'document');
  const catOf = (d) => ['work', 'health', 'personal', 'kids'].includes(d.domain) ? d.domain : 'personal';
  const CATS = [['all', lang === 'pt' ? 'Tudo' : 'All'], ['work', lang === 'pt' ? 'Trabalho' : 'Work'], ['health', lang === 'pt' ? 'Saúde' : 'Health'], ['personal', lang === 'pt' ? 'Pessoais' : 'Personal'], ['kids', lang === 'pt' ? 'Filhos' : 'Kids']];
  const soon = docs.filter((i) => i.date && i.date <= addDays(todayISO(), 60)).sort((a, b) => a.date.localeCompare(b.date));
  const matches = (d) => { if (!q.trim()) return true; const s = q.toLowerCase(); return [d.title, d.meta && d.meta.tag, d.meta && d.meta.issuer, d.meta && d.meta.holder, d.meta && d.meta.number].filter(Boolean).some((v) => String(v).toLowerCase().includes(s)); };
  const shown = docs.filter((d) => (cat === 'all' ? true : catOf(d) === cat) && matches(d));
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {soon.length > 0 && (
        <div style={{ ...card, padding: 14, marginBottom: 12, borderColor: C.rose + '44', background: C.rose + '12', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertTriangle size={17} style={{ color: C.rose, marginTop: 1 }} />
          <div><div style={{ fontSize: 13.5, fontWeight: 600 }}>{soon.length} {t('expiring').toLowerCase()} (60 dias)</div><div style={{ fontSize: 12, color: C.text3, marginTop: 3, lineHeight: 1.5 }}>{soon.slice(0, 3).map((d) => `${d.title} — ${fmtDate(d.date, lang)}`).join(' · ')}</div></div>
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={lang === 'pt' ? 'Buscar por nome, etiqueta, número...' : 'Search...'} style={{ ...inputStyle, marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 4 }}>
        {CATS.map(([k, lbl]) => <Chip key={k} active={cat === k} onClick={() => setCat(k)}>{lbl}</Chip>)}
      </div>
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('addDoc')}</Btn>
      {shown.length === 0 ? <Empty icon={FileText} text={t('nothingHere')} /> : (cat !== 'all'
        ? shown.map((d) => <ItemRow key={d.id} item={d} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)
        : CATS.slice(1).map(([k, lbl]) => { const g = shown.filter((d) => catOf(d) === k); if (!g.length) return null; return <div key={k}><SectionTitle icon={FileText} label={lbl} color={C.blue} />{g.map((d) => <ItemRow key={d.id} item={d} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</div>; }))}
      {adding && <AddModal title={t('addDoc')} icon={FileText} draft={{ type: 'document', domain: 'personal', meta: {} }} allowedTypes={['document']} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ ...x, domain: ['work', 'health', 'personal', 'kids'].includes(x.domain) ? x.domain : 'personal' }); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}


/* ---------------- Gmail (cliente simples) ---------------- */
function GmailThread({ m, lang, t, onClose, onAction, onReplied }) {
  const [reply, setReply] = useState(''); const [busy, setBusy] = useState(''); const [done, setDone] = useState('');
  const [rich, setRich] = useState(!!m.html);
  const iframeRef = useRef();
  // monta o HTML seguro (sem script), com estilo legivel em fundo claro
  const safeHtml = m.html ? `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111;background:#fff;margin:12px;word-break:break-word}img{max-width:100%;height:auto}a{color:#0b66c3}table{max-width:100%}</style></head><body>${m.html}</body></html>` : '';
  const draft = async () => {
    setBusy('draft');
    try {
      const sys = `Escreva uma resposta breve, cordial e objetiva em ${lang === 'pt' ? 'português do Brasil' : 'US English'} para este e-mail. Devolva apenas o texto da resposta, sem assunto e sem assinatura.`;
      const r = await callClaude(sys, [{ role: 'user', content: `De: ${m.sender}\nAssunto: ${m.subject}\n\n${m.body}` }]);
      setReply(r);
    } catch (e) {}
    setBusy('');
  };
  const send = async () => {
    if (!reply.trim()) return;
    setBusy('send');
    try {
      const r = await authFetch('/api/gmail', { method: 'POST', body: JSON.stringify({ id: m.id, threadId: m.threadId, to: m.email, subject: m.subject, messageId: m.messageId, references: m.references, reply: reply.trim() }) });
      const j = await r.json();
      if (j.ok) { setDone(t('sent')); onReplied(m.id); setTimeout(onClose, 900); }
      else alert(j.error || 'Erro');
    } catch (e) { alert(String(e)); }
    setBusy('');
  };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={m.sender} onClose={onClose} icon={Mail} />
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{m.subject}</div>
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 12 }}>{m.email} · {fmtDate(m.date.slice(0, 10), lang)}</div>
      {m.html && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <Chip active={rich} onClick={() => setRich(true)}>{lang === 'pt' ? 'Formatado' : 'Rich'}</Chip>
          <Chip active={!rich} onClick={() => setRich(false)}>{lang === 'pt' ? 'Texto' : 'Text'}</Chip>
        </div>
      )}
      {rich && m.html ? (
        <div style={{ ...card, padding: 0, marginBottom: 14, overflow: 'hidden', borderRadius: 12 }}>
          <iframe ref={iframeRef} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={safeHtml} title="email" style={{ width: '100%', height: 340, border: 'none', background: '#fff', display: 'block' }} />
        </div>
      ) : (
        <div style={{ ...card, padding: 14, marginBottom: 14, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>{m.body}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Btn kind="soft" onClick={() => { onAction(m.id, 'read'); onClose(); }} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Check size={14} />{t('markRead')}</Btn>
        <Btn kind="soft" onClick={() => { onAction(m.id, 'archive'); onClose(); }} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Download size={14} />{t('archive')}</Btn>
        <Btn kind="danger" onClick={() => { if (confirm(t('delete') + '?')) { onAction(m.id, 'trash'); onClose(); } }} style={{ padding: '10px 12px' }}><Trash2 size={14} /></Btn>
      </div>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{t('reply')}</div>
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={5} style={{ ...inputStyle, resize: 'none', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="soft" onClick={draft} disabled={busy === 'draft'} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center', fontSize: 12.5 }}>{busy === 'draft' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{busy === 'draft' ? t('writing') : t('draftReply')}</Btn>
        <Btn onClick={send} disabled={busy === 'send' || !reply.trim()} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center', fontSize: 12.5 }}>{busy === 'send' ? <Loader2 size={14} className="spin" /> : <Send size={14} />}{done || t('sendReply')}</Btn>
      </div>
      <a href={m.link} target="_blank" rel="noreferrer" style={{ display: 'block', textAlign: 'center', fontSize: 11.5, color: C.text3, marginTop: 12, textDecoration: 'none' }}>{t('openGmail')} →</a>
    </Modal>
  );
}

function GmailCompose({ lang, t, onClose, initial }) {
  const [to, setTo] = useState((initial && initial.to) || ''); const [subject, setSubject] = useState((initial && initial.subject) || ''); const [body, setBody] = useState((initial && initial.body) || '');
  const [busy, setBusy] = useState(false); const [done, setDone] = useState('');
  const send = async () => {
    if (!to.trim() || !body.trim()) return;
    setBusy(true);
    try {
      const r = await authFetch('/api/gmail', { method: 'POST', body: JSON.stringify({ compose: body.trim(), to: to.trim(), subject: subject.trim() }) });
      const j = await r.json();
      if (j.ok) { setDone(t('sent')); setTimeout(onClose, 900); } else alert(j.error || 'Erro');
    } catch (e) { alert(String(e)); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('newEmail')} onClose={onClose} icon={Mail} />
      <Field label={t('to')}><input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="alguem@email.com" style={inputStyle} /></Field>
      <Field label={t('subject')}><input value={subject} onChange={(e) => setSubject(e.target.value)} style={inputStyle} /></Field>
      <Field label={t('message')}><textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} style={{ ...inputStyle, resize: 'none' }} /></Field>
      <Btn onClick={send} disabled={busy || !to.trim() || !body.trim()} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>{busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}{done || t('send')}</Btn>
    </Modal>
  );
}

function GmailScreen({ module, lang, t, back, state, setState, load }) {
  const [composing, setComposing] = useState(false);
  const [sel, setSel] = useState(null);
  const [gfilter, setGfilter] = useState('all'); // all | work | personal
  const [showAll, setShowAll] = useState(false);
  // toda vez que a tela Gmail abre, já busca sozinha e-mails novos
  const loadedOnMount = useRef(false);
  useEffect(() => { if (loadedOnMount.current) return; loadedOnMount.current = true; if (load) load(); }, []);
  const act = async (id, action) => {
    setState((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== id) }));
    try { await authFetch('/api/gmail', { method: 'POST', body: JSON.stringify({ id, action }) }); } catch (e) {}
  };
  const current = sel && state.messages.find((m) => m.id === sel);
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: C.text2 }}>{t('unread24')} · {state.messages.length}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setComposing(true)} style={{ ...card, padding: '6px 12px', color: C.accent, cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, fontWeight: 600 }}><Plus size={13} />{t('compose')}</button>
          <button onClick={load} style={{ ...card, padding: '6px 10px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>
            {state.loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          </button>
        </div>
      </div>
      {!state.loading && !state.connected && <HintCard icon={Mail} text={t('gmailConnect')} />}
      {state.error && <HintCard icon={AlertTriangle} text={state.error} />}
      {state.connected && state.messages.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <Chip active={gfilter === 'all'} onClick={() => { setGfilter('all'); setShowAll(false); }}>{lang === 'pt' ? 'Todos' : 'All'}</Chip>
          <Chip active={gfilter === 'work'} onClick={() => { setGfilter('work'); setShowAll(true); }} color={C.accent}>{lang === 'pt' ? 'Trabalho' : 'Work'}</Chip>
          <Chip active={gfilter === 'personal'} onClick={() => { setGfilter('personal'); setShowAll(true); }} color={C.blue}>{lang === 'pt' ? 'Pessoal' : 'Personal'}</Chip>
        </div>
      )}
      {state.loading
        ? <div style={{ ...card, padding: 26, textAlign: 'center', color: C.text3, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Loader2 size={15} className="spin" />…</div>
        : state.messages.length === 0
          ? <Empty icon={Mail} text={state.connected ? t('gmailEmpty') : t('nothingHere')} />
          : (() => {
            const isMoura = (m) => m.work || /^\s*\(m\)/i.test(m.subject || '');
            const renderMsg = (m) => (
              <SwipeRow key={m.id}
                onRight={() => { haptic(15); act(m.id, 'trash'); flash(lang === 'pt' ? 'Movido para lixeira' : 'Trashed'); }}
                rightLabel={lang === 'pt' ? 'Excluir' : 'Delete'} rightColor={C.rose} rightIcon={Trash2}
                onLeft={() => { haptic(15); act(m.id, 'read'); flash(lang === 'pt' ? 'Marcado como lido' : 'Marked read'); }}
                leftLabel={lang === 'pt' ? 'Marcar como lida' : 'Mark read'} leftColor={C.blue} leftIcon={CheckCheck}>
                <div onClick={() => setSel(m.id)} style={{ ...card, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 10, background: (isMoura(m) ? C.sky : C.blue) + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 13, fontWeight: 700, color: isMoura(m) ? C.sky : C.blue }}>{initials(m.sender)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{m.sender}</span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>{isMoura(m) && <WorkBadge size={14} />}<span style={{ fontSize: 10.5, color: C.text3 }}>{m.date.slice(11, 16)}</span></div>
                    </div>
                    <div style={{ fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isMoura(m) ? (m.subject || '').replace(/^\s*\(m\)\s*/i, '') : m.subject}</div>
                    <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.snippet}</div>
                  </div>
                </div>
              </SwipeRow>
            );
            const work = state.messages.filter(isMoura);
            const personal = state.messages.filter((m) => !isMoura(m));
            const LIM = 5;

            if (gfilter === 'work') return <>{work.length === 0 ? <Empty icon={Mail} text={lang === 'pt' ? 'Sem e-mails de trabalho.' : 'No work emails.'} /> : work.map(renderMsg)}</>;
            if (gfilter === 'personal') return <>{personal.length === 0 ? <Empty icon={Mail} text={lang === 'pt' ? 'Sem e-mails pessoais.' : 'No personal emails.'} /> : personal.map(renderMsg)}</>;

            // 'all': 5 de cada seção com "ver mais"
            return (
              <>
                {work.length > 0 && (
                  <>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'center', margin: '4px 2px 8px' }}><WorkBadge size={15} /><span style={{ fontSize: 12, color: C.text2, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{lang === 'pt' ? 'Corporativo' : 'Work'}</span><span style={{ fontSize: 11, color: C.text3 }}>· {work.length}</span></div>
                    {work.slice(0, LIM).map(renderMsg)}
                    {work.length > LIM && <button onClick={() => { setGfilter('work'); }} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12.5, padding: '6px 2px 12px', display: 'flex', alignItems: 'center', gap: 4 }}>{lang === 'pt' ? `Ver todos os ${work.length} de trabalho` : `See all ${work.length}`}<ChevronRight size={14} /></button>}
                  </>
                )}
                {personal.length > 0 && (
                  <>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'center', margin: (work.length > 0 ? '18px' : '4px') + ' 2px 8px' }}><Mail size={14} style={{ color: C.blue }} /><span style={{ fontSize: 12, color: C.text2, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{lang === 'pt' ? 'Pessoal' : 'Personal'}</span><span style={{ fontSize: 11, color: C.text3 }}>· {personal.length}</span></div>
                    {personal.slice(0, LIM).map(renderMsg)}
                    {personal.length > LIM && <button onClick={() => { setGfilter('personal'); }} style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 12.5, padding: '6px 2px 12px', display: 'flex', alignItems: 'center', gap: 4 }}>{lang === 'pt' ? `Ver todos os ${personal.length} pessoais` : `See all ${personal.length}`}<ChevronRight size={14} /></button>}
                  </>
                )}
              </>
            );
          })()}
      {composing && <GmailCompose lang={lang} t={t} onClose={() => setComposing(false)} />}
      {current && <GmailThread m={current} lang={lang} t={t} onClose={() => setSel(null)} onAction={act} onReplied={(id) => setState((p) => ({ ...p, messages: p.messages.filter((x) => x.id !== id) }))} />}
    </div>
  );
}

/* ---------------- Finance dashboard (bank-style) ---------------- */
const KIND_META = { checking: { icon: Landmark, color: C.green }, credit: { icon: CreditCard, color: C.rose }, investment: { icon: TrendingUp, color: C.blue }, benefit: { icon: Wallet, color: C.accent } };
function amountStr(v, lang, hidden) { return hidden ? '••••••' : fmtMoney(v, lang); }
function Donut({ data, size = 128, thickness = 15 }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.surface2} strokeWidth={thickness} />
      {data.map((d, i) => { const dash = (d.value / total) * circ; const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color} strokeWidth={thickness} strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-acc} transform={`rotate(-90 ${cx} ${cy})`} />; acc += dash; return el; })}
    </svg>
  );
}
function TxRow({ i, lang, t, onOpen, accounts }) {
  const cat = catOf(i); const Ic = cat.icon; const credit = isCredit(i); const acc = accounts && accounts.find((a) => a.id === (i.meta && i.meta.accountId));
  return (
    <div onClick={() => onOpen(i)} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '11px 4px', cursor: 'pointer' }}>
      <div style={{ width: 38, height: 38, borderRadius: 999, background: cat.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={16} style={{ color: cat.color }} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div>
        <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat[lang]}{acc ? ' · ' + acc.title.split(' —')[0] : ''}{i.person ? ' · ' + i.person : ''}</div>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: credit ? C.green : C.text, whiteSpace: 'nowrap' }}>{credit ? '+ ' : '− '}{fmtMoney(Math.abs(Number(i.amount) || 0), lang)}</div>
    </div>
  );
}
function Extrato({ tx, accounts, lang, t, onOpen }) {
  const groups = {}; tx.forEach((i) => { const d = i.date || '—'; (groups[d] = groups[d] || []).push(i); });
  const days = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  if (tx.length === 0) return <Empty icon={Wallet} text={t('noTx')} />;
  return (
    <div>
      {days.map((d) => (
        <div key={d} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'capitalize', margin: '10px 4px 2px' }}>{d === '—' ? '—' : fmtDate(d, lang)}</div>
          <div style={{ ...card, padding: '2px 12px' }}>{groups[d].map((i, idx) => <div key={i.id} style={{ borderTop: idx ? `1px solid ${C.borderSoft}` : 'none' }}><TxRow i={i} lang={lang} t={t} onOpen={onOpen} accounts={accounts} /></div>)}</div>
        </div>
      ))}
    </div>
  );
}
function WorkScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, delItem, flash, gmail }) {
  const [tab, setTab] = useState('all'); // all | events | tasks | emails
  const [adding, setAdding] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const isMouraMsg = (m) => m.work || /^\s*\(m\)/i.test(m.subject || '');
  const workEvents = items.filter((i) => (i.type === 'event' || i.type === 'appointment') && (i.domain === 'work' || (i.meta && i.meta.moura))).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const workTasks = items.filter((i) => i.type === 'task' && i.domain === 'work' && i.status !== 'done').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const workEmails = (gmail && gmail.messages || []).filter(isMouraMsg);
  const counters = [
    { k: 'events', label: lang === 'pt' ? 'Reuniões' : 'Meetings', n: workEvents.length, icon: CalIcon, color: C.accent },
    { k: 'tasks', label: lang === 'pt' ? 'Tarefas' : 'Tasks', n: workTasks.length, icon: ListTodo, color: C.blue },
    { k: 'emails', label: lang === 'pt' ? 'E-mails' : 'Emails', n: workEmails.length, icon: Mail, color: C.violet },
  ];
  // na visão "todos", mostra no máximo 10 itens abertos (reuniões + tarefas) e agrupa o resto
  const OPEN_LIM = 10;
  const capOpen = tab === 'all' && !expandAll;
  const evShown = capOpen ? Math.min(workEvents.length, OPEN_LIM) : workEvents.length;
  const taskShown = capOpen ? Math.max(0, Math.min(workTasks.length, OPEN_LIM - evShown)) : workTasks.length;
  const hiddenOpen = capOpen ? (workEvents.length + workTasks.length) - (evShown + taskShown) : 0;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {counters.map((c) => (
          <button key={c.k} onClick={() => setTab(tab === c.k ? 'all' : c.k)} style={{ ...card, flex: 1, padding: '12px 6px', cursor: 'pointer', textAlign: 'center', border: tab === c.k ? `1px solid ${c.color}` : `1px solid ${C.borderSoft}`, color: C.text }}>
            <div style={{ fontSize: 19, fontWeight: 800, color: c.color }}>{c.n}</div>
            <div style={{ fontSize: 10.5, color: C.text3, marginTop: 1, display: 'flex', gap: 3, alignItems: 'center', justifyContent: 'center' }}><c.icon size={10} />{c.label}</div>
          </button>
        ))}
      </div>
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('quickAdd')}</Btn>

      {(tab === 'all' || tab === 'events') && workEvents.length > 0 && (
        <><SectionTitle icon={CalIcon} label={lang === 'pt' ? 'Reuniões' : 'Meetings'} color={C.accent} />{workEvents.slice(0, tab === 'all' ? evShown : workEvents.length).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>
      )}
      {(tab === 'all' || tab === 'tasks') && workTasks.length > 0 && (
        <><SectionTitle icon={ListTodo} label={lang === 'pt' ? 'Tarefas' : 'Tasks'} color={C.blue} />{workTasks.slice(0, tab === 'all' ? taskShown : workTasks.length).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} onDelete={delItem} />)}</>
      )}
      {hiddenOpen > 0 && (
        <button onClick={() => setExpandAll(true)} style={{ ...card, width: '100%', padding: '10px', marginBottom: 14, color: C.text2, cursor: 'pointer', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>
          {lang === 'pt' ? `+ ${hiddenOpen} itens (ver todos)` : `+ ${hiddenOpen} items (see all)`}<ChevronRight size={13} />
        </button>
      )}
      {(tab === 'all' || tab === 'emails') && workEmails.length > 0 && (
        <>
          <SectionTitle icon={Mail} label={lang === 'pt' ? 'E-mails' : 'Emails'} color={C.violet} />
          {workEmails.slice(0, tab === 'emails' ? 50 : 5).map((m) => (
            <div key={m.id} style={{ ...card, padding: '11px 13px', marginBottom: 7, display: 'flex', gap: 10, alignItems: 'center' }}>
              <WorkBadge size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.sender}</div>
                <div style={{ fontSize: 11.5, color: C.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(m.subject || '').replace(/^\s*\(m\)\s*/i, '')}</div>
              </div>
              <span style={{ fontSize: 10, color: C.text3, flexShrink: 0 }}>{(m.date || '').slice(11, 16)}</span>
            </div>
          ))}
          {tab !== 'emails' && workEmails.length > 5 && <button onClick={() => setTab('emails')} style={{ background: 'none', border: 'none', color: C.violet, cursor: 'pointer', fontSize: 12, padding: '2px 2px 12px', display: 'flex', gap: 4, alignItems: 'center' }}>{lang === 'pt' ? 'Ver todos' : 'See all'}<ChevronRight size={13} /></button>}
        </>
      )}
      {workEvents.length === 0 && workTasks.length === 0 && workEmails.length === 0 && <Empty icon={Briefcase} text={t('nothingHere')} />}
      {adding && <AddModal title={`${t('quickAdd')} · ${t('work')}`} icon={Plus} draft={{ type: 'task', domain: 'work' }} allowedTypes={['event', 'appointment', 'task', 'note']} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: 'work', ...x }); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}
const PURCHASE_STAGES = {
  paid: { pt: 'Pago', en: 'Paid', color: '#F59E0B' },
  shipped: { pt: 'Enviado', en: 'Shipped', color: '#6BA6E6' },
  delivered: { pt: 'Entregue', en: 'Delivered', color: '#5FBF8F' },
  other: { pt: 'Em análise', en: 'Other', color: '#8A8F98' },
};
function PurchaseCard({ p, lang, onOpen, selectMode, selected, onToggleSelect, onMarkReceived }) {
  const [open, setOpen] = useState(false);
  const stage = (p.meta && p.meta.stage) || 'paid';
  const sm = PURCHASE_STAGES[stage] || PURCHASE_STAGES.other;
  const isML = p.meta && p.meta.external === 'mercadolivre';
  const subItems = (p.meta && p.meta.items) || [];
  const hasGroup = subItems.length > 1;
  const click = () => { if (selectMode) return onToggleSelect(p.id); if (hasGroup) return setOpen((v) => !v); return onOpen(p); };
  return (
    <div style={{ ...card, padding: 13, marginBottom: 8, border: selectMode && selected ? `1px solid ${C.accent}` : undefined }}>
      <div onClick={click} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
            {selectMode && (selected ? <CircleCheck size={16} style={{ color: C.accent, flexShrink: 0 }} /> : <Circle size={16} style={{ color: C.text3, flexShrink: 0 }} />)}
            {!selectMode && hasGroup && <ChevronRight size={13} style={{ color: C.text3, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</div>
              <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>{p.date ? fmtDate(p.date, lang) : ''}{p.meta && p.meta.tracking ? ` · ${p.meta.tracking}` : ''}</div>
            </div>
          </div>
          {p.amount != null && <span style={{ fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}>{fmtMoney(p.amount, lang)}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: sm.color, border: `1px solid ${sm.color}44`, borderRadius: 999, padding: '2px 9px' }}>{sm[lang]}</span>
          {p.meta && p.meta.store && <span style={{ fontSize: 10, color: C.text3, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 8px' }}>{p.meta.store}</span>}
          {isML && <span style={{ fontSize: 10, color: C.text3, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 8px' }}>Mercado Livre</span>}
          {p.meta && p.meta.etaDate && stage !== 'delivered' && <span style={{ fontSize: 10, color: C.accent, border: `1px solid ${C.accent}44`, borderRadius: 999, padding: '2px 8px' }}>{lang === 'pt' ? 'chega' : 'arrives'} {fmtDate(p.meta.etaDate, lang)}</span>}
        </div>
      </div>
      {stage !== 'delivered' && onMarkReceived && (
        <button onClick={(e) => { e.stopPropagation(); onMarkReceived(p); }} style={{ marginTop: 8, background: 'none', border: `1px solid ${C.green}44`, color: C.green, cursor: 'pointer', fontSize: 11.5, padding: '5px 10px', borderRadius: 8, display: 'flex', gap: 5, alignItems: 'center' }}><Check size={12} />{lang === 'pt' ? 'Marcar como recebida' : 'Mark as received'}</button>
      )}
      {hasGroup && open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.borderSoft}` }}>
          {subItems.map((it, idx) => (
            <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 12 }}>
              <span style={{ color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.qty > 1 ? `${it.qty}× ` : ''}{it.title}</span>
              {it.price != null && <span style={{ color: C.text3, flexShrink: 0 }}>{fmtMoney(it.price, lang)}</span>}
            </div>
          ))}
          <button onClick={() => onOpen(p)} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 11.5, padding: '6px 0 0', display: 'flex', gap: 4, alignItems: 'center' }}>{lang === 'pt' ? 'Ver detalhes' : 'View details'}<ChevronRight size={12} /></button>
        </div>
      )}
    </div>
  );
}
function PurchasesScreen({ module, items = [], lang, t, back, addItem, addItems, updateItem, delItem, onOpen, flash, setPendingCount }) {
  const [adding, setAdding] = useState(false);
  const [pendingAccountId, setPendingAccountId] = useState(null);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__lccOpenAddPurchase) {
      window.__lccOpenAddPurchase = false;
      setPendingAccountId(window.__lccPurchaseAccountId || null);
      window.__lccPurchaseAccountId = null;
      setAdding(true);
    }
  }, []);
  const [days, setDays] = useState(30);
  const [ml, setMl] = useState({ loading: true, connected: false, error: null, syncedAt: null });
  const [scan, setScan] = useState({ loading: false, list: null, error: null });
  const [storeFilter, setStoreFilter] = useState('all');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const loadMl = (d) => {
    setMl((p) => ({ ...p, loading: true }));
    authFetch('/api/mercadolivre?days=' + d).then((r) => r.json()).then((j) => {
      setMl({ loading: false, connected: !!j.connected, error: j.error || null, syncedAt: new Date().toISOString() });
      if (!j.connected) return;
      // reset a cada sincronização, mas preservando grupos MONTADOS À MÃO (o agrupamento automático
      // por pack_id/shipping id nem sempre existe na resposta do ML — quando não existe, o usuário
      // agrupa manualmente selecionando os cartões, e isso não pode ser desfeito pela sincronização).
      const cur = itemsRef.current;
      const manualGroups = cur.filter((i) => i.type === 'purchase' && i.meta && i.meta.manualGroup);
      const coveredIds = new Set(manualGroups.flatMap((g) => g.meta.subOrderIds || []));
      cur.filter((i) => i.type === 'purchase' && i.meta && i.meta.external === 'mercadolivre' && !i.meta.manualGroup).forEach((old) => {
        const ev = cur.find((i) => i.meta && i.meta.auto && i.meta.purchaseRef === old.id);
        if (ev) delItem(ev.id);
        delItem(old.id);
      });
      // não recria pedidos que já foram cobertos por um agrupamento manual
      const fresh = (j.purchases || []).filter((p) => !(p.meta.subOrderIds || []).some((id) => coveredIds.has(id)));
      if (fresh.length) addItems(fresh);
    }).catch(() => setMl((p) => ({ ...p, loading: false })));
  };
  useEffect(() => { loadMl(days); }, []);
  const toggleSelect = (id) => setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  const mergeSelected = () => {
    const picks = itemsRef.current.filter((i) => selected.includes(i.id));
    if (picks.length < 2) return;
    const allItemsList = picks.flatMap((p) => (p.meta && p.meta.items) || [{ title: p.title, qty: 1, price: p.amount }]);
    const title = allItemsList.length === 1 ? allItemsList[0].title : `${allItemsList[0].title} +${allItemsList.length - 1}`;
    const amount = picks.reduce((a, p) => a + (Number(p.amount) || 0), 0) || null;
    const date = picks.map((p) => p.date).filter(Boolean).sort()[0];
    const stageRank = { pending: 0, paid: 1, shipped: 2, delivered: 3 };
    const worst = picks.reduce((min, p) => (stageRank[p.meta.stage] < stageRank[min.meta.stage] ? p : min), picks[0]);
    const subOrderIds = [...new Set(picks.flatMap((p) => (p.meta && p.meta.subOrderIds) || [p.id.replace(/^ml_/, '')]))];
    addItem({
      type: 'purchase', domain: 'shopping', title, amount, date, status: 'planned',
      meta: { external: 'mercadolivre', manualGroup: true, orderId: 'manual_' + Date.now(), subOrderIds, stage: worst.meta.stage, store: 'Mercado Livre', tracking: picks.map((p) => p.meta.tracking).filter(Boolean)[0] || null, etaDate: picks.map((p) => p.meta.etaDate).filter(Boolean)[0] || null, deliveredDate: worst.meta.deliveredDate, items: allItemsList },
    });
    picks.forEach((p) => delItem(p.id));
    setSelected([]); setSelectMode(false);
    flash(lang === 'pt' ? 'Pedidos agrupados.' : 'Orders merged.');
  };
  const runScan = () => {
    setScan({ loading: true, list: null, error: null });
    authFetch('/api/purchases-scan?days=' + days).then((r) => r.json())
      .then((j) => {
        const knownIds = new Set(items.filter((i) => i.type === 'purchase' && i.meta && i.meta.messageId).map((i) => i.meta.messageId));
        setScan({ loading: false, list: (j.suggestions || []).filter((s) => !knownIds.has(s.messageId)), error: j.error || null });
      })
      .catch((e) => setScan({ loading: false, list: [], error: String(e) }));
  };
  useEffect(() => { if (setPendingCount) setPendingCount('purchases', (scan.list || []).length); }, [scan.list]);
  const acceptSug = (sg) => {
    addItem({ type: 'purchase', domain: 'shopping', title: sg.title, amount: sg.amount, date: sg.date, meta: { external: 'email', messageId: sg.messageId, stage: sg.stage, tracking: sg.tracking, trackingLink: sg.trackingLink, store: sg.store, paymentMethod: sg.paymentMethod, sourceLink: sg.source && sg.source.link } });
    setScan((p) => ({ ...p, list: (p.list || []).filter((x) => x.key !== sg.key) }));
    flash(t('savedOne'));
  };

  // fonte única de verdade: tudo que já foi persistido como 'purchase' (ML sincronizado + e-mail aceito + manual)
  const allRaw = items.filter((i) => i.type === 'purchase');
  const today = todayISO();
  const isArchived = (p) => { const st = p.meta && p.meta.stage; if (st !== 'delivered') return false; const dd = (p.meta && p.meta.deliveredDate) || p.date; if (!dd) return false; return addDays(dd, 5) < today; };
  const [showArchived, setShowArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // all | transit | delivered
  const markReceived = (p) => { updateItem(p.id, { meta: { ...p.meta, stage: 'delivered', deliveredDate: today } }); flash(lang === 'pt' ? 'Marcada como recebida ✓' : 'Marked as received ✓'); };

  // item 4f: compra enviada com data estimada de chegada -> cria/atualiza um evento no calendário
  // automaticamente, às 20h (fim do dia) em vez de dia inteiro — só pra marcar o dia, sem ocupar a agenda toda.
  useEffect(() => {
    allRaw.forEach((p) => {
      if (p.meta && p.meta.stage === 'shipped' && p.meta.etaDate) {
        const evId = 'purchase_eta_' + p.id;
        const already = items.find((i) => i.id === evId || (i.meta && i.meta.purchaseRef === p.id));
        if (!already) {
          addItem({ id: evId, type: 'event', domain: 'shopping', title: `${lang === 'pt' ? 'Chegada da compra' : 'Arrival'}: ${p.title}${p.meta.store ? ' (' + p.meta.store + ')' : ''}`, date: p.meta.etaDate, time: '20:00', meta: { purchaseRef: p.id, auto: true } });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRaw.length]);

  const stores = [...new Set(allRaw.map((p) => p.meta && p.meta.store).filter((s) => s && s !== 'Mercado Livre'))];
  const byStore = storeFilter === 'all' ? allRaw : allRaw.filter((p) => (p.meta && p.meta.store) === storeFilter);
  const active = byStore.filter((p) => !isArchived(p));
  const archived = byStore.filter(isArchived);
  const scoped = showArchived ? archived : active;
  const inTransitCount = scoped.filter((p) => (p.meta && p.meta.stage) !== 'delivered').length;
  const deliveredCount = scoped.filter((p) => (p.meta && p.meta.stage) === 'delivered').length;
  const byStatus = statusFilter === 'all' ? scoped : statusFilter === 'delivered' ? scoped.filter((p) => (p.meta && p.meta.stage) === 'delivered') : scoped.filter((p) => (p.meta && p.meta.stage) !== 'delivered');
  const shown = byStatus.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {!ml.connected && !ml.loading && (
        <div style={{ ...card, padding: 13, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <ShoppingCart size={16} style={{ color: C.accent, flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12, color: C.text3 }}>{lang === 'pt' ? 'Conecte o Mercado Livre em Ajustes → Conexões para ver seus pedidos aqui.' : 'Connect Mercado Livre in Settings to see orders here.'}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {[15, 30, 60, 90].map((d) => <Chip key={d} active={days === d} onClick={() => { setDays(d); loadMl(d); }}>{d}d</Chip>)}
        {ml.loading && <Loader2 size={14} className="spin" style={{ color: C.text3, alignSelf: 'center' }} />}
      </div>
      <div style={{ ...card, padding: 12, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <Sparkles size={16} style={{ color: C.accent, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 12.5, color: C.text2, lineHeight: 1.4 }}>{lang === 'pt' ? 'Buscar compras nos e-mails (label Compras)' : 'Scan email for purchases'}</span>
        <Btn kind="soft" onClick={runScan} disabled={scan.loading} style={{ padding: '7px 12px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          {scan.loading ? <Loader2 size={13} className="spin" /> : <Mail size={13} />}{scan.loading ? t('scanning') : (lang === 'pt' ? 'Buscar' : 'Scan')}
        </Btn>
      </div>
      {scan.error && <HintCard icon={AlertTriangle} text={scan.error} />}
      {scan.list && scan.list.length === 0 && !scan.loading && <HintCard icon={Check} text={lang === 'pt' ? 'Nada novo encontrado.' : 'Nothing new found.'} />}
      {scan.list && scan.list.map((sg) => (
        <div key={sg.key} style={{ ...card, padding: 13, marginBottom: 8, borderColor: C.accent + '33' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Package size={16} style={{ color: C.accent, marginTop: 2, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{sg.title}</div>
              <div style={{ fontSize: 11.5, color: C.text2, marginTop: 3 }}>{PURCHASE_STAGES[sg.stage][lang]}{sg.amount != null ? ' · ' + fmtMoney(sg.amount, lang) : ''}{sg.date ? ' · ' + fmtDate(sg.date, lang) : ''}</div>
              {sg.source && sg.source.subject && <div style={{ fontSize: 10.5, color: C.text3, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✉ {sg.source.subject}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn kind="soft" onClick={() => acceptSug(sg)} style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Check size={13} />{t('accept')}</Btn>
            <Btn kind="ghost" onClick={() => setScan((p) => ({ ...p, list: p.list.filter((x) => x.key !== sg.key) }))} style={{ padding: '7px 12px', fontSize: 12.5 }}>{t('discard')}</Btn>
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Btn kind="soft" onClick={() => setAdding(true)} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{lang === 'pt' ? 'Adicionar compra manual' : 'Add purchase'}</Btn>
        <Btn kind="soft" onClick={() => { setSelectMode((v) => !v); setSelected([]); }} style={{ display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', padding: '0 14px' }}>{selectMode ? t('cancel') : (lang === 'pt' ? 'Agrupar pedidos' : 'Group orders')}</Btn>
      </div>
      {selectMode && (
        <div style={{ ...card, padding: 10, marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', borderColor: C.accent + '44' }}>
          <span style={{ flex: 1, fontSize: 12, color: C.text2 }}>{lang === 'pt' ? `Selecione os cartões do mesmo pedido/envio (${selected.length} selecionado${selected.length === 1 ? '' : 's'})` : `Select cards from the same order/shipment (${selected.length} selected)`}</span>
          <Btn kind="solid" onClick={mergeSelected} disabled={selected.length < 2} style={{ padding: '7px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>{lang === 'pt' ? 'Agrupar' : 'Merge'}</Btn>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <Chip active={!showArchived} onClick={() => setShowArchived(false)}>{lang === 'pt' ? 'Ativas' : 'Active'} ({active.length})</Chip>
        <Chip active={showArchived} onClick={() => setShowArchived(true)}>{lang === 'pt' ? 'Arquivadas' : 'Archived'} ({archived.length})</Chip>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <Chip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} color={C.accent}>{lang === 'pt' ? 'Todas' : 'All'}</Chip>
        <Chip active={statusFilter === 'transit'} onClick={() => setStatusFilter('transit')} color={C.blue}>{lang === 'pt' ? 'A caminho' : 'In transit'} ({inTransitCount})</Chip>
        <Chip active={statusFilter === 'delivered'} onClick={() => setStatusFilter('delivered')} color={C.green}>{lang === 'pt' ? 'Entregues' : 'Delivered'} ({deliveredCount})</Chip>
      </div>
      {stores.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', paddingBottom: 6, WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)', maskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)' }}>
          <Chip active={storeFilter === 'all'} onClick={() => setStoreFilter('all')} color={C.blue}>{lang === 'pt' ? 'Todas as lojas' : 'All stores'}</Chip>
          {stores.map((s) => <Chip key={s} active={storeFilter === s} onClick={() => setStoreFilter(s)} color={C.blue}>{s}</Chip>)}
        </div>
      )}
      {shown.length === 0 ? <Empty icon={Package} text={t('nothingHere')} /> : shown.map((p) => <PurchaseCard key={p.id} p={p} lang={lang} onOpen={() => onOpen(p)} selectMode={selectMode} selected={selected.includes(p.id)} onToggleSelect={toggleSelect} onMarkReceived={markReceived} />)}
      {adding && <AddModal title={lang === 'pt' ? 'Compra' : 'Purchase'} icon={Package} draft={{ type: 'purchase', domain: 'shopping', meta: { stage: 'paid', accountId: pendingAccountId } }} allowedTypes={['purchase']} lang={lang} t={t} onClose={() => { setAdding(false); setPendingAccountId(null); }} onSave={(x) => { addItem({ domain: 'shopping', ...x }); flash(t('savedOne')); setAdding(false); setPendingAccountId(null); }} />}
    </div>
  );
}
function AllTransactionsScreen({ items, accounts, lang, t, back, onOpen, toggleTask, hidden }) {
  const [q, setQ] = useState(''); const [accFilter, setAccFilter] = useState('all'); const [typeFilter, setTypeFilter] = useState('all');
  const all = items.filter(isTx).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const filtered = all.filter((i) => {
    if (accFilter !== 'all' && (!i.meta || i.meta.accountId !== accFilter)) return false;
    if (typeFilter === 'in' && !isCredit(i)) return false;
    if (typeFilter === 'out' && !isDebit(i)) return false;
    if (q && !(i.title || '').toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={back} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', display: 'flex' }}><ChevronLeft size={20} /></button>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{lang === 'pt' ? 'Todos os lançamentos' : 'All transactions'}</div>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={lang === 'pt' ? 'Buscar por descrição...' : 'Search...'} style={{ ...inputStyle, marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, overflowX: 'auto', paddingBottom: 6 }}>
        <Chip active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>{lang === 'pt' ? 'Tudo' : 'All'}</Chip>
        <Chip active={typeFilter === 'in'} onClick={() => setTypeFilter('in')} color={C.green}>{t('incomeL')}</Chip>
        <Chip active={typeFilter === 'out'} onClick={() => setTypeFilter('out')} color={C.rose}>{t('outflow')}</Chip>
      </div>
      {accounts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 6, WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)', maskImage: 'linear-gradient(to right, black calc(100% - 26px), transparent)' }}>
          <Chip active={accFilter === 'all'} onClick={() => setAccFilter('all')}>{lang === 'pt' ? 'Todas as contas' : 'All accounts'}</Chip>
          {accounts.map((a) => <Chip key={a.id} active={accFilter === a.id} onClick={() => setAccFilter(a.id)}>{a.title.split(' —')[0]}</Chip>)}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8 }}>{filtered.length} {lang === 'pt' ? 'lançamentos' : 'transactions'}</div>
      {filtered.length === 0 ? <Empty icon={Wallet} text={t('nothingHere')} /> : filtered.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} hideAmount={hidden} />)}
    </div>
  );
}
function periodFilter(list, period) {
  if (period === 'all') return list;
  if (period === 'month') { const m = todayISO().slice(0, 7); return list.filter((i) => (i.date || '').startsWith(m)); }
  const from = addDays(todayISO(), -30); return list.filter((i) => (i.date || '') >= from);
}
function AccountDetail({ acc, items, people, lang, t, back, onOpen, addItem, updateItem, flash, goReport }) {
  const [hidden, setHidden] = useState(false); const [period, setPeriod] = useState('month'); const [adding, setAdding] = useState(null); const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__lccOpenAddExpense) {
      window.__lccOpenAddExpense = false;
      setAdding('expense');
    }
  }, []);
  const accounts = items.filter((i) => i.type === 'account');
  const all = items.filter(isTx).filter((i) => acc ? (i.meta && i.meta.accountId === acc.id) : true);
  const orphans = acc ? items.filter(isTx).filter((i) => !i.meta || !i.meta.accountId) : [];
  const tx = periodFilter(all, period).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const income = tx.filter(isCredit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const outflow = tx.filter(isDebit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const km = acc && acc.meta && KIND_META[acc.meta.kind || 'checking'];
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('finance')}</button>
      <div style={{ ...card, padding: 18, marginBottom: 12, background: `linear-gradient(135deg, ${(km ? km.color : C.accent)}22, ${C.surface})`, borderColor: (km ? km.color : C.accent) + '33' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>{km && <km.icon size={17} style={{ color: km.color }} />}<span style={{ fontSize: 13.5, fontWeight: 600 }}>{acc ? acc.title : t('statement')}</span></div>
          <button onClick={() => setHidden((h) => !h)} title={t('hideBalance')} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer' }}>{hidden ? '👁' : '••'}</button>
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>{acc ? amountStr(accountBalance(acc, items), lang, hidden) : amountStr(income - outflow, lang, hidden)}</div>
        <div style={{ fontSize: 11.5, color: C.text3, marginTop: 3 }}>{acc ? (acc.meta && acc.meta.institution || t('balance')) : t('statement')}{acc && (acc.meta && acc.meta.balance != null) ? ` · ${lang === 'pt' ? 'base' : 'base'} ${amountStr(Number(acc.meta.balance) || 0, lang, hidden)}` : ''}</div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <MiniStat label={t('incomeL')} value={amountStr(income, lang, hidden)} color={C.green} small />
        <MiniStat label={t('outflow')} value={amountStr(outflow, lang, hidden)} color={C.rose} small />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <Chip active={period === 'month'} onClick={() => setPeriod('month')}>{t('thisMonth')}</Chip>
        <Chip active={period === '30d'} onClick={() => setPeriod('30d')}>{t('period30')}</Chip>
        <Chip active={period === 'all'} onClick={() => setPeriod('all')}>{t('allTime')}</Chip>
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <Btn kind="soft" onClick={() => setAdding('expense')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Wallet size={14} />{t('addExpense')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('income')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><TrendingUp size={14} />{t('addIncome')}</Btn>
      </div>
      {acc && orphans.length > 0 && (
        <Btn kind="soft" onClick={() => { if (confirm(lang === 'pt' ? `Vincular ${orphans.length} transação(ões) sem conta a "${acc.title}"?` : `Link ${orphans.length} transactions to this account?`)) { orphans.forEach((o) => updateItem(o.id, { meta: { ...(o.meta || {}), accountId: acc.id } })); flash(lang === 'pt' ? 'Vinculadas ✓' : 'Linked ✓'); } }} style={{ width: '100%', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center', marginBottom: 8, color: C.accent }}><LinkIcon size={14} />{lang === 'pt' ? `Vincular ${orphans.length} transação(ões) avulsas a esta conta` : `Link ${orphans.length} orphan transactions`}</Btn>
      )}
      <Btn kind="soft" onClick={() => setImporting(true)} style={{ width: '100%', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center', marginBottom: 8, color: C.accent }}><Upload size={14} />{lang === 'pt' ? 'Importar extrato desta conta' : 'Import statement'}</Btn>
      {goReport && <Btn kind="soft" onClick={goReport} style={{ width: '100%', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center', marginBottom: 8 }}><Activity size={14} />{t('reports')}</Btn>}
      {(() => {
        const linked = acc ? items.filter((i) => i.type === 'purchase' && i.meta && i.meta.accountId === acc.id) : [];
        if (!linked.length) return null;
        return (
          <>
            <SectionTitle icon={Package} label={lang === 'pt' ? 'Compras vinculadas a esta conta' : 'Linked purchases'} color={C.accent} />
            {linked.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6).map((p) => (
              <div key={p.id} onClick={() => onOpen(p)} style={{ ...card, padding: '10px 13px', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.title}</span>
                {p.amount != null && <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text2, marginLeft: 8 }}>{fmtMoney(p.amount, lang)}</span>}
              </div>
            ))}
          </>
        );
      })()}
      <SectionTitle icon={Wallet} label={t('statement')} color={km ? km.color : C.accent} />
      <Extrato tx={tx} accounts={accounts} lang={lang} t={t} onOpen={onOpen} />
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'finance', date: todayISO(), meta: { accountId: acc ? acc.id : null } }} allowedTypes={[adding]} lang={lang} t={t} people={people} accounts={accounts} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'finance', ...x }); flash(t('savedOne')); setAdding(null); }} />}
      {importing && <StatementImport lang={lang} t={t} existing={items} accounts={items.filter((i) => i.type === 'account')} fixedAccountId={acc ? acc.id : null} onClose={() => setImporting(false)} onImport={(txs, accId) => { txs.forEach((tx) => addItem({ type: tx.type, domain: 'finance', title: tx.description, amount: tx.amount, date: tx.date, meta: { fingerprint: tx.fingerprint, source: 'extrato', accountId: accId || (acc ? acc.id : null) } })); flash((lang === 'pt' ? 'Importadas ' : 'Imported ') + txs.length); setImporting(false); }} />}
    </div>
  );
}
function BarRow({ label, value, max, color, right, icon: Ic }) {
  const w = max ? Math.max(3, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5, alignItems: 'center' }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{Ic && <Ic size={13} style={{ color }} />}{label}</span>
        <span style={{ color: C.text2, fontWeight: 600 }}>{right}</span>
      </div>
      <div style={{ height: 8, background: C.surface2, borderRadius: 999, overflow: 'hidden' }}><div style={{ width: w + '%', height: '100%', background: color, borderRadius: 999 }} /></div>
    </div>
  );
}
function ReportsScreen({ items, people, lang, t, back }) {
  const [tab, setTab] = useState('cat'); const [period, setPeriod] = useState('month'); const [accId, setAccId] = useState(null);
  const accounts = items.filter((i) => i.type === 'account');
  let debits = items.filter(isDebit); if (accId) debits = debits.filter((i) => i.meta && i.meta.accountId === accId);
  const scoped = periodFilter(debits, period);
  const total = scoped.reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const byCat = {}; scoped.forEach((i) => { const k = deriveCat(i); byCat[k] = (byCat[k] || 0) + (Number(i.amount) || 0); });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const byPerson = {}; scoped.forEach((i) => { const k = i.person || '—'; byPerson[k] = (byPerson[k] || 0) + (Number(i.amount) || 0); });
  const personRows = Object.entries(byPerson).sort((a, b) => b[1] - a[1]);
  const months = [5, 4, 3, 2, 1, 0].map((n) => { const m = monthOf(n); const inc = items.filter((i) => isCredit(i) && (i.date || '').startsWith(m)).reduce((a, b) => a + (Number(b.amount) || 0), 0); const out = debits.filter((i) => (i.date || '').startsWith(m)).reduce((a, b) => a + (Number(b.amount) || 0), 0); return { label: new Date(m + '-01T00:00:00').toLocaleDateString(loc(lang), { month: 'short' }), income: inc, expense: out }; });
  const maxM = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  const catMax = catRows.length ? catRows[0][1] : 1; const pMax = personRows.length ? personRows[0][1] : 1;
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('finance')}</button>
      <ScreenTitle title={t('reports')} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <Chip active={tab === 'cat'} onClick={() => setTab('cat')} color={C.green}>{t('byCategory')}</Chip>
        <Chip active={tab === 'person'} onClick={() => setTab('person')} color={C.violet}>{t('byPerson')}</Chip>
        <Chip active={tab === 'month'} onClick={() => setTab('month')} color={C.blue}>{t('byMonth')}</Chip>
      </div>
      {tab !== 'month' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, overflowX: 'auto', paddingBottom: 6 }}>
            <Chip active={period === 'month'} onClick={() => setPeriod('month')}>{t('thisMonth')}</Chip>
            <Chip active={period === '30d'} onClick={() => setPeriod('30d')}>{t('period30')}</Chip>
            <Chip active={period === 'all'} onClick={() => setPeriod('all')}>{t('allTime')}</Chip>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', paddingBottom: 6 }}>
            <Chip active={!accId} onClick={() => setAccId(null)}>{t('allAccounts')}</Chip>
            {accounts.map((a) => <Chip key={a.id} active={accId === a.id} onClick={() => setAccId(a.id)}>{a.title.split(' —')[0]}</Chip>)}
          </div>
        </>
      )}
      {tab === 'cat' && (
        <>
          <div style={{ ...card, padding: 18, marginBottom: 14, display: 'flex', gap: 16, alignItems: 'center' }}>
            <div style={{ position: 'relative', width: 128, height: 128, flexShrink: 0 }}>
              <Donut data={catRows.map(([k, v]) => ({ value: v, color: CATEGORIES[k].color }))} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}><div style={{ fontSize: 10, color: C.text3 }}>{t('total')}</div><div style={{ fontSize: 14, fontWeight: 700 }}>{fmtMoney(total, lang)}</div></div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>{catRows.slice(0, 5).map(([k, v]) => { const cc = CATEGORIES[k]; return <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, fontSize: 12 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: cc.color, flexShrink: 0 }} /><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cc[lang]}</span><span style={{ color: C.text2 }}>{total ? Math.round(v / total * 100) : 0}%</span></div>; })}</div>
          </div>
          {catRows.length === 0 ? <Empty icon={Wallet} text={t('noTx')} /> : catRows.map(([k, v]) => { const cc = CATEGORIES[k]; return <BarRow key={k} label={cc[lang]} value={v} max={catMax} color={cc.color} icon={cc.icon} right={fmtMoney(v, lang)} />; })}
        </>
      )}
      {tab === 'person' && (personRows.length === 0 ? <Empty icon={UserRound} text={t('noTx')} /> : personRows.map(([k, v]) => <BarRow key={k} label={k} value={v} max={pMax} color={C.violet} right={fmtMoney(v, lang)} />))}
      {tab === 'month' && (
        <div style={{ ...card, padding: 18 }}>
          <div style={{ display: 'flex', gap: 14, marginBottom: 14, fontSize: 12 }}><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ width: 9, height: 9, borderRadius: 3, background: C.green }} />{t('incomeL')}</span><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ width: 9, height: 9, borderRadius: 3, background: C.rose }} />{t('outflow')}</span></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 120 }}>
            {months.map((m, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 92 }}>
                  <div style={{ width: 9, height: Math.max(2, m.income / maxM * 92), background: C.green, borderRadius: 3 }} />
                  <div style={{ width: 9, height: Math.max(2, m.expense / maxM * 92), background: C.rose, borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: 10, color: C.text3, textTransform: 'capitalize' }}>{m.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function FinanceAssistant({ items, lang, t, back }) {
  const [msgs, setMsgs] = useState([]); const [input, setInput] = useState(''); const [loading, setLoading] = useState(false); const endRef = useRef();
  const month = todayISO().slice(0, 7); const lastM = monthOf(1);
  const monthTx = items.filter(isTx).filter((i) => (i.date || '').startsWith(month));
  const outflow = monthTx.filter(isDebit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const income = monthTx.filter(isCredit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const outLast = items.filter((i) => isDebit(i) && (i.date || '').startsWith(lastM)).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const byCat = {}; monthTx.filter(isDebit).forEach((i) => { const k = deriveCat(i); byCat[k] = (byCat[k] || 0) + (Number(i.amount) || 0); });
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  const delta = outLast ? Math.round((outflow - outLast) / outLast * 100) : 0;
  const bills = items.filter((i) => i.type === 'bill' && i.date && i.date >= todayISO());
  const ctx = { month, income, outflow, left: income - outflow, spendByCategory: byCat, vsLastMonthPct: delta, upcomingBills: bills.map((b) => ({ title: b.title, due: b.date, amount: b.amount })), accounts: items.filter((i) => i.type === 'account').map((a) => ({ name: a.title, kind: a.meta && a.meta.kind, balance: Number(a.meta && a.meta.balance) || 0 })) };
  const system = `You are the user's personal finance assistant inside their app. Answer concisely in ${lang === 'pt' ? 'Brazilian Portuguese' : 'US English'}. Use the JSON of accounts, monthly income/outflow, spending by category and upcoming bills to summarize, compare periods, find where money goes and suggest cuts. Be concrete with numbers. Never give definitive investment advice — add a short caution and suggest a professional if asked. Today: ${todayISO()}. Data: ${JSON.stringify(ctx)}`;
  const push = async (next) => { setMsgs(next); setLoading(true); try { const r = await callClaude(system, next.map((m) => ({ role: m.role, content: m.content }))); setMsgs((p) => [...p, { role: 'assistant', content: r || '…' }]); } catch (e) { setMsgs((p) => [...p, { role: 'assistant', content: lang === 'pt' ? 'Não consegui responder agora.' : "Couldn't respond." }]); } setLoading(false); };
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ behavior: 'smooth' }); }, [msgs, loading]);
  const send = () => { if (!input.trim() || loading) return; push([...msgs, { role: 'user', content: input.trim() }]); setInput(''); };
  const insights = [{ label: t('topCategory'), value: topCat ? CATEGORIES[topCat[0]][lang] : '—', color: topCat ? CATEGORIES[topCat[0]].color : C.text2 }, { label: t('vsLastMonth'), value: (delta >= 0 ? '+' : '') + delta + '%', color: delta > 0 ? C.rose : C.green }, { label: t('leftMonth'), value: fmtMoney(income - outflow, lang), color: income - outflow >= 0 ? C.green : C.rose }];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('finance')}</button>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>{insights.map((n, i) => <div key={i} style={{ ...card, padding: '10px 11px', flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 700, color: n.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.value}</div><div style={{ fontSize: 9.5, color: C.text3, marginTop: 2 }}>{n.label}</div></div>)}</div>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        {msgs.length === 0 && <div style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}><Sparkles size={17} style={{ color: C.accent, marginTop: 2 }} /><div style={{ fontSize: 13.5, color: C.text2, lineHeight: 1.55 }}>{t('finAssistantIntro')}</div></div>}
        {msgs.map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}><div style={{ maxWidth: '82%', padding: '10px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: m.role === 'user' ? C.accent : C.surface, color: m.role === 'user' ? '#FFFFFF' : C.text, border: m.role === 'user' ? 'none' : `1px solid ${C.borderSoft}` }}>{m.content}</div></div>)}
        {loading && <div style={{ color: C.text3, fontSize: 13, padding: '8px 4px', display: 'flex', gap: 7, alignItems: 'center' }}><Loader2 size={14} className="spin" />{t('thinking')}</div>}
        <div ref={endRef} />
      </div>
      <div style={{ ...card, padding: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('askClaude')} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} style={{ ...inputStyle, background: 'transparent', border: 'none' }} />
        <Btn onClick={send} disabled={loading || !input.trim()} style={{ padding: '9px 12px' }}><Send size={16} /></Btn>
      </div>
    </div>
  );
}
function StatementImport({ lang, t, existing, accounts, fixedAccountId, onClose, onImport }) {
  const [stage, setStage] = useState('pick'); // pick | password | loading | review | error
  const [fileData, setFileData] = useState(null); const [fileName, setFileName] = useState('');
  const [password, setPassword] = useState(''); const [err, setErr] = useState('');
  const [txs, setTxs] = useState([]); const [account, setAccount] = useState(null);
  const [linkAccount, setLinkAccount] = useState(fixedAccountId || '');
  const fileRef = useRef();
  const pt = lang === 'pt';

  const existingFps = new Set((existing || []).filter((i) => i.meta && i.meta.fingerprint).map((i) => i.meta.fingerprint));

  const [fileMime, setFileMime] = useState('');
  const pickFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name); setFileMime(file.type || '');
    const reader = new FileReader();
    reader.onload = () => { const b64 = String(reader.result).split(',')[1]; setFileData(b64); process(b64, '', file.type || '', file.name); };
    reader.readAsDataURL(file);
  };

  const process = async (b64, pwd, mime, filename) => {
    setStage('loading'); setErr('');
    try {
      const r = await authFetch('/api/statement', { method: 'POST', body: JSON.stringify({ fileBase64: b64, mime: mime || fileMime, filename: filename || fileName, password: pwd }) });
      const j = await r.json();
      if (j.needPassword || j.error === 'senha') { setStage('password'); return; }
      if (j.error) { setErr(j.error); setStage('error'); return; }
      // dedup contra o que ja existe
      const seen = new Set(); const clean = [];
      (j.transactions || []).forEach((tx) => {
        if (existingFps.has(tx.fingerprint) || seen.has(tx.fingerprint)) return;
        seen.add(tx.fingerprint); clean.push({ ...tx, _keep: true });
      });
      setTxs(clean); setAccount(j.account);
      setStage('review');
    } catch (e) { setErr(String(e)); setStage('error'); }
  };

  const dupCount = (txs.length === 0 && stage === 'review') ? 0 : null;
  const toImport = txs.filter((t) => t._keep);
  // tenta achar uma compra ja registrada (ainda sem conta vinculada) que bate com a transacao, pra sugerir vinculo em vez de duplicar
  const unlinkedPurchases = (existing || []).filter((i) => i.type === 'purchase' && (!i.meta || !i.meta.accountId));
  const matchPurchase = (tx) => unlinkedPurchases.find((p) => p.amount != null && Math.abs(Number(p.amount) - Number(tx.amount)) < 0.02 && p.date && Math.abs((new Date(p.date) - new Date(tx.date)) / 86400000) <= 5);

  return (
    <Modal onClose={onClose}>
      <SheetHead title={pt ? 'Importar extrato' : 'Import statement'} onClose={onClose} icon={Upload} />

      {stage === 'pick' && (
        <div>
          <div style={{ ...card, padding: 18, textAlign: 'center', marginBottom: 12 }}>
            <FileText size={26} style={{ color: C.accent, marginBottom: 10 }} />
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: C.text2 }}>{pt ? 'Envie o extrato ou fatura em PDF, imagem (foto), CSV ou Excel. O Claude lê as transações e evita duplicatas automaticamente.' : 'Upload your statement as PDF, image, CSV or Excel. Claude reads it and avoids duplicates.'}</div>
          </div>
          <input ref={fileRef} type="file" accept="application/pdf,image/*,.csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pickFile} style={{ display: 'none' }} />
          <Btn onClick={() => fileRef.current && fileRef.current.click()} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Upload size={16} />{pt ? 'Escolher arquivo' : 'Choose file'}</Btn>
        </div>
      )}

      {stage === 'password' && (
        <div>
          <div style={{ ...card, padding: 14, marginBottom: 12, fontSize: 13, color: C.text2, display: 'flex', gap: 9, alignItems: 'center' }}><Lock size={16} style={{ color: C.accent, flexShrink: 0 }} />{pt ? 'Este extrato tem senha. Digite para abrir (não guardamos a senha).' : 'This PDF is password-protected.'}</div>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={pt ? 'Senha do PDF' : 'PDF password'} style={{ ...inputStyle, marginBottom: 10 }} />
          <Btn onClick={() => process(fileData, password, fileMime, fileName)} disabled={!password} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Check size={16} />{pt ? 'Abrir extrato' : 'Open'}</Btn>
        </div>
      )}

      {stage === 'loading' && (
        <div style={{ ...card, padding: 30, textAlign: 'center', color: C.text3, display: 'flex', gap: 9, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={16} className="spin" />{pt ? 'Lendo e organizando as transações…' : 'Reading…'}</div>
      )}

      {stage === 'error' && (
        <div>
          <div style={{ ...card, padding: 14, marginBottom: 12, fontSize: 12.5, color: C.rose }}>{err}</div>
          <Btn kind="soft" onClick={() => setStage('pick')} style={{ width: '100%' }}>{pt ? 'Tentar outro arquivo' : 'Try again'}</Btn>
        </div>
      )}

      {stage === 'review' && (
        <div>
          {account && <div style={{ fontSize: 12, color: C.text3, marginBottom: 8 }}>{pt ? 'Conta identificada no extrato' : 'Account'}: {account}</div>}
          {!fixedAccountId && accounts && accounts.length > 0 && (
            <div style={{ ...card, padding: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 7, fontWeight: 600 }}>{pt ? 'Vincular estas transações à conta:' : 'Link to account:'}</div>
              <select value={linkAccount} onChange={(e) => setLinkAccount(e.target.value)} style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none' }}>
                <option value="">{pt ? '— Sem conta (avulsas) —' : '— None —'}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
              </select>
            </div>
          )}
          <div style={{ ...card, padding: 12, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12.5, color: C.text2 }}>{pt ? 'Novas transações' : 'New'}: <b style={{ color: C.text }}>{txs.length}</b></span>
            <span style={{ fontSize: 11.5, color: C.green }}>{pt ? 'Duplicatas já filtradas ✓' : 'Duplicates filtered ✓'}</span>
          </div>
          {txs.length === 0 ? (
            <Empty icon={Check} text={pt ? 'Nada novo — tudo deste extrato já estava no app.' : 'Nothing new.'} />
          ) : (
            <div style={{ maxHeight: '40vh', overflowY: 'auto', marginBottom: 12 }}>
              {txs.map((tx, i) => {
                const match = matchPurchase(tx);
                return (
                <div key={i} onClick={() => setTxs((p) => p.map((x, j) => j === i ? { ...x, _keep: !x._keep } : x))} style={{ ...card, padding: '10px 12px', marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer', opacity: tx._keep ? 1 : 0.4 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ width: 20, height: 20, borderRadius: 6, border: `2px solid ${tx._keep ? C.accent : C.border}`, background: tx._keep ? C.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{tx._keep && <Check size={13} style={{ color: '#FFFFFF' }} />}</div>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.description}</div><div style={{ fontSize: 11, color: C.text3 }}>{fmtDate(tx.date, lang)}</div></div>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: tx.type === 'income' ? C.green : C.rose }}>{tx.type === 'income' ? '+' : '−'}{fmtMoney(tx.amount, lang)}</span>
                  </div>
                  {match && <div style={{ fontSize: 10.5, color: C.accent, display: 'flex', gap: 4, alignItems: 'center', paddingLeft: 30 }}><Package size={11} />{lang === 'pt' ? `Pode ser a compra "${match.title}" — vincule depois de importar em Compras.` : `May be purchase "${match.title}".`}</div>}
                </div>
                );
              })}
            </div>
          )}
          {toImport.length > 0 && <Btn onClick={() => onImport(toImport, linkAccount || null)} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Download size={16} />{pt ? `Importar ${toImport.length} transações` : `Import ${toImport.length}`}</Btn>}
        </div>
      )}
    </Modal>
  );
}

function FinanceScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, updateItem, flash }) {
  const [sub, setSub] = useState({ v: 'home' }); const [adding, setAdding] = useState(null); const [hidden, setHidden] = useState(true); const [importing, setImporting] = useState(false);
  const [finPeriod, setFinPeriod] = useState('all');
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__lccOpenAccount) {
      const id = window.__lccOpenAccount; window.__lccOpenAccount = null;
      setSub({ v: 'account', id });
    }
  }, []);
  const accounts = items.filter((i) => i.type === 'account');
  if (sub.v === 'account') { const acc = sub.id ? items.find((i) => i.id === sub.id) : null; return <AccountDetail acc={acc} items={items} people={people} lang={lang} t={t} back={() => setSub({ v: "home" })} onOpen={onOpen} addItem={addItem} updateItem={updateItem} flash={flash} goReport={() => setSub({ v: "reports" })} />; }
  if (sub.v === 'alltx') return <AllTransactionsScreen items={items} accounts={accounts} lang={lang} t={t} back={() => setSub({ v: 'home' })} onOpen={onOpen} toggleTask={toggleTask} hidden={hidden} />;
  if (sub.v === 'reports') return <ReportsScreen items={items} people={people} lang={lang} t={t} back={() => setSub({ v: 'home' })} />;
  if (sub.v === 'assistant') return <FinanceAssistant items={items} lang={lang} t={t} back={() => setSub({ v: 'home' })} />;
  const month = todayISO().slice(0, 7);
  const inAccounts = accounts.filter((a) => (a.meta && a.meta.kind) !== 'credit').reduce((s, a) => s + accountBalance(a, items), 0);
  const invested = accounts.filter((a) => a.meta && a.meta.kind === 'investment').reduce((s, a) => s + (Number(a.meta.balance) || 0), 0);
  const creditOwed = accounts.filter((a) => a.meta && a.meta.kind === 'credit').reduce((s, a) => s + (Number(a.meta.balance) || 0), 0);
  const monthTx = items.filter(isTx).filter((i) => finPeriod === 'all' ? true : (i.date || '').startsWith(month));
  const income = monthTx.filter(isCredit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const outflow = monthTx.filter(isDebit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const byCat = {}; monthTx.filter(isDebit).forEach((i) => { const k = deriveCat(i); byCat[k] = (byCat[k] || 0) + (Number(i.amount) || 0); });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const bills = items.filter((i) => i.type === 'bill' && i.date && i.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const SHORT = [{ k: 'importStatement', icon: Upload, on: () => setImporting(true) }, { k: 'reports', icon: Activity, on: () => setSub({ v: 'reports' }) }, { k: 'assistant', icon: Sparkles, on: () => setSub({ v: 'assistant' }) }];
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ ...card, padding: 18, marginBottom: 14, background: `linear-gradient(135deg, ${C.accent}1c, ${C.surface})`, borderColor: C.accent + '33' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: C.text3 }}>{t('totalBalance')}</span>
          <button onClick={() => setHidden((h) => !h)} title={t('hideBalance')} style={{ ...card, border: 'none', color: hidden ? C.accent : C.text2, cursor: 'pointer', fontSize: 12, padding: '7px 12px', display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>{hidden ? <><Eye size={15} />{lang === 'pt' ? 'Mostrar' : 'Show'}</> : <><EyeOff size={15} />{lang === 'pt' ? 'Ocultar' : 'Hide'}</>}</button>
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', marginTop: 4 }}>{amountStr(inAccounts, lang, hidden)}</div>
        <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
          <div><div style={{ fontSize: 10.5, color: C.text3 }}>{t('invested')}</div><div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>{amountStr(invested, lang, hidden)}</div></div>
          <div><div style={{ fontSize: 10.5, color: C.text3 }}>{t('credit')}</div><div style={{ fontSize: 14, fontWeight: 700, color: C.rose }}>{amountStr(creditOwed, lang, hidden)}</div></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {SHORT.map((s) => <button key={s.k} onClick={s.on} style={{ ...card, flex: 1, padding: '12px 4px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: C.text }}><s.icon size={19} style={{ color: C.accent }} /><span style={{ fontSize: 11 }}>{t(s.k)}</span></button>)}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, justifyContent: 'flex-end' }}>
        <Chip active={finPeriod === 'month'} onClick={() => setFinPeriod('month')}>{t('thisMonth')}</Chip>
        <Chip active={finPeriod === 'all'} onClick={() => setFinPeriod('all')}>{lang === 'pt' ? 'Tudo' : 'All'}</Chip>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
        <MiniStat label={`${t('incomeL')} · ${finPeriod === 'all' ? (lang === 'pt' ? 'tudo' : 'all') : t('thisMonth')}`} value={amountStr(income, lang, hidden)} color={C.green} small />
        <MiniStat label={`${t('outflow')} · ${finPeriod === 'all' ? (lang === 'pt' ? 'tudo' : 'all') : t('thisMonth')}`} value={amountStr(outflow, lang, hidden)} color={C.rose} small />
      </div>
      {bills.length > 0 && <><SectionTitle icon={Clock} label={t('upcomingBills')} color={C.accent} />{bills.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} hideAmount={hidden} />)}</>}
      {catRows.length > 0 && (
        <>
          <div onClick={() => setSub({ v: 'reports' })} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 2px 10px', cursor: 'pointer' }}>
            <span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}><Activity size={14} style={{ color: C.green }} />{t('consumption')}</span>
            <ChevronRight size={16} style={{ color: C.text3 }} />
          </div>
          <div style={{ ...card, padding: 14 }}>{catRows.slice(0, 4).map(([k, v]) => { const cc = CATEGORIES[k]; return <BarRow key={k} label={cc[lang]} value={v} max={catRows[0][1]} color={cc.color} icon={cc.icon} right={amountStr(v, lang, hidden)} />; })}</div>
        </>
      )}

      {(() => {
        const allTx = items.filter(isTx).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        const recentTx = allTx.slice(0, 10);
        if (recentTx.length === 0) return null;
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 2px 10px' }}>
              <span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}><Wallet size={14} style={{ color: C.accent }} />{lang === 'pt' ? 'Últimos lançamentos' : 'Recent transactions'}</span>
              {allTx.length > 10 && <button onClick={() => setSub({ v: 'alltx' })} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, display: 'flex', gap: 3, alignItems: 'center' }}>{lang === 'pt' ? 'Ver todas' : 'See all'}<ChevronRight size={13} /></button>}
            </div>
            {recentTx.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} hideAmount={hidden} />)}
          </>
        );
      })()}

      <SectionTitle icon={CreditCard} label={t('accounts')} color={C.green} />
      {accounts.length === 0 ? <Empty icon={CreditCard} text={t('nothingHere')} /> : accounts.map((a) => { const km = KIND_META[(a.meta && a.meta.kind) || 'checking']; return (
        <div key={a.id} onClick={() => setSub({ v: 'account', id: a.id })} style={{ ...card, padding: '13px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: km.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><km.icon size={17} style={{ color: km.color }} /></div>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div><div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>{ACCOUNT_KINDS.find(([kk]) => kk === (a.meta && a.meta.kind || 'checking'))[lang === 'pt' ? 1 : 2]}</div></div>
          <span style={{ fontSize: 15, fontWeight: 700, color: (a.meta && a.meta.kind) === 'credit' ? C.rose : C.text }}>{amountStr(accountBalance(a, items), lang, hidden)}</span>
        </div>
      ); })}
      <Btn kind="soft" onClick={() => setAdding('account')} style={{ width: '100%', marginTop: 4, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={15} />{t('addAccount')}</Btn>
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'finance', meta: adding === 'account' ? { kind: 'checking' } : {} }} allowedTypes={[adding]} lang={lang} t={t} people={people} accounts={accounts} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'finance', ...x }); flash(t('savedOne')); setAdding(null); }} />}
      {importing && <StatementImport lang={lang} t={t} existing={items} accounts={accounts} onClose={() => setImporting(false)} onImport={(txs, accId) => { txs.forEach((tx) => addItem({ type: tx.type, domain: 'finance', title: tx.description, amount: tx.amount, date: tx.date, meta: { fingerprint: tx.fingerprint, source: 'extrato', accountId: accId || null } })); flash((lang === 'pt' ? 'Importadas ' : 'Imported ') + txs.length); setImporting(false); }} />}
    </div>
  );
}

/* ---------------- Health dashboard ---------------- */
const isExamDoc = (i) => (i.meta && i.meta.isExam) || /exame|hemograma|raio|ultrass|resson|resultado|laudo|sangue|colesterol|glicose/i.test(i.title);
// histórico compacto de TODOS os exames marcados (laboratoriais OU de imagem) — usado em toda
// análise de saúde (Resumo de hoje, Dr. Claude geral, Dieta) pra considerar o documento inteiro,
// não só os indicadores numéricos extraídos dele.
function buildExamHistory(items) {
  return (items || [])
    .filter((i) => i.type === 'document' && i.domain === 'health' && isExamDoc(i))
    .map((d) => ({
      title: d.title, date: d.date || null, tag: (d.meta && d.meta.tag) || null,
      findings: (d.meta && d.meta.examAnalysis) ? String(d.meta.examAnalysis).slice(0, 600) : 'ainda não analisado em detalhe — só o título/data estão disponíveis',
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 20);
}
function HealthScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash, health, setHealth, profile, setProfile, ouraOn, lastSleep, weights, addWeight, goMedical, goDiet, goDocs, healthSummary, setHealthSummary, setPendingCount }) {
  const [adding, setAdding] = useState(null); const [addingEx, setAddingEx] = useState(false); const [logOpen, setLogOpen] = useState(false); const [editP, setEditP] = useState(false);
  const [sumLoading, setSumLoading] = useState(false);
  const [sumOpen, setSumOpen] = useState(false);
  const [hscan, setHscan] = useState({ loading: false, list: null, error: null });
  const [hscanDays, setHscanDays] = useState(30);
  const runHealthScan = () => {
    setHscan({ loading: true, list: null, error: null });
    authFetch('/api/health-scan?days=' + hscanDays).then((r) => r.json())
      .then((j) => setHscan({ loading: false, list: j.suggestions || [], error: j.error || null }))
      .catch((e) => setHscan({ loading: false, list: [], error: String(e) }));
  };
  useEffect(() => { if (setPendingCount) setPendingCount('health', (hscan.list || []).length); }, [hscan.list]);
  const acceptHsug = (sg) => {
    addItem({ type: sg.type, domain: 'health', title: sg.title, notes: sg.notes || '', date: sg.date, time: sg.time, meta: { ...(sg.meta || {}), fromEmail: sg.sourceType === 'email', fromCalendar: sg.sourceType === 'calendar', sourceLink: sg.source && sg.source.link } });
    setHscan((p) => ({ ...p, list: (p.list || []).filter((x) => x.key !== sg.key) }));
    flash(t('savedOne'));
  };
  const today = todayISO(); const w = health[today] || {};
  const hd = items.filter((i) => i.domain === 'health');
  const genSummary = async () => {
    setSumLoading(true);
    try {
      const last7 = Object.entries(health || {}).filter(([d]) => d >= addDays(today, -7)).map(([d, v]) => ({ date: d, sleep: v.sleep, readiness: v.readiness, activity: v.activity, tempDeviation: v.tempDeviation }));
      const metrics = items.filter((i) => i.type === 'healthMetric' && i.title !== '__checked__').slice(-40).map((i) => ({ indicator: i.title, value: i.amount, unit: i.meta && i.meta.unit, status: i.meta && i.meta.status, date: i.date }));
      const conditions = items.filter((i) => i.type === 'condition' && i.meta && i.meta.status === 'ativa').map((i) => i.title);
      const allergies = items.filter((i) => i.type === 'allergy').map((i) => i.title);
      const meds = items.filter((i) => i.type === 'medication' && !(i.meta && i.meta.endDate)).map((i) => i.title);
      const meals = items.filter((i) => i.type === 'meal' && i.domain === 'health' && i.date >= addDays(today, -3)).map((i) => ({ title: i.title, calories: i.meta && i.meta.calories, protein: i.meta && i.meta.protein }));
      const examHistory = buildExamHistory(items);
      const system = `Você é o Dr. Claude, assistente de saúde pessoal. Com base em TODOS os dados abaixo, escreva um resumo de NO MÁXIMO 3 linhas (curto, direto, em ${lang === 'pt' ? 'português do Brasil' : 'English'}) sobre o estado geral de saúde da pessoa AGORA, terminando com uma recomendação prática pro dia/semana. Tom acolhedor mas objetivo, como o resumo diário de um app de wearable. IMPORTANTE: considere os achados dos exames (laboratoriais e de imagem, campo "Histórico de exames" abaixo) com o MESMO peso dos indicadores numéricos — não foque só em números; laudos, condições registradas e o histórico narrativo do paciente são igualmente relevantes. NUNCA dê diretiva médica formal — é observação, não diagnóstico. Se faltar dado, trabalhe com o que tiver e não invente. Responda em texto puro, sem markdown, sem aspas.
Sono/prontidão (últimos 7 dias): ${JSON.stringify(last7)}
Indicadores de exames recentes: ${JSON.stringify(metrics)}
Histórico de exames (laboratoriais e de imagem, com achados quando já analisados): ${JSON.stringify(examHistory)}
Condições ativas: ${JSON.stringify(conditions)}
Alergias: ${JSON.stringify(allergies)}
Medicações em uso: ${JSON.stringify(meds)}
Refeições recentes: ${JSON.stringify(meals)}
Data de hoje: ${today}`;
      const text = await callClaude(system, [{ role: 'user', content: lang === 'pt' ? 'Gere o resumo de hoje.' : "Generate today's summary." }]);
      setHealthSummary({ date: today, text: text.trim() });
    } catch (e) { flash(lang === 'pt' ? 'Não consegui gerar o resumo agora.' : "Couldn't generate summary."); }
    setSumLoading(false);
  };
  useEffect(() => {
    if (!healthSummary || healthSummary.date !== today) { genSummary(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const consultas = hd.filter((i) => i.type === 'appointment' && i.date && i.date >= today).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const treat = hd.filter((i) => i.type === 'med');
  const pharm = hd.filter((i) => i.type === 'expense' && i.amount);
  const pharmTotal = pharm.reduce((a, b) => a + b.amount, 0);
  const hdocs = hd.filter((i) => i.type === 'document');
  const exams = hdocs.filter(isExamDoc); const support = hdocs.filter((i) => !isExamDoc(i));
  const bmi = profile.weight && profile.height ? (Number(profile.weight) / Math.pow(Number(profile.height) / 100, 2)).toFixed(1) : null;
  const exercises = hd.filter((i) => i.type === 'exercise').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const weekAgo = addDays(today, -7);
  const weekEx = exercises.filter((i) => i.date >= weekAgo);
  const weekMin = weekEx.reduce((a, b) => a + (Number(b.meta && b.meta.durationMin) || 0), 0);
  const weekKm = weekEx.reduce((a, b) => a + (Number(b.meta && b.meta.distanceKm) || 0), 0);
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[15, 30, 60, 90].map((d) => <Chip key={d} active={hscanDays === d} onClick={() => setHscanDays(d)}>{d}d</Chip>)}
      </div>
      <div style={{ ...card, padding: 12, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <Sparkles size={16} style={{ color: C.accent, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 12.5, color: C.text2, lineHeight: 1.4 }}>{lang === 'pt' ? 'Buscar saúde nos e-mails e na agenda' : 'Scan email and calendar for health'}</span>
        <Btn kind="soft" onClick={runHealthScan} disabled={hscan.loading} style={{ padding: '7px 12px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          {hscan.loading ? <Loader2 size={13} className="spin" /> : <Mail size={13} />}{hscan.loading ? t('scanning') : (lang === 'pt' ? 'Buscar' : 'Scan')}
        </Btn>
      </div>
      {hscan.error && <HintCard icon={AlertTriangle} text={hscan.error} />}
      {hscan.list && hscan.list.length === 0 && !hscan.loading && <HintCard icon={Check} text={lang === 'pt' ? 'Nada novo encontrado.' : 'Nothing new found.'} />}
      {hscan.list && hscan.list.map((sg) => {
        const Ic = typeIcon(sg.type);
        return (
          <div key={sg.key} style={{ ...card, padding: 13, marginBottom: 8, borderColor: C.accent + '33' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Ic size={16} style={{ color: C.accent, marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{sg.title}</div>
                <div style={{ fontSize: 11.5, color: C.text2, marginTop: 3 }}>
                  {t('t_' + sg.type)}{sg.date ? ' · ' + fmtDate(sg.date, lang) : ''}{sg.time ? ' ' + sg.time : ''}
                  {sg.meta && sg.meta.doctor ? ` · ${sg.meta.doctor}` : ''}{sg.meta && sg.meta.clinic ? ` · ${sg.meta.clinic}` : ''}
                </div>
                <div style={{ fontSize: 10, color: C.text3, marginTop: 3 }}>{sg.sourceType === 'calendar' ? (lang === 'pt' ? '📅 da agenda' : '📅 from calendar') : '✉ ' + (sg.source && sg.source.subject || '')}</div>
                {sg.notes && <div style={{ fontSize: 12, color: C.text2, marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{sg.notes}</div>}
                {sg.why && <div style={{ fontSize: 11, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>{sg.why}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Btn kind="soft" onClick={() => acceptHsug(sg)} style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Check size={13} />{t('accept')}</Btn>
              <Btn kind="ghost" onClick={() => setHscan((p) => ({ ...p, list: p.list.filter((x) => x.key !== sg.key) }))} style={{ padding: '7px 12px', fontSize: 12.5 }}>{t('discard')}</Btn>
            </div>
          </div>
        );
      })}
      <div style={{ ...card, padding: 15, marginBottom: 12, border: '1px solid #5B8DEF33', background: 'linear-gradient(135deg, #5B8DEF14, ' + C.surface + ')' }}>
        <div onClick={() => setSumOpen((v) => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, cursor: 'pointer' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><DrClaudeBadge size={22} /><span style={{ fontSize: 12, fontWeight: 700, color: '#5B8DEF' }}>{lang === 'pt' ? 'Resumo de hoje' : "Today's summary"}</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button onClick={(e) => { e.stopPropagation(); genSummary(); }} disabled={sumLoading} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', padding: 3, display: 'flex' }}>{sumLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}</button>
            <ChevronRight size={16} style={{ color: C.text3, transform: sumOpen ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
          </div>
        </div>
        {sumLoading && !healthSummary ? <div style={{ fontSize: 13, color: C.text3 }}>{lang === 'pt' ? 'Gerando...' : 'Generating...'}</div> : (
          <div onClick={() => setSumOpen((v) => !v)} style={{ fontSize: 13.5, lineHeight: 1.55, color: C.text, cursor: 'pointer', ...(sumOpen ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) }}>{healthSummary ? healthSummary.text : (lang === 'pt' ? 'Toque em atualizar pra gerar seu resumo do dia.' : 'Tap refresh to generate today\'s summary.')}</div>
        )}
      </div>
      <button onClick={goMedical} style={{ ...card, width: '100%', padding: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', border: 'none', textAlign: 'left', color: C.text, background: 'linear-gradient(135deg, #5B8DEF1c, ' + C.surface + ')', borderColor: '#5B8DEF33' }}>
        <DrClaudeBadge size={36} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{lang === 'pt' ? 'Histórico Médico' : 'Medical History'}</div>
          <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>{lang === 'pt' ? 'Indicadores, condições, medicações — com o Dr. Claude' : 'Indicators, conditions, medications'}</div>
        </div>
        <ChevronRight size={18} style={{ color: C.text3 }} />
      </button>
      {goDiet && (
        <button onClick={goDiet} style={{ ...card, width: '100%', padding: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', border: 'none', textAlign: 'left', color: C.text, background: 'linear-gradient(135deg, #E5544B1c, ' + C.surface + ')', borderColor: '#E5544B33' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #F0928A, #E5544B)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Flame size={19} style={{ color: '#fff' }} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{lang === 'pt' ? 'Dieta' : 'Diet'}</div>
            <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>{lang === 'pt' ? 'Refeições, calorias e análise do Dr. Claude' : 'Meals, calories and Dr. Claude analysis'}</div>
          </div>
          <ChevronRight size={18} style={{ color: C.text3 }} />
        </button>
      )}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <ScoreRing label={t('readiness')} value={w.readiness ?? null} color={C.green} locked={ouraOn} onClick={() => setLogOpen(true)} />
        <ScoreRing label={t('sleepScore')} value={w.sleep ?? null} color={C.violet} locked={ouraOn} onClick={() => setLogOpen(true)} />
      </div>
      {ouraOn && <div style={{ fontSize: 11, color: C.text3, textAlign: 'center', marginBottom: 8, display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'center' }}><Activity size={11} style={{ color: C.green }} />{t('ouraSynced')}</div>}

      {ouraOn && (lastSleep ? <SleepCard s={lastSleep} lang={lang} t={t} /> : <div style={{ ...card, padding: 16, marginBottom: 10, color: C.text3, fontSize: 12.5, textAlign: 'center' }}>{t('noSleepData')}</div>)}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <MiniStat label={t('weight')} value={profile.weight ? profile.weight + ' kg' : '—'} color={C.rose} small />
        <MiniStat label={t('height')} value={profile.height ? profile.height + ' cm' : '—'} color={C.blue} small />
        <MiniStat label={t('bmi')} value={bmi || '—'} color={C.accent} small />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <Btn kind="soft" onClick={() => setEditP(true)} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Scale size={14} />{t('addWeight')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('appointment')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Stethoscope size={14} />{t('consultations')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('document')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><FileText size={14} />{t('addDoc')}</Btn>
      </div>
      <WeightHistory weights={weights} lang={lang} t={t} />
      <SectionTitle icon={Dumbbell} label={t('t_exercise')} color={C.rose} />
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <MiniStat label={lang === 'pt' ? 'Essa semana' : 'This week'} value={String(weekEx.length)} color={C.rose} small />
        <MiniStat label="Min" value={String(weekMin)} color={C.blue} small />
        {weekKm > 0 && <MiniStat label="Km" value={weekKm.toFixed(1)} color={C.green} small />}
      </div>
      <Btn kind="soft" onClick={() => setAddingEx(true)} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{lang === 'pt' ? 'Registrar atividade' : 'Log activity'}</Btn>
      {exercises.length === 0 ? <Empty icon={Dumbbell} text={t('nothingHere')} /> : exercises.slice(0, 6).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      {addingEx && <AddModal title={t('t_exercise')} icon={Dumbbell} draft={{ type: 'exercise', domain: 'health', date: todayISO(), meta: {} }} allowedTypes={['exercise']} lang={lang} t={t} people={people} onClose={() => setAddingEx(false)} onSave={(x) => { addItem({ domain: 'health', ...x }); flash(t('savedOne')); setAddingEx(false); }} />}
      {consultas.length > 0 && <><SectionTitle icon={Stethoscope} label={t('consultations')} color={C.rose} />{consultas.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {treat.length > 0 && <><SectionTitle icon={Pill} label={t('treatments')} color={C.violet} />{treat.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      <SectionTitle icon={Wallet} label={`${t('pharmacy')} · ${fmtMoney(pharmTotal, lang)}`} color={C.green} />
      {pharm.length === 0 ? <Empty icon={Wallet} text={t('nothingHere')} /> : pharm.slice(0, 5).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      <SectionTitle icon={Activity} label={t('exams')} color={C.blue} />
      {(() => {
        const PREVIEW = 4;
        const examsSorted = [...exams].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        const supportSorted = [...support].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        const more = Math.max(0, examsSorted.length - PREVIEW) + Math.max(0, supportSorted.length - PREVIEW);
        return (
          <>
            {examsSorted.length === 0 ? <Empty icon={Activity} text={t('nothingHere')} /> : examsSorted.slice(0, PREVIEW).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
            {supportSorted.length > 0 && <><SectionTitle icon={FileText} label={t('support')} color={C.text2} />{supportSorted.slice(0, PREVIEW).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
            {more > 0 && goDocs && <Btn kind="soft" onClick={goDocs} style={{ width: '100%', marginTop: 4, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><FileText size={14} />{lang === 'pt' ? `Ver todos os documentos (${hdocs.length})` : `See all documents (${hdocs.length})`}</Btn>}
          </>
        );
      })()}
      <div style={{ marginTop: 18 }}><HintCard icon={Activity} text={t('appleHealth')} /></div>
      {logOpen && !ouraOn && <WellnessLog current={w} lang={lang} t={t} onSave={(v) => setHealth((h) => ({ ...h, [today]: v }))} onClose={() => setLogOpen(false)} />}
      {editP && <WeightLog lang={lang} t={t} current={profile.weight} onSave={(kg) => { addWeight(kg); setEditP(false); }} onClose={() => setEditP(false)} />}
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'health', meta: {} }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'health', ...x }); flash(t('savedOne')); setAdding(null); }} />}
    </div>
  );
}
// tela dedicada com todos os documentos de saúde — a lista dentro da aba Saúde mostra só uma
// prévia (fica grande demais com o tempo); aqui dá pra ver tudo, agrupado por etiqueta ou por tipo
function HealthDocsScreen({ items, lang, t, back, onOpen }) {
  const [group, setGroup] = useState('tag'); // 'tag' | 'type'
  const [q, setQ] = useState('');
  const docs = items.filter((i) => i.type === 'document' && i.domain === 'health');
  const matches = (d) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return [d.title, d.meta && d.meta.tag, d.meta && d.meta.issuer, d.meta && d.meta.holder, d.meta && d.meta.number].filter(Boolean).some((v) => String(v).toLowerCase().includes(s));
  };
  const shown = docs.filter(matches);
  const noTag = lang === 'pt' ? 'Sem etiqueta' : 'No tag';
  const groupKey = (d) => group === 'type' ? (isExamDoc(d) ? t('exams') : t('support')) : ((d.meta && d.meta.tag) || noTag);
  const groups = {};
  shown.forEach((d) => { const k = groupKey(d); (groups[k] = groups[k] || []).push(d); });
  const groupNames = Object.keys(groups).sort((a, b) => (a === noTag ? 1 : b === noTag ? -1 : a.localeCompare(b, lang === 'pt' ? 'pt' : 'en')));
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('health')}</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: C.blue + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FileText size={20} style={{ color: C.blue }} /></div>
        <div style={{ fontSize: 22, fontWeight: 600 }}>{lang === 'pt' ? 'Documentos de saúde' : 'Health documents'}</div>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={lang === 'pt' ? 'Buscar por nome, etiqueta, número...' : 'Search...'} style={{ ...inputStyle, marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <Chip active={group === 'tag'} onClick={() => setGroup('tag')} color={C.blue}>{lang === 'pt' ? 'Por etiqueta' : 'By tag'}</Chip>
        <Chip active={group === 'type'} onClick={() => setGroup('type')} color={C.blue}>{lang === 'pt' ? 'Por tipo' : 'By type'}</Chip>
      </div>
      {shown.length === 0 ? <Empty icon={FileText} text={t('nothingHere')} /> : groupNames.map((name) => (
        <div key={name}>
          <SectionTitle icon={FileText} label={`${name} (${groups[name].length})`} color={C.blue} />
          {groups[name].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((d) => <ItemRow key={d.id} item={d} lang={lang} t={t} onToggle={() => {}} onOpen={onOpen} />)}
        </div>
      ))}
    </div>
  );
}
function CalorieChart({ meals, lang, days = 14 }) {
  const today = todayISO();
  const byDay = {};
  meals.forEach((m) => { if (!m.date) return; byDay[m.date] = (byDay[m.date] || 0) + (Number(m.meta && m.meta.calories) || 0); });
  const daysList = Array.from({ length: days }, (_, i) => addDays(today, -(days - 1 - i)));
  const vals = daysList.map((d) => byDay[d] || 0);
  const max = Math.max(...vals, 1);
  const niceMax = Math.max(500, Math.ceil(max / 500) * 500);
  const ML = 30, MR = 4, MT = 6, MB = 14;
  const W = 320, H = 100;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const gap = 2, barW = plotW / days - gap;
  const yTicks = [0, niceMax / 2, niceMax];
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {yTicks.map((v) => {
          const y = MT + plotH - (v / niceMax) * plotH;
          return (
            <g key={v}>
              <line x1={ML} y1={y} x2={ML + plotW} y2={y} stroke={C.borderSoft} strokeWidth="0.6" />
              <text x={ML - 4} y={y + 2.5} fontSize="6.5" fill={C.text3} textAnchor="end">{v}</text>
            </g>
          );
        })}
        <text x={0} y={MT + plotH / 2} fontSize="6.5" fill={C.text3} textAnchor="middle" transform={`rotate(-90 8 ${MT + plotH / 2})`}>kcal</text>
        {daysList.map((d, i) => {
          const v = vals[i]; const h = Math.max(v > 0 ? 2 : 0, (v / niceMax) * plotH);
          const x = ML + i * (plotW / days);
          const dt = new Date(d + 'T00:00:00');
          return (
            <g key={d}>
              <rect x={x} y={MT + plotH - h} width={Math.max(barW, 1)} height={h} rx={2} fill={d === today ? C.accent : (_theme === 'light' ? '#5B8DEF66' : '#5B8DEF55')} />
              {(days <= 14 || i % 7 === 0) && <text x={x + barW / 2} y={H - 2} fontSize="6.5" fill={C.text3} textAnchor="middle">{pad2(dt.getDate())}/{pad2(dt.getMonth() + 1)}</text>}
            </g>
          );
        })}
      </svg>
      <div style={{ textAlign: 'center', fontSize: 10, color: C.text3, marginTop: 2 }}>{lang === 'pt' ? 'Data (dia/mês)' : 'Date (day/month)'}</div>
    </div>
  );
}
function MealRow({ m, lang, onOpen, hideDate }) {
  const cal = m.meta && m.meta.calories;
  const [, ptn, enn, Ic, col] = mealTypeInfo(mealTypeOf(m));
  return (
    <div onClick={() => onOpen(m)} style={{ ...card, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 11, marginBottom: 8, cursor: 'pointer' }}>
      <div style={{ width: 30, height: 30, borderRadius: 9, background: col + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={14} style={{ color: col }} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
        <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{lang === 'pt' ? ptn : enn}{!hideDate && m.date ? ' · ' + fmtDate(m.date, lang) : ''}{m.time ? ' · ' + m.time : ''}</div>
      </div>
      {cal != null && <span style={{ fontSize: 12.5, fontWeight: 700, color: '#E5544B', flexShrink: 0 }}>{cal} kcal</span>}
    </div>
  );
}
// mesmo layout do CalendarScreen (semana por padrão, abre pro mês) — cada dia mostra o total de
// calorias do dia; clicar num dia abre a lista de refeições daquele dia logo abaixo
function DietCalendar({ meals, lang, sel, setSel }) {
  const [mode, setMode] = useState('week');
  const today = todayISO();
  const [vm, setVm] = useState((sel || today).slice(0, 7));
  const byDay = {};
  meals.forEach((m) => { if (!m.date) return; byDay[m.date] = (byDay[m.date] || 0) + (Number(m.meta && m.meta.calories) || 0); });
  const [y, m] = vm.split('-').map(Number);
  const shiftMonth = (d) => { let nm = m + d, ny = y; if (nm < 1) { nm = 12; ny--; } if (nm > 12) { nm = 1; ny++; } setVm(`${ny}-${pad2(nm)}`); };
  const shiftWeek = (d) => { const ns = addDays(sel, d * 7); setSel(ns); setVm(ns.slice(0, 7)); };
  let cells = [];
  if (mode === 'month') { const sw = new Date(y, m - 1, 1).getDay(); const di = new Date(y, m, 0).getDate(); for (let i = 0; i < sw; i++) cells.push(null); for (let d = 1; d <= di; d++) cells.push(`${y}-${pad2(m)}-${pad2(d)}`); }
  else { const base = new Date(sel + 'T00:00:00'); const ws = new Date(base); ws.setDate(base.getDate() - base.getDay()); for (let i = 0; i < 7; i++) { const d = new Date(ws); d.setDate(ws.getDate() + i); cells.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); } }
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString(loc(lang), { month: 'long', year: 'numeric' });
  return (
    <div style={{ ...card, padding: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <Chip active={mode === 'week'} onClick={() => setMode('week')}>{lang === 'pt' ? 'Semana' : 'Week'}</Chip>
        <Chip active={mode === 'month'} onClick={() => setMode('month')} color={C.rose}>{lang === 'pt' ? 'Mês' : 'Month'}</Chip>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <button onClick={() => (mode === 'month' ? shiftMonth(-1) : shiftWeek(-1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronLeft size={20} /></button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>{mode === 'month' ? monthLabel : `${lang === 'pt' ? 'Semana' : 'Week'} · ${fmtDate(cells[0], lang)}`}</span>
          {sel !== today && <button onClick={() => { setSel(today); setVm(today.slice(0, 7)); }} style={{ background: C.accentSoft, border: 'none', color: C.accent, cursor: 'pointer', fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '3px 10px' }}>{lang === 'pt' ? 'Hoje' : 'Today'}</button>}
        </div>
        <button onClick={() => (mode === 'month' ? shiftMonth(1) : shiftWeek(1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronRight size={20} /></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3, marginBottom: 4 }}>{WD[lang].map((wd) => <div key={wd} style={{ textAlign: 'center', fontSize: 10.5, color: C.text3, padding: '2px 0' }}>{wd}</div>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
        {cells.map((iso, idx) => {
          if (!iso) return <div key={idx} />;
          const cals = Math.round(byDay[iso] || 0);
          const isToday = iso === today, isSel = iso === sel, isFuture = iso > today;
          return (
            <button key={idx} onClick={() => setSel(iso)} style={{ aspectRatio: '1', border: isSel ? `1px solid ${C.rose}` : '1px solid transparent', background: isSel ? C.rose + '1e' : isToday ? C.surface2 : 'transparent', borderRadius: 9, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, padding: 2 }}>
              <span style={{ fontSize: 12, color: isToday ? C.rose : C.text, fontWeight: isToday ? 700 : 400 }}>{Number(iso.slice(-2))}</span>
              {cals > 0 ? <span style={{ fontSize: 8, fontWeight: 700, color: '#E5544B' }}>{cals >= 1000 ? (cals / 1000).toFixed(1).replace('.', ',') + 'k' : cals}</span> : !isFuture && <span style={{ width: 3, height: 3, borderRadius: 999, background: C.borderSoft }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
function DietScreen({ items, lang, t, back, addItem, delItem, onOpen, flash, dietSummary, setDietSummary, openClaude }) {
  const [sumLoading, setSumLoading] = useState(false);
  const [mealDraft, setMealDraft] = useState(null);
  const [adding, setAdding] = useState(false);
  const [chartDays, setChartDays] = useState(14);
  const [selDate, setSelDate] = useState(todayISO());
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__lccOpenAddMeal) {
      window.__lccOpenAddMeal = false;
      setAdding(true);
    }
  }, []);
  const fileRef = useRef();
  const today = todayISO();
  const meals = items.filter((i) => i.type === 'meal' && i.domain === 'health').sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  const todayMeals = meals.filter((m) => m.date === today);
  const selMeals = meals.filter((m) => m.date === selDate).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const selCals = selMeals.reduce((a, b) => a + (Number(b.meta && b.meta.calories) || 0), 0);
  const todayCals = todayMeals.reduce((a, b) => a + (Number(b.meta && b.meta.calories) || 0), 0);
  const genDietSummary = async () => {
    setSumLoading(true);
    try {
      const last14 = meals.filter((m) => m.date >= addDays(today, -14)).map((m) => ({ date: m.date, title: m.title, calories: m.meta && m.meta.calories, proteinG: m.meta && m.meta.proteinG }));
      const exList = items.filter((i) => i.type === 'exercise' && i.date >= addDays(today, -14)).map((i) => ({ date: i.date, activity: i.meta && i.meta.activityType, durationMin: i.meta && i.meta.durationMin, distanceKm: i.meta && i.meta.distanceKm }));
      const system = `Você é o Dr. Claude, personal trainer/nutricionista pessoal embutido num app de vida pessoal. Com base nas refeições e atividades físicas dos últimos 14 dias, escreva NO MÁXIMO 3 linhas (${lang === 'pt' ? 'português do Brasil' : 'English'}) sobre como a dieta e a rotina de exercícios estão indo, terminando com 1-2 dicas práticas. Tom acolhedor mas direto, como o resumo diário de um app de wearable. NUNCA dê diretiva médica formal — é observação, não diagnóstico. Se faltar dado (poucos registros), diga isso e incentive registrar mais. Responda em texto puro, sem markdown, sem aspas.
Refeições (14d): ${JSON.stringify(last14)}
Atividades físicas (14d): ${JSON.stringify(exList)}
Hoje: ${today}`;
      const text = await callClaude(system, [{ role: 'user', content: lang === 'pt' ? 'Gere a análise.' : 'Generate the analysis.' }]);
      setDietSummary({ date: today, text: text.trim() });
    } catch (e) { flash(lang === 'pt' ? 'Não consegui gerar a análise agora.' : "Couldn't generate analysis now."); }
    setSumLoading(false);
  };
  useEffect(() => {
    if (!dietSummary || dietSummary.date !== today) genDietSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pickImage = (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result).split(',')[1];
      try {
        const res = await classifyPhotoSmart(b64, file.type, lang);
        if (res.kind === 'meal') setMealDraft(res);
        else flash(lang === 'pt' ? 'Não parece uma foto de refeição.' : "Doesn't look like a meal photo.");
      } catch (err) { flash(lang === 'pt' ? 'Não consegui ler a imagem.' : "Couldn't read image."); }
    };
    reader.readAsDataURL(file);
  };
  const saveMeal = (m) => {
    addItem({ type: 'meal', domain: 'health', title: m.title, date: today, time: nowHM(), meta: { calories: m.calories, proteinG: m.proteinG, carbsG: m.carbsG, fatG: m.fatG, source: 'photo' } });
    flash(lang === 'pt' ? 'Refeição registrada ✓' : 'Meal logged ✓');
    setMealDraft(null);
  };
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('health')}</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #F0928A, #E5544B)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Flame size={20} style={{ color: '#fff' }} /></div>
        <div style={{ fontSize: 22, fontWeight: 600 }}>{lang === 'pt' ? 'Dieta' : 'Diet'}</div>
      </div>
      <div style={{ ...card, padding: 15, marginBottom: 14, border: '1px solid #E5544B33', background: 'linear-gradient(135deg, #E5544B14, ' + C.surface + ')' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><DrClaudeBadge size={22} /><span style={{ fontSize: 12, fontWeight: 700, color: '#E5544B' }}>{lang === 'pt' ? 'Como estou indo' : 'How am I doing'}</span></div>
          <button onClick={genDietSummary} disabled={sumLoading} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', padding: 3 }}>{sumLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}</button>
        </div>
        {sumLoading && !dietSummary ? <div style={{ fontSize: 13, color: C.text3 }}>{lang === 'pt' ? 'Gerando...' : 'Generating...'}</div> : (
          <div style={{ fontSize: 13.5, lineHeight: 1.55, color: C.text }}>{dietSummary ? dietSummary.text : (lang === 'pt' ? 'Toque em atualizar pra gerar sua análise.' : 'Tap refresh to generate your analysis.')}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <Btn onClick={() => fileRef.current && fileRef.current.click()} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Camera size={16} />{lang === 'pt' ? 'Fotografar refeição' : 'Photo meal'}</Btn>
        <Btn kind="soft" onClick={() => setAdding(true)} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{lang === 'pt' ? 'Manual' : 'Manual'}</Btn>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={pickImage} style={{ display: 'none' }} />
      </div>
      <div style={{ ...card, padding: 15, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div><span style={{ fontSize: 22, fontWeight: 700, color: '#E5544B' }}>{todayCals}</span><span style={{ fontSize: 12, color: C.text3, marginLeft: 5 }}>kcal {lang === 'pt' ? 'hoje' : 'today'}</span></div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Chip active={chartDays === 14} onClick={() => setChartDays(14)}>14d</Chip>
            <Chip active={chartDays === 30} onClick={() => setChartDays(30)}>30d</Chip>
          </div>
        </div>
        <CalorieChart meals={meals} lang={lang} days={chartDays} />
      </div>
      {openClaude && <Btn kind="ghost" onClick={() => openClaude(lang === 'pt' ? 'Quero conversar sobre como melhorar minha dieta e meus hábitos alimentares.' : 'I want to talk about improving my diet and eating habits.')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><DrClaudeBadge size={16} />{lang === 'pt' ? 'Falar com o Dr. Claude' : 'Talk to Dr. Claude'}</Btn>}
      <SectionTitle icon={Utensils} label={lang === 'pt' ? 'Histórico de refeições' : 'Meal history'} color={C.rose} />
      <DietCalendar meals={meals} lang={lang} sel={selDate} setSel={setSelDate} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '4px 2px 10px' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, textTransform: 'capitalize' }}>{selDate === today ? (lang === 'pt' ? 'Hoje' : 'Today') : fmtLong(selDate, lang)}</span>
        {selCals > 0 && <span style={{ fontSize: 12.5, fontWeight: 700, color: '#E5544B' }}>{selCals} kcal</span>}
      </div>
      {selMeals.length === 0 ? <Empty icon={Utensils} text={lang === 'pt' ? 'Nenhuma refeição registrada nesse dia.' : 'No meals logged this day.'} /> : selMeals.map((m) => <MealRow key={m.id} m={m} lang={lang} onOpen={onOpen} hideDate />)}
      {mealDraft && <MealConfirmModal draft={mealDraft} lang={lang} t={t} onSave={saveMeal} onCancel={() => setMealDraft(null)} />}
      {adding && <AddModal title={t('t_meal')} icon={Utensils} draft={{ type: 'meal', domain: 'health', date: today, time: nowHM(), meta: {} }} allowedTypes={['meal']} lang={lang} t={t} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: 'health', ...x }); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}

function SleepCard({ s, lang, t }) {
  const hm = (sec) => (sec == null ? '—' : `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`);
  const parts = [['deep', s.deep, C.violet, t('deepS')], ['rem', s.rem, C.blue, t('remS')], ['light', s.light, C.teal, t('lightS')], ['awake', s.awake, C.text3, t('awakeS')]];
  const tot = parts.reduce((a, b) => a + (b[1] || 0), 0) || 1;
  const phases = typeof s.phases === 'string' ? s.phases.split('') : [];
  const colorOf = (ch) => (ch === '1' ? C.violet : ch === '2' ? C.teal : ch === '3' ? C.blue : C.surface2);
  return (
    <div style={{ ...card, padding: 16, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: C.text, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('sleepStages')}</span>
        <span style={{ fontSize: 11.5, color: C.text2 }}>{t('lastNight')} · {hm(s.total)}</span>
      </div>
      {phases.length > 0 && (
        <div style={{ display: 'flex', gap: 1, height: 46, marginBottom: 12, alignItems: 'stretch' }}>
          {phases.map((ch, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', alignItems: ch === '4' ? 'flex-start' : ch === '3' ? 'center' : 'flex-end' }}>
              <div style={{ width: '100%', height: ch === '1' ? '100%' : ch === '2' ? '58%' : ch === '3' ? '46%' : '26%', background: colorOf(ch), borderRadius: 1 }} />
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', height: 9, borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
        {parts.map(([k, v, col]) => <div key={k} style={{ width: ((v || 0) / tot) * 100 + '%', background: col }} />)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {parts.map(([k, v, col, label]) => (
          <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: col }} />
            <span style={{ color: C.text2 }}>{label}</span>
            <span style={{ fontWeight: 700 }}>{hm(v)}</span>
          </div>
        ))}
      </div>
      {(s.efficiency || s.hrLowest || s.hrv) && (
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          {s.efficiency != null && <MiniStat label={t('efficiency')} value={s.efficiency + '%'} color={C.green} />}
          {s.hrLowest != null && <MiniStat label="FC mín" value={s.hrLowest} color={C.rose} />}
          {s.hrv != null && <MiniStat label="HRV" value={s.hrv} color={C.blue} />}
        </div>
      )}
    </div>
  );
}

function WeightLog({ lang, t, current, onSave, onClose }) {
  const [v, setV] = useState(current ? String(current) : '');
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('addWeight')} onClose={onClose} icon={Scale} />
      <Field label={t('weight') + ' (kg)'}>
        <input type="number" step="0.1" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} autoFocus style={{ ...inputStyle, fontSize: 22, fontWeight: 700, textAlign: 'center', padding: '16px 12px' }} />
      </Field>
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 12, textAlign: 'center' }}>{fmtLong(todayISO(), lang)}</div>
      <Btn onClick={() => { const n = Number(String(v).replace(',', '.')); if (!isNaN(n) && n > 0) onSave(n); }} disabled={!v} style={{ width: '100%' }}>{t('save')}</Btn>
      <div style={{ fontSize: 11, color: C.text3, marginTop: 12, textAlign: 'center' }}>{t('heightSettings')}</div>
    </Modal>
  );
}

function WeightHistory({ weights, lang, t }) {
  const list = (weights || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (list.length < 2) return null;
  const vals = list.map((x) => x.kg);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const W = 300, H = 74;
  const pts = list.map((x, i) => {
    const px = list.length === 1 ? W / 2 : (i / (list.length - 1)) * W;
    const py = H - ((x.kg - min) / span) * (H - 14) - 7;
    return [px, py];
  });
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = d + ` L${W},${H} L0,${H} Z`;
  const first = list[0], last = list[list.length - 1];
  const delta = last.kg - first.kg;
  return (
    <div style={{ ...card, padding: 16, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: C.text, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('weightHistory')}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: delta > 0 ? C.rose : delta < 0 ? C.green : C.text2 }}>
          {delta > 0 ? '+' : ''}{delta.toFixed(1).replace('.', ',')} kg
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 84, display: 'block' }} preserveAspectRatio="none">
        <path d={area} fill={C.rose + '22'} />
        <path d={d} fill="none" stroke={C.rose} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2.5" fill={C.rose} />)}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: C.text3, marginTop: 6 }}>
        <span>{fmtDate(first.date, lang)} · {first.kg}kg</span>
        <span>{fmtDate(last.date, lang)} · {last.kg}kg</span>
      </div>
    </div>
  );
}

function tuyaKind(device, prefs) {
  const p = prefs && prefs[device.id];
  if (p && p.kind && p.kind !== 'auto') return p.kind;
  const c = device.category || '';
  if (/dj|dc|dd|xdd|fwd|tgq|tyndj|fsd|tgkg/.test(c)) return 'light';
  if (/cz|pc/.test(c)) return 'plug';
  if (/kg|tdq/.test(c)) return 'switch';
  if (/kt|ktkzq|qn|wk|wkf/.test(c)) return 'climate';
  return 'switch';
}
function tuyaLabel(device, prefs) {
  const p = prefs && prefs[device.id];
  return (p && p.alias) ? p.alias : device.name;
}

function LgCard({ device, host, t, lang, flash, label, lastState, onStateChange }) {
  const [remote, setRemote] = useState(false); const [wash, setWash] = useState(false);
  // sem leitura ainda (ou aparelho offline/fetch falhou): parte do último estado salvo, marcado como "stale"
  const [quick, setQuick] = useState(() => lastState ? { on: lastState.on, temp: lastState.temp, cur: lastState.cur, stale: true } : null);
  const [busy, setBusy] = useState(false);
  const isAc = device.type === 'DEVICE_AIR_CONDITIONER';
  const isWasher = device.type === 'DEVICE_WASHER' || device.type === 'DEVICE_DRYER';
  const Ic = isAc ? Wind : isWasher ? Waves : Power;
  const loadQuick = () => {
    if (!isAc || !device.online) return;
    authFetch('/api/lg', { method: 'POST', body: JSON.stringify({ deviceId: device.id, host, op: 'status' }) })
      .then((r) => r.json()).then((j) => { if (!j.state) return; const st = j.state;
        const next = { on: st.operation && st.operation.airConOperationMode === 'POWER_ON', temp: st.temperature && st.temperature.targetTemperature, cur: st.temperature && st.temperature.currentTemperature };
        setQuick(next);
        onStateChange && onStateChange(next);
      })
      .catch(() => {});
  };
  useEffect(() => { let alive = true; if (isAc && device.online) loadQuick(); return () => { alive = false; }; }, [device.id]);
  const cmd = async (op, value) => {
    setBusy(true);
    try { await authFetch('/api/lg', { method: 'POST', body: JSON.stringify({ deviceId: device.id, host, op, value }) }); setTimeout(loadQuick, 800); }
    catch (e) {}
    setBusy(false);
  };
  if (isAc) {
    return (
      <>
        <div style={{ ...card, padding: 13, opacity: device.online ? 1 : 0.55 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: (quick && quick.on) ? '#A50034' + '22' : C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              <Ic size={17} style={{ color: (quick && quick.on) ? '#FF3B6B' : '#A50034' }} />
              {quick && quick.stale && <span title={t('lastKnown')} style={{ position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: C.amber || '#f5a623', border: `1.5px solid ${C.bg}` }} />}
            </div>
            <button onClick={() => device.online && cmd('power', !(quick && quick.on))} disabled={!device.online || busy} style={{ width: 42, height: 25, borderRadius: 999, border: 'none', background: (quick && quick.on) ? C.green : C.surface2, position: 'relative', cursor: device.online ? 'pointer' : 'not-allowed' }}>
              <span style={{ position: 'absolute', top: 3, left: (quick && quick.on) ? 20 : 3, width: 19, height: 19, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
            </button>
          </div>
          <div onClick={() => device.online && setRemote(true)} style={{ fontSize: 13, fontWeight: 600, marginTop: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{label || device.name}</div>
          {quick && quick.on ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <button onClick={() => cmd('temp', Math.max(16, (quick.temp || 23) - 1))} disabled={busy} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>−</button>
              <div style={{ fontSize: 19, fontWeight: 800, color: '#FF3B6B' }}>{quick.temp}°{quick.cur != null && <span style={{ fontSize: 10, color: C.text3, fontWeight: 400 }}> · amb {quick.cur}°</span>}</div>
              <button onClick={() => cmd('temp', Math.min(30, (quick.temp || 23) + 1))} disabled={busy} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>＋</button>
            </div>
          ) : (
            <div onClick={() => device.online && setRemote(true)} style={{ fontSize: 11, color: device.online ? C.text3 : C.rose, marginTop: 4, cursor: 'pointer' }}>
              {!device.online ? t('offline') : (quick && quick.cur != null ? (lang === 'pt' ? `Ambiente: ${quick.cur}°` : `Room: ${quick.cur}°`) : t('openRemote'))}
            </div>
          )}
        </div>
        {remote && <LgAcRemote device={device} host={host} t={t} lang={lang} flash={flash} onClose={() => { setRemote(false); loadQuick(); }} />}
      </>
    );
  }
  return (
    <>
      <button onClick={() => { if (!device.online) return; setWash(true); }} disabled={!device.online} style={{ ...card, padding: 13, textAlign: 'left', cursor: device.online ? 'pointer' : 'default', opacity: device.online ? 1 : 0.55, border: 'none', width: '100%', color: C.text }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={17} style={{ color: '#A50034' }} /></div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || device.name}</div>
        <div style={{ fontSize: 10.5, color: device.online ? C.text3 : C.rose, marginTop: 2 }}>{!device.online ? t('offline') : (isWasher ? (lang === 'pt' ? 'Ver status' : 'Status') : 'LG')}</div>
      </button>
      {wash && <LgWasherStatus device={device} host={host} label={label} t={t} lang={lang} onClose={() => setWash(false)} />}
    </>
  );
}

function LgWasherStatus({ device, host, label, t, lang, onClose }) {
  const [st, setSt] = useState(null); const [err, setErr] = useState(null); const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    authFetch('/api/lg', { method: 'POST', body: JSON.stringify({ deviceId: device.id, host, op: 'status' }) })
      .then((r) => r.json()).then((j) => { if (j.error) setErr(j.error); else { setSt(j.state); setErr(null); } setLoading(false); }).catch((e) => { setErr(String(e)); setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  const pt = lang === 'pt';
  // dicionario de estados
  const STATE = {
    POWER_OFF: pt ? 'Desligada' : 'Off', INITIAL: pt ? 'Pronta' : 'Ready', RUNNING: pt ? 'Lavando' : 'Running',
    PAUSE: pt ? 'Pausada' : 'Paused', END: pt ? 'Concluída' : 'Done', DETECTING: pt ? 'Detectando carga' : 'Detecting',
    RINSING: pt ? 'Enxaguando' : 'Rinsing', SPINNING: pt ? 'Centrifugando' : 'Spinning', DRYING: pt ? 'Secando' : 'Drying',
    SOAKING: pt ? 'De molho' : 'Soaking', RESERVED: pt ? 'Agendada' : 'Reserved', ERROR: pt ? 'Erro' : 'Error',
    STEAM_SOFTENING: pt ? 'Vapor' : 'Steam', COOL_DOWN: pt ? 'Resfriando' : 'Cooling', RINSE_HOLD: pt ? 'Enxágue em espera' : 'Rinse hold',
    REFRESHING: pt ? 'Refrescando' : 'Refreshing', SLEEP: pt ? 'Repouso' : 'Sleep', PREWASH: pt ? 'Pré-lavagem' : 'Prewash',
    ADD_DRAIN: pt ? 'Drenando' : 'Draining', DISPENSING: pt ? 'Dosando' : 'Dispensing',
  };
  const run = st && st.runState && st.runState.currentState;
  const running = run && !['POWER_OFF', 'END', 'INITIAL', 'ERROR', 'SLEEP'].includes(run);
  const timer = (st && st.timer) || {};
  const remainH = timer.remainHour || 0, remainM = timer.remainMinute || 0;
  const totalH = timer.totalHour || 0, totalM = timer.totalMinute || 0;
  const hasRemain = remainH > 0 || remainM > 0;
  const cycles = st && st.cycle && st.cycle.cycleCount;
  const remoteOn = st && st.remoteControlEnable && st.remoteControlEnable.remoteControlEnabled;
  const loc = st && st.location && st.location.locationName;
  const detergent = st && st.detergent && (st.detergent.detergentSetting);
  const doorState = st && (st.door && (st.door.doorState)) ;
  const errState = st && st.error && (typeof st.error === 'string' ? st.error : st.error.code);

  const fmtHM = (h, m) => (h > 0 ? h + 'h' : '') + (h > 0 ? String(m).padStart(2, '0') : m) + 'min';

  // linha de indicador
  const Ind = ({ icon: Ic, label, value, color }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 14px', borderTop: `1px solid ${C.borderSoft}` }}>
      <span style={{ fontSize: 12.5, color: C.text2, display: 'flex', gap: 9, alignItems: 'center' }}><Ic size={14} style={{ color: color || C.text3 }} />{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: color || C.text }}>{value}</span>
    </div>
  );

  return (
    <Modal onClose={onClose}>
      <SheetHead title={label || device.name} onClose={onClose} icon={Waves} />
      {err && <div style={{ ...card, padding: 10, marginBottom: 10, fontSize: 11, color: C.rose, wordBreak: 'break-word' }}>{err}</div>}

      {!st && loading ? (
        <div style={{ ...card, padding: 26, textAlign: 'center', color: C.text3, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={15} className="spin" />…</div>
      ) : st ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {/* Estado grande */}
          <div style={{ ...card, padding: 20, textAlign: 'center' }}>
            <div style={{ width: 58, height: 58, borderRadius: 999, background: running ? C.blue + '22' : (run === 'END' ? C.green + '22' : C.surface2), display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <Waves size={27} style={{ color: running ? C.blue : (run === 'END' ? C.green : C.text3) }} className={running ? 'spin' : ''} />
            </div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{STATE[run] || run || '—'}</div>
            {hasRemain && <div style={{ fontSize: 14, color: C.blue, marginTop: 6, fontWeight: 600 }}>{pt ? 'Faltam ' : ''}{fmtHM(remainH, remainM)}{pt ? '' : ' left'}</div>}
          </div>

          {/* Todos os indicadores disponíveis */}
          <div style={{ ...card, padding: '2px 0' }}>
            {(totalH > 0 || totalM > 0) && <Ind icon={Clock} label={pt ? 'Duração do ciclo' : 'Cycle length'} value={fmtHM(totalH, totalM)} color={C.text} />}
            {hasRemain && <Ind icon={Clock} label={pt ? 'Tempo restante' : 'Remaining'} value={fmtHM(remainH, remainM)} color={C.blue} />}
            {cycles != null && <Ind icon={RefreshCw} label={pt ? 'Ciclos realizados' : 'Cycles run'} value={cycles} color={C.violet} />}
            <Ind icon={remoteOn ? Wifi : WifiOff} label={pt ? 'Controle remoto' : 'Remote control'} value={remoteOn ? (pt ? 'Ativo' : 'On') : (pt ? 'Desativado' : 'Off')} color={remoteOn ? C.green : C.text3} />
            {loc && <Ind icon={MapPin} label={pt ? 'Local' : 'Location'} value={loc} color={C.text2} />}
            {detergent && <Ind icon={Droplet} label={pt ? 'Detergente' : 'Detergent'} value={detergent} color={C.sky} />}
            {doorState && <Ind icon={Lock} label={pt ? 'Porta' : 'Door'} value={doorState} color={C.text2} />}
            {errState && errState !== 'ERROR_NO' && <Ind icon={AlertTriangle} label={pt ? 'Erro' : 'Error'} value={errState} color={C.rose} />}
          </div>

          <button onClick={load} style={{ ...card, padding: '13px', color: C.text2, cursor: 'pointer', display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontSize: 13, border: 'none', width: '100%' }}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{t('refresh')}</button>
        </div>
      ) : null}
    </Modal>
  );
}

function LgAcRemote({ device, host, t, lang, flash, onClose }) {
  const [st, setSt] = useState(null); const [err, setErr] = useState(null); const [temp, setTemp] = useState(23);
  const load = () => authFetch('/api/lg', { method: 'POST', body: JSON.stringify({ deviceId: device.id, host, op: 'status' }) })
    .then((r) => r.json()).then((j) => {
      if (j.error) { setErr(j.error); return; }
      setSt(j.state);
      const tt = j.state && j.state.temperature && j.state.temperature.targetTemperature;
      if (tt) setTemp(tt);
    }).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);
  const cmd = async (op, value) => {
    setErr(null);
    try { const r = await authFetch('/api/lg', { method: 'POST', body: JSON.stringify({ deviceId: device.id, host, op, value }) }); const j = await r.json(); if (!j.ok) setErr(j.error || 'falhou'); else setTimeout(load, 800); }
    catch (e) { setErr(String(e)); }
  };
  const cur = st && st.temperature && (st.temperature.currentTemperature);
  const power = st && st.operation && st.operation.airConOperationMode;
  const mode = st && st.airConJobMode && st.airConJobMode.currentJobMode;
  const wind = st && st.airFlow && st.airFlow.windStrength;
  const isOn = power === 'POWER_ON';
  return (
    <Modal onClose={onClose}>
      <SheetHead title={device.name} onClose={onClose} icon={Wind} />
      {err && <div style={{ ...card, padding: 10, marginBottom: 10, fontSize: 11, color: C.rose, fontFamily: 'monospace', wordBreak: 'break-word' }}>{err}</div>}
      {!st ? <div style={{ ...card, padding: 24, textAlign: 'center', color: C.text3, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={15} className="spin" />…</div> : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ ...card, padding: 16, textAlign: 'center' }}>
            {cur != null && <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 4 }}>{lang === 'pt' ? 'Ambiente' : 'Room'}: {cur}°</div>}
            <div style={{ fontSize: 40, fontWeight: 800, color: C.accent }}>{temp}°</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10 }}>
              <IRBtn onClick={() => { const v = Math.max(16, temp - 1); setTemp(v); cmd('temp', v); }} wide>−</IRBtn>
              <IRBtn onClick={() => { const v = Math.min(30, temp + 1); setTemp(v); cmd('temp', v); }} wide>＋</IRBtn>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('acMode')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <IRBtn onClick={() => cmd('mode', 'COOL')} accent={mode === 'COOL'}>❄ {t('cold')}</IRBtn>
              <IRBtn onClick={() => cmd('mode', 'HEAT')} accent={mode === 'HEAT'}>☀ {t('hot')}</IRBtn>
              <IRBtn onClick={() => cmd('mode', 'FAN')} accent={mode === 'FAN'}>💨 {t('fan')}</IRBtn>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('fanSpeed')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <IRBtn onClick={() => cmd('wind', 'LOW')} accent={wind === 'LOW'}>1</IRBtn>
              <IRBtn onClick={() => cmd('wind', 'MID')} accent={wind === 'MID'}>2</IRBtn>
              <IRBtn onClick={() => cmd('wind', 'HIGH')} accent={wind === 'HIGH'}>3</IRBtn>
            </div>
          </div>
          <IRBtn onClick={() => cmd('power', !isOn)} accent>{isOn ? '⏻ ' + t('turnOff') : '⏻ ' + t('power')}</IRBtn>
        </div>
      )}
    </Modal>
  );
}

function isBlockedTuya(d) {
  const n = ((d && (d.name || d.alias)) || '').toLowerCase();
  return /port[aã]o|mod[-_ ]?port|garagem|gate/.test(n);
}
function TuyaDeviceGrid({ devices, prefs, setPrefs, t, lang, onCmd, onConfig }) {
  const saveLastState = (id, next) => setPrefs && setPrefs((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), lastState: { ...next, ts: Date.now() } } }));
  // decide quais mostrar: se ha alguma preferencia salva, respeita "show";
  // se nao ha NENHUMA pref ainda, mostra todos (primeiro uso).
  const hasPrefs = prefs && Object.keys(prefs).length > 0;
  const visible = devices.filter((d) => !isBlockedTuya(d)).filter((d) => {
    const p = prefs && prefs[d.id];
    if (!hasPrefs) return true;
    return p ? p.show !== false : false; // sem pref = escondido depois que o usuario ja configurou algo
  });
  if (visible.length === 0) {
    return (
      <div style={{ ...card, padding: 18, marginBottom: 10, textAlign: 'center' }}>
        <div style={{ fontSize: 12.5, color: C.text3, marginBottom: 10 }}>{lang === 'pt' ? 'Nenhum aparelho selecionado para a Casa.' : 'No devices selected for Home.'}</div>
        <Btn kind="soft" onClick={onConfig} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}><Cog size={14} />{t('choose')}</Btn>
      </div>
    );
  }
  // agrupar por comodo
  const groups = {};
  visible.forEach((d) => { const room = (prefs && prefs[d.id] && prefs[d.id].room) || ''; (groups[room] = groups[room] || []).push(d); });
  // ordem fixa dos comodos (o que nao estiver na lista vai pro fim, alfabetico)
  const ORDER = ['Suíte', 'Sala de TV', 'Quarto Maria', 'Quarto Dudu', 'Cozinha', 'Home-office'];
  const rank = (r) => { const i = ORDER.indexOf(r); return i === -1 ? 99 : i; };
  const roomNames = Object.keys(groups).sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));
  });
  // Suite e Sala sempre abertos; demais colapsados por padrao
  const alwaysOpen = ['Suíte', 'Sala de TV'];
  return (
    <div style={{ marginBottom: 4 }}>
      {roomNames.map((room) => (
        <RoomGroup key={room || 'sem'} room={room} defaultOpen={alwaysOpen.includes(room)} lang={lang}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {groups[room].map((d) => <TuyaCard key={d.id} device={d} kind={tuyaKind(d, prefs)} label={tuyaLabel(d, prefs)} irId={(prefs && prefs[d.id] && prefs[d.id].ir) || null} t={t} lang={lang} onCmd={onCmd} lastState={(prefs && prefs[d.id] && prefs[d.id].lastState) || null} onStateChange={(next) => saveLastState(d.id, next)} />)}
          </div>
        </RoomGroup>
      ))}
    </div>
  );
}

function RoomGroup({ room, defaultOpen, lang, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const title = room || (lang === 'pt' ? 'Outros' : 'Other');
  if (defaultOpen) {
    // sempre aberto: mostra titulo simples, sem colapsar
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11.5, color: C.text2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', margin: '2px 2px 8px' }}>{title}</div>
        {children}
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 10 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ ...card, padding: '11px 13px', width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', border: 'none', color: C.text, marginBottom: open ? 10 : 0 }}>
        <span style={{ fontSize: 12.5, color: C.text2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>{title}</span>
        <ChevronRight size={16} style={{ color: C.text3, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
      </button>
      {open && children}
    </div>
  );
}

function TuyaConfig({ devices, prefs, setPrefs, lang, t, onClose }) {
  const kinds = [['auto', 'Auto'], ['light', lang === 'pt' ? 'Luz' : 'Light'], ['plug', lang === 'pt' ? 'Tomada' : 'Plug'], ['switch', lang === 'pt' ? 'Interruptor' : 'Switch'], ['ac', lang === 'pt' ? 'Ar-cond.' : 'A/C'], ['tv', 'TV'], ['stb', lang === 'pt' ? 'TV a cabo' : 'Set-top'], ['receiver', 'Receiver']];
  const get = (id) => (prefs && prefs[id]) || {};
  const patch = (id, p) => setPrefs((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...p } }));
  const allShown = devices.every((d) => get(d.id).show !== false);
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('configDevices')} onClose={onClose} icon={Power} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: C.text3 }}>{devices.length} {lang === 'pt' ? 'aparelhos' : 'devices'}</span>
        <button onClick={() => devices.forEach((d) => patch(d.id, { show: !allShown }))} style={{ ...card, padding: '5px 10px', color: C.accent, cursor: 'pointer', fontSize: 11.5 }}>{allShown ? (lang === 'pt' ? 'Ocultar todos' : 'Hide all') : (lang === 'pt' ? 'Mostrar todos' : 'Show all')}</button>
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {devices.filter((d) => !isBlockedTuya(d)).map((d) => {
          const p = get(d.id); const show = p.show !== false;
          return (
            <div key={d.id} style={{ ...card, padding: 12, marginBottom: 8, opacity: show ? 1 : 0.6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={() => patch(d.id, { show: !show })} style={{ width: 40, height: 24, borderRadius: 999, border: 'none', background: show ? C.green : C.surface2, position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
                  <span style={{ position: 'absolute', top: 3, left: show ? 19 : 3, width: 18, height: 18, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.alias || d.name}</div>
                  <div style={{ fontSize: 10, color: C.text3 }}>{d.brand ? d.brand + ' · ' : ''}{d.name}</div>
                </div>
              </div>
              {show && (
                <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                  <input value={p.alias || ''} onChange={(e) => patch(d.id, { alias: e.target.value })} placeholder={lang === 'pt' ? 'Apelido (ex.: Luz da sala)' : 'Nickname'} style={{ ...inputStyle, padding: '9px 11px', fontSize: 13 }} />
                  <input value={p.room || ''} onChange={(e) => patch(d.id, { room: e.target.value })} placeholder={lang === 'pt' ? 'Cômodo (ex.: Sala, Quarto)' : 'Room'} style={{ ...inputStyle, padding: '9px 11px', fontSize: 13 }} />
                  {d.brand !== 'LG' && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {kinds.map(([k, lab]) => (
                      <button key={k} onClick={() => patch(d.id, { kind: k })} style={{ padding: '5px 10px', borderRadius: 999, border: `1px solid ${(p.kind || 'auto') === k ? C.accent : C.border}`, background: (p.kind || 'auto') === k ? C.accentSoft : 'transparent', color: (p.kind || 'auto') === k ? C.accent : C.text3, fontSize: 11.5, cursor: 'pointer' }}>{lab}</button>
                    ))}
                  </div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Btn onClick={onClose} style={{ width: '100%', marginTop: 12 }}>{t('done')}</Btn>
    </Modal>
  );
}

function TuyaLight({ device, label, t, onCmd, onClose }) {
  const st = device.status || {};
  const [bri, setBri] = useState(st.bright_value_v2 != null ? st.bright_value_v2 : (st.bright_value != null ? st.bright_value : 500));
  const briCode = st.bright_value_v2 != null ? 'bright_value_v2' : 'bright_value';
  const briMax = briCode === 'bright_value_v2' ? 1000 : 255;
  const colours = [
    ['Vermelho', 0], ['Laranja', 30], ['Amarelo', 60], ['Verde', 120],
    ['Ciano', 180], ['Azul', 240], ['Roxo', 280], ['Rosa', 320],
  ];
  const setColour = (h) => {
    onCmd(device.id, 'work_mode', 'colour');
    onCmd(device.id, st.colour_data_v2 !== undefined ? 'colour_data_v2' : 'colour_data', { h, s: 1000, v: 1000 });
  };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={label} onClose={onClose} icon={Lightbulb} />
      <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 8 }}>{t('brightness')}</div>
      <input type="range" min="10" max={briMax} value={bri} onChange={(e) => setBri(Number(e.target.value))} onMouseUp={() => onCmd(device.id, briCode, bri)} onTouchEnd={() => onCmd(device.id, briCode, bri)}
        style={{ width: '100%', accentColor: C.accent, marginBottom: 6 }} />
      <div style={{ textAlign: 'right', fontSize: 11, color: C.text3, marginBottom: 16 }}>{Math.round((bri / briMax) * 100)}%</div>

      <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 8 }}>{t('color')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {colours.map(([nome, h]) => (
          <button key={h} onClick={() => setColour(h)} title={nome} style={{ height: 44, borderRadius: 12, border: `1px solid ${C.border}`, background: `hsl(${h} 85% 55%)`, cursor: 'pointer' }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="soft" onClick={() => { onCmd(device.id, 'work_mode', 'white'); }} style={{ flex: 1, fontSize: 12.5 }}>{t('whiteLight')}</Btn>
        <Btn kind="soft" onClick={() => { const sw = tuyaSwitchCode(st); if (sw) onCmd(device.id, sw, false); onClose(); }} style={{ flex: 1, fontSize: 12.5 }}>{t('turnOff')}</Btn>
      </div>
    </Modal>
  );
}

function IRBtn({ children, onClick, wide, accent }) {
  return <button onClick={onClick ? (e) => { haptic(12); onClick(e); } : undefined} style={{ padding: wide ? '12px 10px' : '12px 0', borderRadius: 12, border: `1px solid ${C.border}`, background: accent ? C.accentSoft : C.surface2, color: accent ? C.accent : C.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', minWidth: 0 }}>{children}</button>;
}

// Para controles IR "universais" da Tuya, os comandos vao pelo code padrao.
// Como cada remoto aprendido pode variar, usamos os codes comuns e deixamos claro
// que ajustamos caso algum botao nao responda.
function TuyaRemote({ device, kind, label, irId, t, lang, onClose, acState, onAcChange }) {
  const [keys, setKeys] = useState(null); const [meta, setMeta] = useState({}); const [err, setErr] = useState(null); const [sending, setSending] = useState(''); const [showAll, setShowAll] = useState(false);
  const acSaved = acState || {};
  const [temp, setTemp] = useState(acSaved.temp != null ? acSaved.temp : 23);
  const [mode, setMode] = useState(acSaved.mode || 'cold');
  const [wind, setWind] = useState(acSaved.wind || 'auto');
  const [power, setPower] = useState(acSaved.power != null ? acSaved.power : true);

  // Busca as teclas reais para TV/STB/receiver
  useEffect(() => {
    if (!irId) { setErr('Sem hub IR configurado.'); return; }
    if (kind === 'ac') return; // ar usa comandos proprios
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    authFetch(`/api/tuya?keys=1&infrared_id=${irId}&remote_id=${device.id}`, { signal: ctrl.signal }).then((r) => r.json())
      .then((j) => { clearTimeout(to); setKeys(j.keys || []); setMeta(j.meta || {}); if (j.error) setErr(j.error); })
      .catch((e) => { clearTimeout(to); setKeys([]); setErr(e.name === 'AbortError' ? 'Tempo esgotado ao buscar teclas.' : String(e)); });
  }, [irId, device.id, kind]);

  const sendKey = async (keyObj) => {
    setSending(keyObj.key_id || keyObj.key || keyObj.key_name);
    try {
      const r = await authFetch('/api/tuya', { method: 'POST', body: JSON.stringify({ ir: 'key', infrared_id: irId, remote_id: device.id, key: keyObj.key || keyObj.key_name, key_id: keyObj.key_id, category_id: meta.category_id, remote_index: meta.remote_index }) });
      const j = await r.json();
      if (!j.ok) setErr(j.error || 'falhou');
    } catch (e) { setErr(String(e)); }
    setSending('');
  };

  const sendAc = async (patch) => {
    const next = { power, mode, temp, wind, ...patch };
    setPower(next.power); setMode(next.mode); setTemp(next.temp); setWind(next.wind);
    onAcChange && onAcChange(next);
    try {
      const r = await authFetch('/api/tuya', { method: 'POST', body: JSON.stringify({ ir: 'ac', infrared_id: irId, remote_id: device.id, acCode: 'all', acValue: { power: next.power ? 1 : 0, mode: next.mode, temp: next.temp, wind: next.wind } }) });
      const j = await r.json();
      if (!j.ok) setErr(j.error || 'falhou');
    } catch (e) { setErr(String(e)); }
  };

  // Agrupa teclas comuns para TV/STB/receiver
  const norm = (x) => String(x || '').toLowerCase().replace(/[\s_\-\.]/g, '');
  const findKey = (names) => {
    const set = names.map(norm);
    return (keys || []).find((k) => set.includes(norm(k.key_name)) || set.includes(norm(k.key)) || set.includes(norm(k.key_id)));
  };
  const KeyBtn = ({ names, label: lb, accent }) => {
    const k = findKey(names);
    if (!k) return null;
    return <IRBtn onClick={() => sendKey(k)} accent={accent}>{sending === (k.key_id || k.key || k.key_name) ? '…' : lb}</IRBtn>;
  };

  // teclado numerico (STB/Vivo)
  const NumPad = () => {
    const nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    const found = nums.map((n) => findKey([n, 'num_' + n, 'number_' + n, 'digit_' + n, 'key_' + n]));
    if (!found.some(Boolean)) return null;
    return (
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{lang === 'pt' ? 'Canais' : 'Numbers'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {nums.slice(0, 9).map((n, i) => found[i] ? <IRBtn key={n} onClick={() => sendKey(found[i])}>{n}</IRBtn> : <div key={n} />)}
          <div />
          {found[9] ? <IRBtn onClick={() => sendKey(found[9])}>0</IRBtn> : <div />}
          <div />
        </div>
      </div>
    );
  };

  const DPad = () => {
    const up = findKey(['up', 'menu_up', 'dpad_up', 'nav_up']);
    const down = findKey(['down', 'menu_down', 'dpad_down', 'nav_down']);
    const left = findKey(['left', 'menu_left', 'dpad_left', 'nav_left']);
    const right = findKey(['right', 'menu_right', 'dpad_right', 'nav_right']);
    const ok = findKey(['ok', 'enter', 'confirm', 'select', 'dpad_center']);
    if (!up && !down && !left && !right && !ok) return null;
    const Cell = ({ k, children }) => k ? <IRBtn onClick={() => sendKey(k)}>{children}</IRBtn> : <div />;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'center' }}>
        <div /><Cell k={up}>▲</Cell><div />
        <Cell k={left}>◀</Cell><Cell k={ok} >OK</Cell><Cell k={right}>▶</Cell>
        <div /><Cell k={down}>▼</Cell><div />
      </div>
    );
  };

  const Row2 = ({ children }) => <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>;

  return (
    <Modal onClose={onClose}>
      <SheetHead title={label} onClose={onClose} icon={kind === 'ac' ? Wind : kind === 'receiver' ? Radio : Tv} />
      {err && <div style={{ ...card, padding: 10, marginBottom: 10, fontSize: 11, color: C.rose, fontFamily: 'monospace', wordBreak: 'break-word' }}>{err}</div>}

      {kind === 'ac' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ ...card, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 40, fontWeight: 800, color: C.accent }}>{temp}°</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10 }}>
              <IRBtn onClick={() => sendAc({ temp: Math.max(16, temp - 1) })} wide>−</IRBtn>
              <IRBtn onClick={() => sendAc({ temp: Math.min(30, temp + 1) })} wide>＋</IRBtn>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('acMode')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <IRBtn onClick={() => sendAc({ mode: 'cold' })} accent={mode === 'cold'}>❄ {t('cold')}</IRBtn>
              <IRBtn onClick={() => sendAc({ mode: 'hot' })} accent={mode === 'hot'}>☀ {t('hot')}</IRBtn>
              <IRBtn onClick={() => sendAc({ mode: 'wind' })} accent={mode === 'wind'}>💨 {t('fan')}</IRBtn>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('fanSpeed')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              <IRBtn onClick={() => sendAc({ wind: 'low' })} accent={wind === 'low'}>1</IRBtn>
              <IRBtn onClick={() => sendAc({ wind: 'mid' })} accent={wind === 'mid'}>2</IRBtn>
              <IRBtn onClick={() => sendAc({ wind: 'high' })} accent={wind === 'high'}>3</IRBtn>
              <IRBtn onClick={() => sendAc({ wind: 'auto' })} accent={wind === 'auto'}>A</IRBtn>
            </div>
          </div>
          <IRBtn onClick={() => sendAc({ power: !power })} accent>{power ? '⏻ ' + t('turnOff') : '⏻ ' + t('power')}</IRBtn>
        </div>
      ) : keys === null ? (
        <div style={{ ...card, padding: 26, textAlign: 'center', color: C.text3, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Loader2 size={15} className="spin" />…</div>
      ) : keys.length === 0 ? (
        <div style={{ ...card, padding: 18, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{t('noKeys')}</div>
      ) : kind === 'receiver' ? (
        /* ---------- RECEIVER (Onkyo) ---------- */
        <div style={{ display: 'grid', gap: 12 }}>
          <Row2>
            <KeyBtn names={['power', 'power_off', 'power_on', 'onoff', 'on_off', 'standby']} label={'⏻ ' + t('power')} accent />
            <KeyBtn names={['mute', 'muting', 'vol_mute', 'volume_mute', 'sound_mute']} label={'🔇 Mute'} />
          </Row2>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('volume')}</div>
            <Row2>
              <KeyBtn names={['volume_up', 'vol+', 'vol_add', 'volumeup', 'vol_up', 'volup', 'v+', 'master_volume_up']} label={'🔊 +'} />
              <KeyBtn names={['volume_down', 'vol-', 'vol_sub', 'volumedown', 'vol_down', 'voldown', 'v-', 'master_volume_down']} label={'🔉 −'} />
            </Row2>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{lang === 'pt' ? 'Entradas' : 'Inputs'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <KeyBtn names={['cbl/sat', 'cbl_sat', 'cblsat', 'cbl', 'sat', 'cable', 'cbl sat', 'cblsat_input']} label={'CBL/SAT'} />
              <KeyBtn names={['net', 'network', 'internet', 'netradio', 'net_radio']} label={'NET'} />
              <KeyBtn names={['bluetooth', 'bt', 'blue_tooth', 'blue tooth']} label={'Bluetooth'} />
              <KeyBtn names={['game', 'game1', 'game2', 'games']} label={'Game'} />
              <KeyBtn names={['tuner', 'am', 'fm', 'radio', 'am/fm', 'amfm', 'am fm']} label={'Tuner'} />
              <KeyBtn names={['aux', 'aux1', 'aux2', 'auxiliary']} label={'Aux'} />
              <KeyBtn names={['pc', 'computer', 'vga', 'video']} label={'PC'} />
              <KeyBtn names={['dvd', 'bd/dvd', 'bd_dvd', 'bddvd', 'bd', 'blu-ray', 'bluray', 'bd dvd']} label={'BD/DVD'} />
              <KeyBtn names={['tv/cd', 'tv_cd', 'tvcd', 'tv', 'cd', 'tv cd']} label={'TV/CD'} />
              <KeyBtn names={['stb/dvr', 'stb_dvr', 'stbdvr', 'stb', 'dvr', 'stb dvr']} label={'STB/DVR'} />
              <KeyBtn names={['phono', 'turntable']} label={'Phono'} />
              <KeyBtn names={['usb']} label={'USB'} />
              <KeyBtn names={['hdmi', 'hdmi1', 'hdmi2']} label={'HDMI'} />
              <KeyBtn names={['input', 'source', 'input_selector', 'inputselector']} label={lang === 'pt' ? 'Entrada →' : 'Input →'} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{lang === 'pt' ? 'Modo de som' : 'Sound mode'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              <KeyBtn names={['movie', 'film', 'cinema']} label={'Movie'} />
              <KeyBtn names={['music']} label={'Music'} />
              <KeyBtn names={['game_mode', 'gamemode']} label={'Game'} />
              <KeyBtn names={['thx']} label={'THX'} />
              <KeyBtn names={['stereo']} label={'Stereo'} />
              <KeyBtn names={['direct', 'pure', 'pure_direct', 'puredirect']} label={'Direct'} />
              <KeyBtn names={['surround', 'surr']} label={'Surround'} />
              <KeyBtn names={['listening_mode', 'listeningmode', 'sound', 'mode']} label={'Mode'} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>Zone 2</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <KeyBtn names={['zone2', 'zone_2', 'z2', 'zone2_power', 'zone2power', 'zone 2', 'zone2_on', 'z2power', 'zone2 power']} label={lang === 'pt' ? 'Z2 Liga' : 'Z2 On'} />
              <KeyBtn names={['zone2_vol_up', 'zone2volup', 'z2_vol_up', 'zone2_volume_up', 'zone2 vol+', 'z2vol+', 'zone2_vol+']} label={'Z2 Vol +'} />
              <KeyBtn names={['zone2_vol_down', 'zone2voldown', 'z2_vol_down', 'zone2_volume_down', 'zone2 vol-', 'z2vol-', 'zone2_vol-']} label={'Z2 Vol −'} />
            </div>
          </div>
          <DPad />
          <AllButtonsToggle showAll={showAll} setShowAll={setShowAll} keys={keys} sendKey={sendKey} sending={sending} lang={lang} />
        </div>
      ) : (
        /* ---------- TV e STB/Vivo ---------- */
        <div style={{ display: 'grid', gap: 10 }}>
          <Row2>
            <KeyBtn names={['power', 'power_off', 'power_on', 'poweroff', 'poweron', 'onoff', 'on_off', 'standby']} label={'⏻ ' + t('power')} accent />
            <KeyBtn names={['mute', 'muting', 'silence', 'silent', 'vol_mute', 'volume_mute', 'sound_mute', 'quiet']} label={'🔇 Mute'} />
          </Row2>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('volume')}</div>
            <Row2>
              <KeyBtn names={['volume_up', 'vol+', 'vol_add', 'volumeup', 'vol_up', 'volup', 'v+']} label={'🔊 Vol +'} />
              <KeyBtn names={['volume_down', 'vol-', 'vol_sub', 'volumedown', 'vol_down', 'voldown', 'v-']} label={'🔉 Vol −'} />
            </Row2>
          </div>
          {kind === 'stb' && (
            <div>
              <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{lang === 'pt' ? 'Canais' : 'Channels'}</div>
              <Row2>
                <KeyBtn names={['channel_up', 'ch+', 'ch_add', 'channelup', 'ch_up', 'chup', 'prog+', 'program_up']} label={'CH +'} />
                <KeyBtn names={['channel_down', 'ch-', 'ch_sub', 'channeldown', 'ch_down', 'chdown', 'prog-', 'program_down']} label={'CH −'} />
              </Row2>
            </div>
          )}
          <DPad />
          {kind === 'stb' && <NumPad />}
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{lang === 'pt' ? 'Navegação' : 'Navigation'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <KeyBtn names={['menu', 'setting', 'settings']} label={'☰ Menu'} />
              <KeyBtn names={['home', 'smart', 'smart_hub']} label={'⌂ Home'} />
              <KeyBtn names={['back', 'return', 'exit', 'prev', 'previous', 'esc']} label={'↩ ' + t('back')} />
            </div>
          </div>
          <AllButtonsToggle showAll={showAll} setShowAll={setShowAll} keys={keys} sendKey={sendKey} sending={sending} lang={lang} />
        </div>
      )}
      <div style={{ fontSize: 10.5, color: C.text3, textAlign: 'center', lineHeight: 1.5, marginTop: 10 }}>{t('irNote')}</div>
    </Modal>
  );
}

function AllButtonsToggle({ showAll, setShowAll, keys, sendKey, sending, lang }) {
  return (
    <div>
      <button onClick={() => setShowAll((v) => !v)} style={{ ...card, padding: '10px', color: C.text2, cursor: 'pointer', fontSize: 12, border: 'none', width: '100%', display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>{showAll ? <ChevronLeft size={13} /> : <Plus size={13} />}{showAll ? (lang === 'pt' ? 'Ocultar todos os botões' : 'Hide all') : (lang === 'pt' ? 'Todos os botões do controle' : 'All remote buttons')}</button>
      {showAll && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 8 }}>
          {keys.map((k, i) => {
            const nm = k.key_name || k.key || ('k' + i);
            return <IRBtn key={i} onClick={() => sendKey(k)}>{sending === (k.key_id || k.key || k.key_name) ? '…' : nm}</IRBtn>;
          })}
        </div>
      )}
    </div>
  );
}

function tuyaSwitchCode(status) {
  const keys = Object.keys(status || {});
  // prioridade: switch_led (lâmpadas), switch_1 (tomadas), switch, qualquer switch*
  return keys.find((k) => k === 'switch_led') || keys.find((k) => k === 'switch_1') || keys.find((k) => k === 'switch') || keys.find((k) => k.startsWith('switch')) || null;
}
function TuyaACCard({ device, nome, irId, t, lang, onOpen, remote, onCloseRemote, Ic, lastState, onStateChange }) {
  const saved = lastState || {};
  const [temp, setTemp] = useState(saved.temp != null ? saved.temp : 23);
  const [power, setPower] = useState(!!saved.power);
  const [mode, setMode] = useState(saved.mode || 'cold');
  const [wind, setWind] = useState(saved.wind || 'auto');
  const [busy, setBusy] = useState(false);
  const sendAc = async (patch) => {
    const next = { power, temp, mode, wind, ...patch };
    setPower(next.power); setTemp(next.temp); setMode(next.mode); setWind(next.wind);
    onStateChange && onStateChange(next);
    setBusy(true);
    try {
      await authFetch('/api/tuya', { method: 'POST', body: JSON.stringify({ ir: 'ac', infrared_id: irId, remote_id: device.id, acCode: 'all', acValue: { power: next.power ? 1 : 0, mode: next.mode, temp: next.temp, wind: next.wind } }) });
    } catch (e) {}
    setBusy(false);
  };
  const onAcChange = (next) => { setPower(next.power); setTemp(next.temp); setMode(next.mode); setWind(next.wind); onStateChange && onStateChange(next); };
  const online = device.online;
  return (
    <>
      <div style={{ ...card, padding: 13, opacity: online ? 1 : 0.55 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: (power ? C.accent : C.surface2) + (power ? '22' : ''), display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={17} style={{ color: power ? C.accent : C.text3 }} /></div>
          <button onClick={() => online && sendAc({ power: !power })} disabled={!online} style={{ width: 42, height: 25, borderRadius: 999, border: 'none', background: power ? C.green : C.surface2, position: 'relative', cursor: online ? 'pointer' : 'not-allowed', transition: 'background .2s' }}>
            <span style={{ position: 'absolute', top: 3, left: power ? 20 : 3, width: 19, height: 19, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
          </button>
        </div>
        <div onClick={onOpen} style={{ fontSize: 13, fontWeight: 600, marginTop: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{nome}</div>
        {power ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <button onClick={() => sendAc({ temp: Math.max(16, temp - 1) })} disabled={busy} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>−</button>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>{temp}°</div>
            <button onClick={() => sendAc({ temp: Math.min(30, temp + 1) })} disabled={busy} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>＋</button>
          </div>
        ) : (
          <div onClick={onOpen} style={{ fontSize: 10.5, color: online ? C.text3 : C.rose, marginTop: 2, cursor: 'pointer' }}>{online ? t('openRemote') : t('offline')}</div>
        )}
      </div>
      {remote && <TuyaRemote device={device} kind="ac" label={nome} irId={irId} t={t} lang={lang} onClose={onCloseRemote} acState={{ power, temp, mode, wind }} onAcChange={onAcChange} />}
    </>
  );
}
function TuyaCard({ device, t, lang, onCmd, kind, label, irId, lastState, onStateChange }) {
  const [remote, setRemote] = useState(false); const [light, setLight] = useState(false);
  const irKind = kind === 'tv' || kind === 'stb' || kind === 'ac' || kind === 'receiver';
  const st = device.status || {};
  const sw = tuyaSwitchCode(st) || (kind === 'light' ? 'switch_led' : null);
  const on = sw && st[sw] != null ? !!st[sw] : (sw ? false : null);
  const bright = st.bright_value_v2 != null ? st.bright_value_v2 : st.bright_value;
  const temp = st.temp_current != null ? st.temp_current : (st.va_temperature != null ? st.va_temperature / 10 : null);
  const kindIcon = { light: Lightbulb, plug: Power, switch: Power, climate: Wind, ac: Wind, tv: Tv, stb: Tv, receiver: Radio };
  const Ic = kindIcon[kind] || Power;
  const nome = label || device.name;
  if (kind === 'ac') {
    return <TuyaACCard device={device} nome={nome} irId={irId} t={t} lang={lang} onOpen={() => setRemote(true)} remote={remote} onCloseRemote={() => setRemote(false)} Ic={Ic} lastState={lastState} onStateChange={onStateChange} />;
  }
  if (irKind) {
    return (
      <>
        <button onClick={() => device.online && setRemote(true)} disabled={!device.online} style={{ ...card, padding: 13, textAlign: 'left', cursor: device.online ? 'pointer' : 'not-allowed', opacity: device.online ? 1 : 0.55, border: 'none', width: '100%', color: C.text }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={17} style={{ color: C.accent }} /></div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</div>
          <div style={{ fontSize: 10.5, color: device.online ? C.text3 : C.rose, marginTop: 2 }}>{device.online ? t('openRemote') : t('offline')}</div>
        </button>
        {remote && <TuyaRemote device={device} kind={kind} label={nome} irId={irId} t={t} lang={lang} onClose={() => setRemote(false)} />}
      </>
    );
  }
  return (
    <div style={{ ...card, padding: 13, opacity: device.online ? 1 : 0.55 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: (on ? C.accent : C.surface2) + (on ? '22' : ''), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Ic size={17} style={{ color: on ? C.accent : C.text3 }} />
        </div>
        {sw && (
          <button onClick={() => device.online && onCmd(device.id, sw, !on)} disabled={!device.online}
            style={{ width: 42, height: 25, borderRadius: 999, border: 'none', background: on ? C.green : C.surface2, position: 'relative', cursor: device.online ? 'pointer' : 'not-allowed', transition: 'background .2s' }}>
            <span style={{ position: 'absolute', top: 3, left: on ? 20 : 3, width: 19, height: 19, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 10.5, color: device.online ? C.text3 : C.rose, marginTop: 2 }}>
          {device.online ? (sw ? (on ? t('on') : t('off')) : (temp != null ? temp + '°' : '—')) : t('offline')}
          {bright != null && device.online ? ` · ${Math.round((bright / 1000) * 100)}%` : ''}
        </div>
        {kind === 'light' && device.online && on && <button onClick={() => setLight(true)} style={{ background: C.accentSoft, border: 'none', color: C.accent, cursor: 'pointer', padding: '3px 9px', borderRadius: 999, display: 'flex', gap: 4, alignItems: 'center', fontSize: 10.5, fontWeight: 600 }}><Sparkles size={12} />{lang === 'pt' ? 'Cores' : 'Colors'}</button>}
      </div>
      {kind === 'light' && light && <TuyaLight device={device} label={nome} t={t} onCmd={onCmd} onClose={() => setLight(false)} />}
    </div>
  );
}

/* ---------------- House dashboard ---------------- */
function DeviceCard({ device, onChange }) {
  const on = device.on;
  const Ic = device.type === 'light' ? Lightbulb : device.type === 'fan' ? Wind : Snowflake;
  return (
    <div style={{ ...card, padding: 14, opacity: on ? 1 : 0.85, borderColor: on ? C.accent + '44' : C.borderSoft }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: on && device.type !== 'light' ? 10 : 0 }}>
        <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: on ? C.accentSoft : C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={17} style={{ color: on ? C.accent : C.text3 }} /></div>
          <div><div style={{ fontSize: 13.5, fontWeight: 600 }}>{device.name}</div><div style={{ fontSize: 10.5, color: C.text3 }}>{on ? (device.type === 'ac' ? device.temp + '°C' : device.type === 'fan' ? 'Vel ' + device.fan : 'On') : 'Off'}</div></div>
        </div>
        <button onClick={() => onChange({ ...device, on: !on })} style={{ width: 42, height: 24, borderRadius: 999, background: on ? C.accent : C.surface2, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background .15s' }}>
          <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 20, height: 20, borderRadius: 999, background: on ? '#FFFFFF' : C.text3, transition: 'left .15s' }} />
        </button>
      </div>
      {on && device.type === 'ac' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <button onClick={() => onChange({ ...device, temp: Math.max(16, device.temp - 1) })} style={{ ...card, padding: '4px 12px', color: C.text, cursor: 'pointer', fontSize: 16 }}>−</button>
          <span style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 700 }}>{device.temp}°C</span>
          <button onClick={() => onChange({ ...device, temp: Math.min(30, device.temp + 1) })} style={{ ...card, padding: '4px 12px', color: C.text, cursor: 'pointer', fontSize: 16 }}>+</button>
        </div>
      )}
      {on && device.type !== 'light' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>{[1, 2, 3].map((s) => <button key={s} onClick={() => onChange({ ...device, fan: s })} style={{ flex: 1, padding: '5px 0', borderRadius: 8, fontSize: 11.5, cursor: 'pointer', background: device.fan === s ? C.accentSoft : 'transparent', color: device.fan === s ? C.accent : C.text3, border: `1px solid ${device.fan === s ? C.accent + '55' : C.border}` }}>{s === 1 ? 'Baixa' : s === 2 ? 'Média' : 'Alta'}</button>)}</div>
      )}
    </div>
  );
}
function HouseEmailReviewCard({ x, lang, t, people = [], onTask, onEvent, onIgnore }) {
  const c = x.classification || {};
  const [asEvent, setAsEvent] = useState(false);
  const [date, setDate] = useState(c.date || todayISO());
  const [time, setTime] = useState(c.time || '');
  const defaultPerson = people.find((p) => /carol/i.test(p.title || '')) || null;
  const [personIds, setPersonIds] = useState(defaultPerson ? [defaultPerson.id] : []);
  const togglePerson = (id) => setPersonIds((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  const inputStyle = { background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '6px 8px', fontSize: 12.5 };
  return (
    <div style={{ ...card, padding: 13, marginBottom: 8, borderColor: C.accent + '33' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Mail size={16} style={{ color: C.accent, marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{c.title || x.zText}</div>
          {c.notes && <div style={{ fontSize: 12, color: C.text2, marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
          {c.why && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>{c.why}</div>}
          <div style={{ fontSize: 10.5, color: C.text3, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✉ {x.subject}</div>
        </div>
      </div>
      {asEvent ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} />
          </div>
          {people.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: C.text3, marginBottom: 6 }}>{lang === 'pt' ? 'Convidar (envia convite de verdade por e-mail, pode escolher mais de uma pessoa)' : 'Invite (sends a real calendar invite by email, pick more than one if you like)'}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {people.slice(0, 8).map((p) => <Chip key={p.id} active={personIds.includes(p.id)} onClick={() => togglePerson(p.id)}>{p.title}</Chip>)}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn kind="solid" onClick={() => onEvent(x, date, time || null, personIds)} style={{ padding: '7px 12px', fontSize: 12 }}>{t('save')}</Btn>
            <Btn kind="soft" onClick={() => setAsEvent(false)} style={{ padding: '7px 12px', fontSize: 12 }}>{t('cancel')}</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Btn kind="soft" onClick={() => onTask(x)} style={{ padding: '7px 12px', fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}><Wrench size={12} />{t('itIsTask')}</Btn>
          <Btn kind="soft" onClick={() => setAsEvent(true)} style={{ padding: '7px 12px', fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}><CalendarDays size={12} />{t('itIsEvent')}</Btn>
          <Btn kind="soft" onClick={() => onIgnore(x)} style={{ padding: '7px 12px', fontSize: 12 }}>{t('ignoreEmail')}</Btn>
        </div>
      )}
    </div>
  );
}
function HouseScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, addItems, updateItem, delItem, flash, devices, setDevices, tuyaPrefs, setTuyaPrefs, setPendingCount }) {
  const [adding, setAdding] = useState(false); const [filterAll, setFilterAll] = useState(false);
  const [zScan, setZScan] = useState({ loading: false, pending: [] });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const runZScan = () => {
    setZScan((p) => ({ ...p, loading: true }));
    scanHouseEmails({ addItems, flash, t, lang, items: itemsRef.current }).then((res) => setZScan({ loading: false, pending: res.pending }));
  };
  useEffect(() => { if (setPendingCount) setPendingCount('house', (zScan.pending || []).length); }, [zScan.pending]);
  const scannedOnMount = useRef(false);
  useEffect(() => {
    if (scannedOnMount.current) return;
    scannedOnMount.current = true;
    const removed = dedupeHouseItems(itemsRef.current, delItem);
    if (removed) flash(lang === 'pt' ? `${removed} item(ns) duplicado(s) da casa removido(s).` : `${removed} duplicate house item(s) removed.`);
    runZScan();
  }, []);
  const resolveAsTask = (x) => {
    addItem(houseItemFromClassification({ ...x, classification: { ...x.classification, kind: 'task' } }));
    markHouseEmailProcessed(x);
    setZScan((p) => ({ ...p, pending: p.pending.filter((y) => y.id !== x.id) }));
    flash(t('savedOne'));
  };
  const resolveAsEvent = (x, date, time, personIds) => {
    const item = houseItemFromClassification({ ...x, classification: { ...x.classification, kind: 'event', date, time } });
    // addItem já dispara o convite de verdade sozinho quando meta.inviteePersonIds vem preenchido
    addItem({ ...item, meta: { ...item.meta, inviteePersonIds: personIds && personIds.length ? personIds : undefined } });
    markHouseEmailProcessed(x);
    setZScan((p) => ({ ...p, pending: p.pending.filter((y) => y.id !== x.id) }));
    flash(t('savedOne'));
  };
  const ignoreEmail = (x) => {
    markHouseEmailProcessed(x);
    setZScan((p) => ({ ...p, pending: p.pending.filter((y) => y.id !== x.id) }));
  };
  const houseEvents = items.filter((i) => i.type === 'event' && i.meta && i.meta.houseEmail && i.status !== 'done' && (!i.date || i.date >= todayISO())).sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
  const [tuya, setTuya] = useState({ loading: true, configured: false, connected: false, devices: [], error: null }); const [cfgDev, setCfgDev] = useState(false);
  const loadTuya = () => {
    setTuya((p) => ({ ...p, loading: true }));
    authFetch('/api/tuya').then((r) => r.json())
      .then((j) => {
        setTuya({ loading: false, configured: !!j.configured, connected: !!j.connected, devices: j.devices || [], error: j.error || null });
        // aplica apelidos/comodos conhecidos uma unica vez
        if (j.devices && j.devices.length) {
          setTuyaPrefs((prev) => {
            const next = { ...prev }; let changed = false;
            // remove preferência órfã do abajur antigo (dispositivo removido do SmartLife)
            if (next['ebd25cb250d51d988bfmgd']) { delete next['ebd25cb250d51d988bfmgd']; changed = true; }
            j.devices.forEach((d) => {
              const seed = TUYA_SEED[d.id];
              if (!next[d.id] && seed) { next[d.id] = seed; changed = true; }
              else if (next[d.id] && seed) {
                // completa campos que faltam nas prefs antigas (ex.: hub IR e kind), sem apagar apelido/cômodo do usuário
                if (seed.ir && !next[d.id].ir) { next[d.id] = { ...next[d.id], ir: seed.ir }; changed = true; }
                if (seed.kind && (!next[d.id].kind || next[d.id].kind === 'auto')) { next[d.id] = { ...next[d.id], kind: seed.kind }; changed = true; }
                // correção específica: Abajur Carol foi salvo como 'light' mas é interruptor (switch_1)
              }
            });
            return changed ? next : prev;
          });
        }
      })
      .catch((e) => setTuya({ loading: false, configured: false, connected: false, devices: [], error: String(e) }));
  };
  const [lg, setLg] = useState({ loading: true, configured: false, devices: [], host: null });
  const loadLg = () => {
    setLg((p) => ({ ...p, loading: true }));
    authFetch('/api/lg').then((r) => r.json())
      .then((j) => setLg({ loading: false, configured: !!j.configured, connected: !!j.connected, devices: j.devices || [], host: j.host || null, error: j.error }))
      .catch((e) => setLg({ loading: false, configured: false, devices: [], error: String(e) }));
  };
  useEffect(() => { loadTuya(); loadLg(); }, []);
  const sendCmd = async (deviceId, code, value) => {
    // otimista
    setTuya((p) => ({ ...p, devices: p.devices.map((d) => d.id === deviceId ? { ...d, status: { ...d.status, [code]: value } } : d) }));
    try {
      const r = await authFetch('/api/tuya', { method: 'POST', body: JSON.stringify({ deviceId, code, value }) });
      const j = await r.json();
      if (!j.ok) { flash(j.error || 'Erro'); loadTuya(); }
    } catch (e) { flash(String(e)); loadTuya(); }
  };
  const month = todayISO().slice(0, 7);
  const houseItems = items.filter((i) => i.domain === 'home');
  const tasks = houseItems.filter((i) => i.type === 'task' && i.status !== 'done');
  const exps = houseItems.filter((i) => i.type === 'expense' && i.amount);
  const cost = exps.filter((i) => filterAll || (i.date || '').startsWith(month)).reduce((a, b) => a + b.amount, 0);
  const staffMsgs = items.filter((i) => i.type === 'message' && i.meta && /staff|equipe|casa|caseir|dom[eé]stic/i.test(i.meta.sender || i.notes || ''));
  const upd = (d) => setDevices((list) => list.map((x) => (x.id === d.id ? d : x)));
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <SectionTitle icon={Power} label={t('devices')} color={C.accent} />
        {(tuya.configured || lg.configured) && <button onClick={() => setCfgDev(true)} style={{ ...card, padding: '6px 11px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center', fontSize: 11.5 }}><Cog size={12} />{t('choose')}</button>}
      </div>

      {/* LG ThinQ primeiro */}
      {lg.configured && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, color: C.text2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>LG ThinQ</span>
            <button onClick={loadLg} style={{ ...card, padding: '5px 9px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>{lg.loading ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}</button>
          </div>
          {lg.error && <HintCard icon={AlertTriangle} text={'LG: ' + lg.error} />}
          {(() => {
            const vis = lg.devices.filter((d) => { const p = tuyaPrefs['lg_' + d.id]; return p ? p.show !== false : true; });
            if (!vis.length) return lg.loading ? <div style={{ ...card, padding: 18, textAlign: 'center', color: C.text3, fontSize: 12.5, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}><Loader2 size={13} className="spin" />…</div> : <div style={{ ...card, padding: 14, textAlign: 'center', color: C.text3, fontSize: 12 }}>{lang === 'pt' ? 'Nenhum aparelho LG selecionado.' : 'No LG devices selected.'}</div>;
            return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{vis.map((d) => <LgCard key={d.id} device={d} host={lg.host} label={(tuyaPrefs['lg_' + d.id] && tuyaPrefs['lg_' + d.id].alias) || d.name} t={t} lang={lang} flash={flash}
              lastState={(tuyaPrefs['lg_' + d.id] && tuyaPrefs['lg_' + d.id].lastState) || null}
              onStateChange={(next) => setTuyaPrefs((prev) => ({ ...prev, ['lg_' + d.id]: { ...(prev['lg_' + d.id] || {}), lastState: { ...next, ts: Date.now() } } }))} />)}</div>;
          })()}
        </div>
      )}

      {/* Tuya / SmartLife depois */}
      {tuya.configured && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, color: C.text2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>SmartLife</span>
            <button onClick={loadTuya} style={{ ...card, padding: '5px 9px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>{tuya.loading ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}</button>
          </div>
          {tuya.error && <HintCard icon={AlertTriangle} text={'SmartLife: ' + tuya.error} />}
          {tuya.loading && !tuya.devices.length ? (
            <div style={{ ...card, padding: 20, marginBottom: 10, textAlign: 'center', color: C.text3, fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Loader2 size={14} className="spin" />SmartLife…</div>
          ) : tuya.connected && tuya.devices.length ? (
            <TuyaDeviceGrid devices={tuya.devices} prefs={tuyaPrefs} setPrefs={setTuyaPrefs} t={t} lang={lang} onCmd={sendCmd} onConfig={() => setCfgDev(true)} />
          ) : (
            <HintCard icon={Power} text={lang === 'pt' ? 'Nenhum aparelho SmartLife encontrado.' : 'No SmartLife devices found.'} />
          )}
        </div>
      )}

      {!tuya.configured && !lg.configured && (
        <><HintCard icon={Power} text={t('deviceHint')} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{devices.map((d) => <DeviceCard key={d.id} device={d} onChange={upd} />)}</div></>
      )}

      <SectionTitle icon={Wallet} label={t('houseCosts')} color={C.green} />
      <div style={{ ...card, padding: 16, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>{fmtMoney(cost, lang)}</div><div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{filterAll ? t('allTime') : t('thisMonth')}</div></div>
        <div style={{ display: 'flex', gap: 6 }}><Chip active={!filterAll} onClick={() => setFilterAll(false)}>{t('thisMonth')}</Chip><Chip active={filterAll} onClick={() => setFilterAll(true)}>{t('allTime')}</Chip></div>
      </div>
      <SectionTitle icon={ListTodo} label={t('houseTasks')} color={C.blue} />
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('quickAdd')}</Btn>
      {tasks.length === 0 ? <Empty icon={Home} text={t('nothingHere')} /> : tasks.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} onDelete={delItem} />)}
      {houseEvents.length > 0 && <>
        <SectionTitle icon={CalendarDays} label={t('upcomingHouseEvents')} color={C.violet} />
        {houseEvents.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      </>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, marginTop: 4 }}>
        <SectionTitle icon={Mail} label={t('houseEmails')} color={C.accent} />
        <button onClick={runZScan} disabled={zScan.loading} style={{ ...card, padding: '6px 11px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center', fontSize: 11.5 }}>{zScan.loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{zScan.loading ? t('checkingHouseEmails') : t('checkHouseEmails')}</button>
      </div>
      {zScan.pending.length > 0 ? (
        <>
          <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8 }}>{t('houseEmailsNeedsReview')}</div>
          {zScan.pending.map((x) => <HouseEmailReviewCard key={x.id} x={x} lang={lang} t={t} people={people} onTask={resolveAsTask} onEvent={resolveAsEvent} onIgnore={ignoreEmail} />)}
        </>
      ) : !zScan.loading && <Empty icon={Mail} text={t('noHouseEmails')} />}
      <SectionTitle icon={Users} label={t('staff')} color={C.sky} />
      {staffMsgs.length === 0 ? <Empty icon={Users} text={t('nothingHere')} /> : staffMsgs.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      {adding && <AddModal title={`${t('quickAdd')} · ${t('house')}`} icon={Plus} draft={{ type: 'task', domain: 'home' }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: 'home', ...x }); flash(t('savedOne')); setAdding(false); }} />}
      {cfgDev && <TuyaConfig
        devices={[...lg.devices.map((d) => ({ id: 'lg_' + d.id, name: d.name, category: d.type, brand: 'LG' })), ...tuya.devices.map((d) => ({ ...d, brand: 'SmartLife' }))]}
        prefs={tuyaPrefs} setPrefs={setTuyaPrefs} lang={lang} t={t} onClose={() => setCfgDev(false)} />}
    </div>
  );
}

/* ---------------- People + Person/Kid detail ---------------- */
function initials(name) { return (name || '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
function PersonDetail({ person, items, people, lang, t, back, backLabel, onOpen, toggleTask, addItem, updateItem, delItem, flash, kid }) {
  const [editing, setEditing] = useState(false); const [adding, setAdding] = useState(null);
  const linked = items.filter((i) => i.id !== person.id && ((i.meta && i.meta.personId === person.id) || (i.person && i.person.toLowerCase() === person.title.toLowerCase())));
  const spent = linked.filter((i) => isMoney(i.type) && i.amount).reduce((a, b) => a + b.amount, 0);
  const docs = linked.filter((i) => i.type === 'document');
  const school = linked.filter((i) => ['task', 'event'].includes(i.type));
  const healthL = linked.filter((i) => ['appointment', 'med'].includes(i.type));
  const giftsL = linked.filter((i) => ['gift', 'shopping'].includes(i.type));
  const events = linked.filter((i) => i.date && ['event', 'appointment', 'trip'].includes(i.type) && i.date >= todayISO());
  const Section = ({ icon, label, color, list }) => list.length ? <><SectionTitle icon={icon} label={label} color={color} />{list.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</> : null;
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{backLabel}</button>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14 }}>
        <Avatar photo={person.meta && person.meta.photo} name={person.title} size={56} color={kid ? C.violet : C.sky} />
        <div style={{ flex: 1 }}><div style={{ fontSize: 20, fontWeight: 600 }}>{person.title}</div><div style={{ fontSize: 13, color: C.text3 }}>{[person.meta && person.meta.relationship, person.meta && person.meta.role].filter(Boolean).join(' · ')}</div></div>
        <button onClick={() => setEditing(true)} style={{ ...card, padding: 8, color: C.text2, cursor: 'pointer' }}><Cog size={15} /></button>
      </div>
      {kid ? (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
            <MiniStat label={t('open')} value={school.filter((x) => x.type === 'task' && x.status !== 'done').length} color={C.accent} onClick={() => { const el = document.getElementById('sec-school'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
            <MiniStat label={t('gifts')} value={giftsL.length} color={C.violet} onClick={() => { const el = document.getElementById('sec-gifts'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
            <MiniStat label={t('documents')} value={docs.length} color={C.blue} onClick={() => { const el = document.getElementById('sec-docs'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
          </div>
          <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
            <Btn kind="soft" onClick={() => setAdding('task')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><GraduationCap size={14} />{t('school')}</Btn>
            <Btn kind="soft" onClick={() => setAdding('gift')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Gift size={14} />{t('gifts')}</Btn>
            <Btn kind="soft" onClick={() => setAdding('document')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Syringe size={14} />{t('healthDocs')}</Btn>
          </div>
          <div id="sec-school"><Section icon={GraduationCap} label={t('school')} color={C.accent} list={school} /></div>
          <div id="sec-health"><Section icon={Heart} label={t('health')} color={C.rose} list={healthL} /></div>
          <div id="sec-gifts"><Section icon={Gift} label={t('gifts')} color={C.violet} list={giftsL} /></div>
          <div id="sec-docs"><Section icon={FileText} label={t('documents')} color={C.blue} list={docs} /></div>
        </>
      ) : (
        <>
          <SectionTitle icon={UserRound} label={t('contact')} color={C.sky} />
          <div style={{ ...card, overflow: 'hidden' }}>
            {(() => {
              const rows = [];
              const phones = (person.meta && (person.meta.phones || (person.meta.phone ? [person.meta.phone] : []))) || [];
              const emails = (person.meta && (person.meta.emails || (person.meta.email ? [person.meta.email] : []))) || [];
              phones.filter(Boolean).forEach((v, i) => rows.push(['phone_' + i, Phone, 'tel:', C.green, v]));
              emails.filter(Boolean).forEach((v, i) => rows.push(['email_' + i, Mail, 'mailto:', C.blue, v]));
              [['company', Building2, null, C.text3], ['address', MapPin, null, C.text3]].forEach(([k, Icn, href, col]) => { const v = person.meta && person.meta[k]; if (v) rows.push([k, Icn, href, col, v + (k === 'address' && person.meta.addressComplement ? ' · ' + person.meta.addressComplement : '')]); });
              const rel = person.meta && person.meta.relationship; if (rel) rows.push(['relationship', Heart, null, C.rose, rel]);
              return rows.map(([k, Icn, href, col, val], idx) => {
                const inner = <div style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '11px 13px' }}><Icn size={15} style={{ color: col, flexShrink: 0 }} /><span style={{ fontSize: 13.5 }}>{val}</span></div>;
                return href ? <a key={k} href={href + val} style={{ textDecoration: 'none', color: C.text, display: 'block', borderTop: idx ? `1px solid ${C.borderSoft}` : 'none' }}>{inner}</a> : <div key={k} style={{ borderTop: idx ? `1px solid ${C.borderSoft}` : 'none' }}>{inner}</div>;
              });
            })()}
            {person.meta && person.meta.birthdate && <div style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '11px 13px', borderTop: `1px solid ${C.borderSoft}` }}><CalIcon size={15} style={{ color: C.text3 }} /><span style={{ fontSize: 13.5 }}>{fmtDate(person.meta.birthdate, lang)}</span></div>}
          </div>
          {person.notes && <div style={{ ...card, padding: 14, marginTop: 10, fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{person.notes}</div>}
          <SectionTitle icon={FileText} label={t('documents')} color={C.blue} />
          {person.meta && person.meta.attachments && person.meta.attachments.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: docs.length ? 10 : 0 }}>{person.meta.attachments.map((a) => <AttachThumb key={a.id} att={a} />)}</div>}
          {docs.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
          {!(person.meta && person.meta.attachments && person.meta.attachments.length) && docs.length === 0 && <Empty icon={FileText} text={t('nothingHere')} />}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Btn kind="soft" onClick={() => setAdding('document')} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={14} />{t('addDoc')}</Btn>
            <Btn kind="soft" onClick={() => setEditing(true)} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Pencil size={14} />{t('edit')}</Btn>
          </div>
        </>
      )}
      {editing && <Modal onClose={() => setEditing(false)}><SheetHead title={person.title} onClose={() => setEditing(false)} icon={UserRound} /><ItemForm draft={person} allowedTypes={['person']} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { if (confirm(t('deleteContactConfirm'))) { delItem(person.id); setEditing(false); back(); } }} onSave={(x) => { updateItem(person.id, x); setEditing(false); }} /></Modal>}
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: kid ? 'kids' : 'docs', person: person.title, meta: { personId: person.id } }} allowedTypes={[adding]} lang={lang} t={t} people={people} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: kid ? 'kids' : 'docs', ...x, person: person.title, meta: { ...x.meta, personId: person.id } }); flash(t('savedOne')); setAdding(null); }} />}
    </div>
  );
}
function PeopleScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, updateItem, delItem, flash }) {
  const [adding, setAdding] = useState(false); const [sel, setSel] = useState(null); const [drill, setDrill] = useState(null);
  const persons = items.filter((i) => i.type === 'person').sort((a, b) => a.title.localeCompare(b.title));
  const current = sel && items.find((i) => i.id === sel);
  if (drill) return (
    <div>
      <ModuleHeader module={module} t={t} back={() => setDrill(null)} />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>{drill.title} · {drill.list.length}</div>
      {drill.list.length === 0 ? <Empty icon={Sparkles} text={t('nothingHere')} /> : drill.list.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onOpen={onOpen} toggleTask={toggleTask} />)}
    </div>
  );
  if (current) return <PersonDetail person={current} items={items} people={people} lang={lang} t={t} back={() => setSel(null)} backLabel={t('people')} onOpen={onOpen} toggleTask={toggleTask} addItem={addItem} updateItem={updateItem} delItem={delItem} flash={flash} />;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('t_person')}</Btn>
      {persons.length === 0 ? <Empty icon={UserRound} text={t('nothingHere')} /> : persons.map((p) => (
        <div key={p.id} onClick={() => setSel(p.id)} style={{ ...card, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
          <Avatar photo={p.meta && p.meta.photo} name={p.title} size={42} color={C.sky} />
          <div style={{ flex: 1 }}><div style={{ fontSize: 14.5, fontWeight: 600 }}>{p.title}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>{[p.meta && p.meta.relationship, p.meta && p.meta.role].filter(Boolean).join(' · ')}</div></div>
          <ChevronRight size={16} style={{ color: C.text3 }} />
        </div>
      ))}
      {adding && <AddModal title={t('t_person')} icon={UserRound} draft={{ type: 'person', domain: 'personal', meta: {} }} allowedTypes={['person']} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem(x); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}
function KidsScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, updateItem, delItem, flash }) {
  const [sel, setSel] = useState(null);
  const [drill, setDrill] = useState(null); // {title, list}
  const kids = items.filter((i) => i.type === 'person' && isKid(i)).sort((a, b) => a.title.localeCompare(b.title));
  const current = sel && items.find((i) => i.id === sel);
  const linkedOf = (p) => items.filter((i) => i.id !== p.id && ((i.meta && i.meta.personId === p.id) || (i.person && i.person.toLowerCase() === p.title.toLowerCase())));
  let sumOpen = 0, sumEv = 0, sumGift = 0, sumSpent = 0;
  kids.forEach((p) => { const l = linkedOf(p); sumOpen += l.filter((i) => i.type === 'task' && i.status !== 'done').length; sumEv += l.filter((i) => i.date && ['event', 'appointment'].includes(i.type) && i.date >= todayISO()).length; sumGift += l.filter((i) => ['gift', 'shopping'].includes(i.type)).length; sumSpent += l.filter((i) => isMoney(i.type) && i.amount).reduce((a, b) => a + b.amount, 0); });
  if (drill) return (
    <div>
      <ModuleHeader module={module} t={t} back={() => setDrill(null)} />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>{drill.title} · {drill.list.length}</div>
      {drill.list.length === 0 ? <Empty icon={Sparkles} text={t('nothingHere')} /> : drill.list.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onOpen={onOpen} toggleTask={toggleTask} />)}
    </div>
  );
  if (current) return <PersonDetail person={current} items={items} people={people} lang={lang} t={t} kid back={() => setSel(null)} backLabel={t('kids')} onOpen={onOpen} toggleTask={toggleTask} addItem={addItem} updateItem={updateItem} delItem={delItem} flash={flash} />;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {kids.length > 0 && (
        <div style={{ ...card, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: 'flex', gap: 7, alignItems: 'center' }}><Users size={15} style={{ color: C.violet }} />{t('myKids')} · {kids.length}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <MiniStat label={t('open')} value={sumOpen} color={C.accent} onClick={() => setDrill({ title: t('open'), list: kids.flatMap(linkedOf).filter((i) => i.type === 'task' && i.status !== 'done') })} />
            <MiniStat label={t('agenda')} value={sumEv} color={C.blue} onClick={() => setDrill({ title: t('agenda'), list: kids.flatMap(linkedOf).filter((i) => i.date && ['event', 'appointment'].includes(i.type) && i.date >= todayISO()) })} />
            <MiniStat label={t('gifts')} value={sumGift} color={C.violet} onClick={() => setDrill({ title: t('gifts'), list: kids.flatMap(linkedOf).filter((i) => ['gift', 'shopping'].includes(i.type)) })} />
            <MiniStat label={t('spent')} value={fmtMoney(sumSpent, lang)} color={C.green} small onClick={() => setDrill({ title: t('spent'), list: kids.flatMap(linkedOf).filter((i) => isMoney(i.type) && i.amount) })} />
          </div>
        </div>
      )}
      {kids.length === 0 ? <><HintCard icon={Users} text={t('markKidHint')} /><Empty icon={Users} text={t('nothingHere')} /></> : kids.map((p) => {
        const linked = items.filter((i) => i.id !== p.id && ((i.meta && i.meta.personId === p.id) || (i.person && i.person.toLowerCase() === p.title.toLowerCase())));
        const open = linked.filter((i) => i.type === 'task' && i.status !== 'done').length;
        return (
          <div key={p.id} onClick={() => setSel(p.id)} style={{ ...card, padding: 14, marginBottom: 10, display: 'flex', gap: 14, alignItems: 'center', cursor: 'pointer' }}>
            <Avatar photo={p.meta && p.meta.photo} name={p.title} size={48} color={C.violet} />
            <div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 600 }}>{p.title}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>{linked.length} {t('items')}{open ? ` · ${open} ${t('open').toLowerCase()}` : ''}</div></div>
            <ChevronRight size={16} style={{ color: C.text3 }} />
          </div>
        );
      })}
      {kids.length > 0 && (() => {
        const allLinked = kids.flatMap((p) => items.filter((i) => i.id !== p.id && ((i.meta && i.meta.personId === p.id) || (i.person && i.person.toLowerCase() === p.title.toLowerCase()))));
        return (
          <div style={{ marginTop: 8 }}>
            <SectionTitle icon={CalendarDays} label={lang === 'pt' ? 'Agenda dos filhos' : "Kids' calendar"} color={C.violet} />
            <MiniCalendar items={allLinked} lang={lang} t={t} toggleTask={toggleTask} onOpen={onOpen} />
          </div>
        );
      })()}
    </div>
  );
}

/* ---------------- Travel ---------------- */
function ModuleErrorCard({ t, back, module, msg }) {
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ ...card, padding: 22, textAlign: 'center' }}>
        <AlertTriangle size={26} style={{ color: C.accent, marginBottom: 10 }} />
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{t('screenError')}</div>
        <div style={{ fontSize: 12.5, color: C.text3, lineHeight: 1.5 }}>{t('screenErrorHint')}</div>
        {msg && <div style={{ ...card, marginTop: 12, padding: 10, fontSize: 11, color: C.rose, fontFamily: 'monospace', wordBreak: 'break-word', textAlign: 'left' }}>{String((msg && msg.message) || msg)}</div>}
        {msg && msg._componentStack && <div style={{ ...card, marginTop: 8, padding: 10, fontSize: 9.5, color: C.text3, fontFamily: 'monospace', wordBreak: 'break-word', textAlign: 'left', lineHeight: 1.5 }}>{msg._componentStack}</div>}
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    // guarda o "componentStack" (qual componente exatamente quebrou) pra facilitar diagnóstico futuro
    this.setState({ info: info && info.componentStack });
    console.error('[ErrorBoundary]', err, info && info.componentStack);
  }
  render() {
    if (this.state.err) {
      const fb = this.props.fallback;
      const enriched = this.state.err;
      if (enriched && this.state.info) {
        try { enriched._componentStack = String(this.state.info).trim().split('\n').slice(0, 3).join(' ← '); } catch (e) {}
      }
      if (typeof fb === 'function') { try { return fb(enriched); } catch (e) { return null; } }
      return fb || null;
    }
    return this.props.children;
  }
}

function FlightRow({ f, lang, t, onOpen }) {
  const m = f.meta || {};
  const route = (m.from || '?') + ' → ' + (m.to || '?');
  return (
    <button onClick={() => onOpen && onOpen(f)} style={{ ...card, padding: '12px 14px', marginBottom: 8, width: '100%', textAlign: 'left', cursor: 'pointer', color: C.text, border: `1px solid ${C.borderSoft}`, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: C.accent + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ticket size={16} style={{ color: C.accent }} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{route}</div>
        <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>
          {[m.airline, m.flightNumber, f.date ? fmtDate(f.date, lang) : null].filter(Boolean).join(' · ') || t('t_flight')}
        </div>
      </div>
      {m.needsCorrelation && <span title={lang === 'pt' ? 'Sem viagem vinculada' : 'No linked trip'} style={{ fontSize: 9.5, color: C.accent, border: `1px solid ${C.accent}44`, borderRadius: 999, padding: '2px 7px', flexShrink: 0 }}>{lang === 'pt' ? 'vincular' : 'link'}</span>}
      {m.locator && <span style={{ fontSize: 10.5, color: C.text3, fontFamily: 'monospace' }}>{m.locator}</span>}
    </button>
  );
}

// Silhuetas simplificadas dos continentes na projecao equiretangular (viewBox 360x180).
// x = (lon+180)/2 ; y = (90-lat). Formas aproximadas, so para dar contexto geografico.
function FlightMap({ flights, lang, t }) {
  const mapRef = useRef(null); const elRef = useRef(null);
  const [failed, setFailed] = useState(false);

  // coleta rotas e cidades a partir dos voos
  const pts = {}; const routes = [];
  (flights || []).forEach((f) => {
    const a = ((f && f.meta && f.meta.from) || '').toUpperCase();
    const b = ((f && f.meta && f.meta.to) || '').toUpperCase();
    if (AIRPORTS[a] && AIRPORTS[b]) { pts[a] = AIRPORTS[a]; pts[b] = AIRPORTS[b]; routes.push([a, b]); }
  });
  const keys = Object.keys(pts);

  useEffect(() => {
    if (keys.length === 0) return;
    let tries = 0;
    const init = () => {
      const L = typeof window !== 'undefined' && window.L;
      if (!L) { tries++; if (tries > 40) { setFailed(true); return; } setTimeout(init, 150); return; }
      if (!elRef.current || mapRef.current) return;
      try {
        const map = L.map(elRef.current, { attributionControl: false, zoomControl: true, scrollWheelZoom: false });
        mapRef.current = map;
        // tiles escuros (CARTO dark) — gratis, sem chave
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
        const latlngs = keys.map((k) => [pts[k][1], pts[k][0]]);
        // marcadores (pins) das cidades/aeroportos
        keys.forEach((k) => {
          const m = L.circleMarker([pts[k][1], pts[k][0]], { radius: 5, color: '#F59E0B', weight: 2, fillColor: '#F59E0B', fillOpacity: 1 }).addTo(map);
          m.bindTooltip(k, { permanent: true, direction: 'top', className: 'lcc-tip', offset: [0, -6] });
        });
        // linhas das rotas
        routes.forEach(([a, b]) => {
          L.polyline([[pts[a][1], pts[a][0]], [pts[b][1], pts[b][0]]], { color: '#F59E0B', weight: 2, opacity: 0.85 }).addTo(map);
        });
        // enquadrar
        const bounds = L.latLngBounds(latlngs);
        map.fitBounds(bounds.pad(0.35));
        setTimeout(() => map.invalidateSize(), 200);
      } catch (e) { setFailed(true); }
    };
    init();
    return () => { if (mapRef.current) { try { mapRef.current.remove(); } catch (e) {} mapRef.current = null; } };
  }, [flights]);

  if (keys.length === 0) {
    return <div style={{ ...card, padding: 20, marginBottom: 12, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{t('nothingHere')}</div>;
  }
  if (failed) {
    return <div style={{ ...card, padding: 18, marginBottom: 12, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{lang === 'pt' ? 'Mapa indisponível (sem conexão). Suas rotas: ' : 'Map unavailable. Routes: '}{routes.map(([a, b]) => a + '→' + b).join(', ')}</div>;
  }
  return (
    <div style={{ ...card, padding: 0, marginBottom: 10, overflow: 'hidden' }}>
      <div ref={elRef} style={{ width: '100%', height: 230, background: '#0b1018' }} />
    </div>
  );
}

function TripDetail({ trip, items, people, lang, t, back, onOpen, toggleTask, addItem, updateItem, delItem, flash }) {
  const [editing, setEditing] = useState(false); const [adding, setAdding] = useState(null);
  const mt = trip.meta || {}; const today = todayISO();
  const inRange = (d) => d && (mt.endDate ? (d >= trip.date && d <= mt.endDate) : d === trip.date);
  const flights = items.filter((i) => i.type === 'flight' && ((mt.locator && i.meta && i.meta.locator === mt.locator) || inRange(i.date))).sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
  const tdocs = items.filter((i) => i.type === 'document' && (i.domain === 'travel' || (mt.locator && i.meta && i.meta.locator === mt.locator)));
  const atts = mt.attachments || [];
  const days = trip.date ? Math.ceil((new Date(trip.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
  const cd = days == null ? '' : days > 1 ? `${days} ${t('daysWord')}` : days === 1 ? (lang === 'pt' ? 'amanhã' : 'tomorrow') : days === 0 ? (lang === 'pt' ? 'hoje' : 'today') : (mt.endDate && mt.endDate >= today ? t('ongoing') : t('doneLabel'));
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('travel')}</button>
      <div style={{ ...card, padding: 16, marginBottom: 12, background: C.accentSoft, borderColor: C.accent + '33' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>{t('nextTrip')}</div>
            <div style={{ fontSize: 21, fontWeight: 700, marginTop: 3 }}>{mt.destination || trip.title}</div>
            <div style={{ fontSize: 12.5, color: C.text2, marginTop: 3 }}>{fmtDate(trip.date, lang)}{mt.endDate ? ` — ${fmtDate(mt.endDate, lang)}` : ''}</div>
          </div>
          <div style={{ textAlign: 'center', flexShrink: 0 }}><div style={{ fontSize: 26, fontWeight: 800, color: C.accent, lineHeight: 1 }}>{days >= 0 ? days : '•'}</div><div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>{days >= 0 ? t('daysWord') : cd}</div></div>
        </div>
        <button onClick={() => setEditing(true)} style={{ ...card, padding: '6px 12px', color: C.text2, cursor: 'pointer', fontSize: 12.5, marginTop: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Pencil size={13} />{t('edit')}</button>
      </div>
      {(mt.travelers && mt.travelers.length > 0) && (() => {
        const travelers = (mt.travelers || []).map((id) => people.find((p) => p.id === id)).filter(Boolean);
        if (travelers.length === 0) return null;
        return (
          <>
            <SectionTitle icon={Users} label={lang === 'pt' ? 'Viajantes' : 'Travelers'} color={C.sky} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              {travelers.map((p) => (
                <div key={p.id} onClick={() => onOpen(p)} style={{ ...card, padding: '8px 12px 8px 8px', display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <Avatar photo={p.meta && p.meta.photo} name={p.title} size={28} color={C.sky} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{p.title}</span>
                </div>
              ))}
            </div>
          </>
        );
      })()}
      <SectionTitle icon={Plane} label={t('flights')} color={C.violet} />
      {flights.length === 0 ? <Empty icon={Plane} text={t('nothingHere')} /> : flights.map((f) => <FlightRow key={f.id} f={f} lang={lang} t={t} onOpen={onOpen} />)}
      <HintCard icon={Ticket} text={t('boardingSoon')} />
      <SectionTitle icon={Home} label={t('hospedagem')} color={C.blue} />
      {mt.hotel ? <div style={{ ...card, padding: 14 }}><div style={{ fontSize: 14, fontWeight: 600 }}>{mt.hotel}</div>{mt.locator && <div style={{ fontSize: 12, color: C.text3, marginTop: 3 }}>{lang === 'pt' ? 'Reserva' : 'Booking'}: {mt.locator}</div>}</div> : <Empty icon={Home} text={t('nothingHere')} />}
      <SectionTitle icon={FileText} label={t('docsNeeded')} color={C.text2} />
      {tdocs.length === 0 ? <Empty icon={FileText} text={t('nothingHere')} /> : tdocs.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      <SectionTitle icon={Paperclip} label={t('reservations')} color={C.accent} />
      {atts.length > 0 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>{atts.map((a) => <AttachThumb key={a.id} att={a} />)}</div> : <Empty icon={Paperclip} text={t('nothingHere')} />}
      <Btn kind="soft" onClick={() => setEditing(true)} style={{ width: '100%', marginTop: 10, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={14} />{t('reservations')}</Btn>
      {editing && <Modal onClose={() => setEditing(false)}><SheetHead title={mt.destination || trip.title} onClose={() => setEditing(false)} icon={Plane} /><ItemForm draft={trip} allowedTypes={['trip']} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { if (confirm(t('deleteConfirmGeneric'))) { delItem(trip.id); setEditing(false); back(); } }} onSave={(x) => { updateItem(trip.id, x); setEditing(false); }} /></Modal>}
    </div>
  );
}
function TravelScreen({ module, items = [], people = [], lang, t, back, toggleTask, onOpen, addItem, updateItem, delItem, flash, setPendingCount }) {
  const [view, setView] = useState('flights'); const [period, setPeriod] = useState('year'); const [adding, setAdding] = useState(null); const [selTrip, setSelTrip] = useState(null);
  const [scan, setScan] = useState({ loading: false, list: null, error: null });
  const [scanDays, setScanDays] = useState(15);
  const runScan = (d) => {
    setScan({ loading: true, list: null, error: null });
    authFetch('/api/inbox-scan?days=' + (d || scanDays)).then((r) => r.json())
      .then((j) => setScan({ loading: false, list: j.suggestions || [], error: j.error || null }))
      .catch((e) => setScan({ loading: false, list: [], error: String(e) }));
  };
  useEffect(() => { if (setPendingCount) setPendingCount('travel', (scan.list || []).length); }, [scan.list]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // toda vez que a aba Viagens abre, já busca sozinho (últimos 15 dias) pra tentar estar sempre atualizado,
  // e também limpa voos/viagens duplicados que já tenham sido aceitos mais de uma vez por engano
  const scannedOnMount = useRef(false);
  useEffect(() => {
    if (scannedOnMount.current) return;
    scannedOnMount.current = true;
    const removed = dedupeTravelItems(itemsRef.current, delItem);
    if (removed) flash(lang === 'pt' ? `${removed} voo(s)/viagem(ns) duplicado(s) removido(s).` : `${removed} duplicate flight(s)/trip(s) removed.`);
    runScan(15);
  }, []);
  const flights = items.filter((i) => i.type === 'flight');
  const trips = items.filter((i) => i.type === 'trip').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today = todayISO();
  const upcoming = trips.filter((tr) => ((tr.meta && tr.meta.endDate) ? tr.meta.endDate : tr.date) >= today).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const nextTrip = upcoming[0];
  const nextDays = (nextTrip && nextTrip.date) ? Math.ceil((new Date(nextTrip.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
  const year = today.slice(0, 4);
  const yf = period === 'year' ? flights.filter((f) => (f.date || '').startsWith(year)) : period === '12m' ? flights.filter((f) => f.date && f.date >= addDays(today, -365)) : flights;
  const hours = yf.reduce((a, b) => a + (Number(b.meta && b.meta.durationMin) || 0), 0) / 60;
  const airports = new Set(); yf.forEach((f) => { if (f.meta && f.meta.from) airports.add(f.meta.from.toUpperCase()); if (f.meta && f.meta.to) airports.add(f.meta.to.toUpperCase()); });
  const airlines = new Set(yf.map((f) => f.meta && f.meta.airline).filter(Boolean));
  const flog = [...yf].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const current = selTrip && items.find((i) => i.id === selTrip);
  if (current) return <TripDetail trip={current} items={items} people={people} lang={lang} t={t} back={() => setSelTrip(null)} onOpen={onOpen} toggleTask={toggleTask} addItem={addItem} updateItem={updateItem} delItem={delItem} flash={flash} />;
  // tenta achar uma viagem já cadastrada com data/destino próximos, pra correlacionar em vez de duplicar
  const findMatchTrip = (sg) => {
    if (!sg.date) return null;
    return trips.find((tr) => {
      const start = tr.date, end = (tr.meta && tr.meta.endDate) || tr.date;
      if (!start) return false;
      const near = sg.date >= addDays(start, -2) && sg.date <= addDays(end, 2);
      if (!near) return false;
      if (sg.meta && sg.meta.to && tr.meta && tr.meta.destination) {
        return tr.meta.destination.toLowerCase().includes(String(sg.meta.to).toLowerCase()) || String(sg.meta.to).toLowerCase().includes(tr.meta.destination.toLowerCase()) || true; // data já bateu, aceita
      }
      return true;
    });
  };
  const acceptSug = (sg) => {
    const domain = (sg.type === 'flight' || sg.type === 'trip') ? 'travel' : sg.type === 'bill' ? 'finance' : 'personal';
    const match = sg.type === 'flight' ? findMatchTrip(sg) : null;
    const draft = { type: sg.type, domain, title: sg.title, date: sg.date, time: sg.time, meta: { ...(sg.meta || {}) } };
    const already = (sg.type === 'flight' || sg.type === 'trip') && itemsRef.current.some((i) => i.type === draft.type && travelDupeKey(i) === travelDupeKey(draft));
    setScan((p) => ({ ...p, list: (p.list || []).filter((x) => x.key !== sg.key) }));
    markTravelEmailProcessed(sg.messageId);
    if (already) { flash(lang === 'pt' ? 'Já estava salvo — ignorado.' : 'Already saved — skipped.'); return; }
    addItem({ ...draft, amount: sg.amount, meta: { ...draft.meta, fromEmail: true, tripId: match ? match.id : null, needsCorrelation: sg.type === 'flight' && !match } });
    flash(match ? (lang === 'pt' ? `Vinculado à viagem "${match.title}" ✓` : 'Linked to trip ✓') : t('savedOne'));
  };
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[30, 90, 180, 365].map((d) => <Chip key={d} active={scanDays === d} onClick={() => setScanDays(d)}>{d}d</Chip>)}
      </div>
      <div style={{ ...card, padding: 12, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
        <Sparkles size={16} style={{ color: C.accent, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 12.5, color: C.text2, lineHeight: 1.4 }}>{t('suggestions')}</span>
        <Btn kind="soft" onClick={runScan} disabled={scan.loading} style={{ padding: '7px 12px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          {scan.loading ? <Loader2 size={13} className="spin" /> : <Mail size={13} />}{scan.loading ? t('scanning') : t('scanInbox')}
        </Btn>
      </div>
      {scan.error && <HintCard icon={AlertTriangle} text={scan.error} />}
      {scan.list && scan.list.length === 0 && !scan.loading && <HintCard icon={Check} text={t('noSuggestions')} />}
      {scan.list && scan.list.map((sg) => {
        const Ic = typeIcon(sg.type);
        const match = sg.type === 'flight' ? findMatchTrip(sg) : null;
        return (
          <div key={sg.key} style={{ ...card, padding: 13, marginBottom: 8, borderColor: C.accent + '33' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Ic size={16} style={{ color: C.accent, marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{sg.title}</div>
                <div style={{ fontSize: 11.5, color: C.text2, marginTop: 3 }}>
                  {t('t_' + sg.type)}{sg.date ? ' · ' + fmtDate(sg.date, lang) : ''}{sg.time ? ' ' + sg.time : ''}
                  {sg.meta && sg.meta.from ? ` · ${sg.meta.from}→${sg.meta.to || ''}` : ''}
                </div>
                {match && <div style={{ fontSize: 11, color: C.green, marginTop: 4, display: 'flex', gap: 5, alignItems: 'center' }}><Check size={11} />{lang === 'pt' ? `Vamos vincular à viagem "${match.title}"` : `Will link to "${match.title}"`}</div>}
                {sg.why && <div style={{ fontSize: 11, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>{sg.why}</div>}
                {sg.source && sg.source.subject && <div style={{ fontSize: 10.5, color: C.text3, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✉ {sg.source.subject}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Btn kind="soft" onClick={() => acceptSug(sg)} style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Check size={13} />{t('accept')}</Btn>
              <Btn kind="ghost" onClick={() => setScan((p) => ({ ...p, list: p.list.filter((x) => x.key !== sg.key) }))} style={{ padding: '7px 12px', fontSize: 12.5 }}>{t('discard')}</Btn>
              {sg.source && sg.source.link && <a href={sg.source.link} target="_blank" rel="noreferrer" style={{ ...card, padding: '7px 11px', color: C.text2, fontSize: 12, textDecoration: 'none', display: 'flex', alignItems: 'center' }}><Mail size={13} /></a>}
            </div>
          </div>
        );
      })}
      {nextTrip && nextDays != null && nextDays <= 30 && (
        <div onClick={() => setSelTrip(nextTrip.id)} style={{ ...card, padding: 15, marginBottom: 14, background: C.accentSoft, borderColor: C.accent + '33', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>{t('nextTrip')}</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3 }}>{(nextTrip.meta && nextTrip.meta.destination) || nextTrip.title}</div>
            <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{fmtDate(nextTrip.date, lang)}{nextTrip.meta && nextTrip.meta.endDate ? ` — ${fmtDate(nextTrip.meta.endDate, lang)}` : ''}</div>
          </div>
          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 800, color: C.accent, lineHeight: 1 }}>{nextDays >= 0 ? nextDays : '•'}</div><div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>{nextDays >= 0 ? t('daysWord') : t('ongoing')}</div></div>
          <ChevronRight size={16} style={{ color: C.text3 }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}><Chip active={view === 'flights'} onClick={() => setView('flights')} color={module.color}>{t('flights')}</Chip><Chip active={view === 'trips'} onClick={() => setView('trips')} color={module.color}>{t('trips')}</Chip></div>
      {view === 'flights' ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 10 }}><Chip active={period === 'year'} onClick={() => setPeriod('year')}>{t('thisYear')}</Chip><Chip active={period === '12m'} onClick={() => setPeriod('12m')}>{lang === 'pt' ? '12 meses' : '12 months'}</Chip><Chip active={period === 'all'} onClick={() => setPeriod('all')}>{t('allTime')}</Chip></div>
          <ErrorBoundary fallback={<div style={{ ...card, padding: 18, marginBottom: 12, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{t('mapUnavailable')}</div>}><FlightMap flights={yf} lang={lang} t={t} /></ErrorBoundary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <MiniStat label={t('flightsCount')} value={yf.length} color={module.color} />
            <MiniStat label={t('hoursFlown')} value={hours.toFixed(1)} color={C.accent} />
            <MiniStat label={t('airportsSeen')} value={airports.size} color={C.blue} />
            <MiniStat label={t('airlinesSeen')} value={airlines.size} color={C.teal} />
          </div>
          <Btn kind="soft" onClick={() => setAdding('flight')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('t_flight')}</Btn>
          {flog.length === 0 ? <Empty icon={Plane} text={t('nothingHere')} /> : flog.map((f) => <FlightRow key={f.id} f={f} lang={lang} t={t} onOpen={onOpen} />)}
        </>
      ) : (
        <>
          <HintCard icon={Plane} text={t('tripHubHint')} />
          {trips.length > 0 && (() => {
            const work = trips.filter((tr) => tr.meta && tr.meta.purpose === 'trabalho').length;
            const leisure = trips.filter((tr) => tr.meta && tr.meta.purpose === 'lazer').length;
            if (!work && !leisure) return null;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <MiniStat label={lang === 'pt' ? 'Viagens a trabalho' : 'Work trips'} value={work} color={C.sky} />
                <MiniStat label={lang === 'pt' ? 'Viagens a lazer' : 'Leisure trips'} value={leisure} color={C.green} />
              </div>
            );
          })()}
          <Btn kind="soft" onClick={() => setAdding('trip')} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('t_trip')}</Btn>
          {trips.length === 0 ? <Empty icon={Plane} text={t('nothingHere')} /> : trips.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={(x) => setSelTrip(x.id)} />)}
        </>
      )}
      {adding && <AddModal title={t('t_' + adding)} icon={adding === 'flight' ? Ticket : Plane} draft={{ type: adding, domain: 'travel', meta: {} }} allowedTypes={[adding]} lang={lang} t={t} people={people} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'travel', ...x }); flash(t('savedOne')); setAdding(null); }} />}
    </div>
  );
}

function VehicleAvatar({ mt, size }) {
  const [src, setSrc] = useState(null);
  const ph = mt && mt.photo;
  useEffect(() => { let m = true; if (ph && ph.id) loadAttachment(ph.id).then((x) => { if (m && x) setSrc(x.dataUrl); }); return () => { m = false; }; }, [ph && ph.id]);
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.22, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Car size={size * 0.52} style={{ color: (mt && mt.color) || C.text3 }} />}
    </div>
  );
}

/* ---------------- Cars ---------------- */
function CarsScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, updateItem, delItem, flash }) {
  const [adding, setAdding] = useState(false); const [sel, setSel] = useState(null);
  const vehicles = items.filter((i) => i.type === 'vehicle');
  const current = sel && items.find((i) => i.id === sel);
  if (current) return <VehicleDetail vehicle={current} items={items} people={people} lang={lang} t={t} back={() => setSel(null)} onOpen={onOpen} toggleTask={toggleTask} addItem={addItem} updateItem={updateItem} delItem={delItem} flash={flash} />;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('t_vehicle')}</Btn>
      {vehicles.length === 0 ? <Empty icon={Car} text={t('nothingHere')} /> : vehicles.map((v) => {
        const mt = v.meta || {};
        return (
          <div key={v.id} onClick={() => setSel(v.id)} style={{ ...card, padding: 14, marginBottom: 10, cursor: 'pointer', display: 'flex', gap: 14, alignItems: 'center' }}>
            <VehicleAvatar mt={mt} size={54} />
            <div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 600 }}>{[mt.make, mt.model].filter(Boolean).join(' ') || v.title}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>{[mt.year, mt.plate && mt.plate.toUpperCase()].filter(Boolean).join(' · ')}</div></div>
            {mt.km && <div style={{ fontSize: 12, color: C.teal }}>{Number(mt.km).toLocaleString(loc(lang))} km</div>}
            <ChevronRight size={16} style={{ color: C.text3 }} />
          </div>
        );
      })}
      {adding && <AddModal title={t('t_vehicle')} icon={Car} draft={{ type: 'vehicle', domain: 'cars', meta: {} }} allowedTypes={['vehicle']} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: 'cars', ...x }); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}
function VehicleDetail({ vehicle, items, people, lang, t, back, onOpen, toggleTask, addItem, updateItem, delItem, flash }) {
  const [editing, setEditing] = useState(false); const [adding, setAdding] = useState(null);
  const mt = vehicle.meta || {};
  const linked = items.filter((i) => i.meta && i.meta.vehicleId === vehicle.id);
  const spent = linked.filter((i) => isMoney(i.type) && i.amount).reduce((a, b) => a + b.amount, 0);
  const maint = linked.filter((i) => i.type === 'maintenance').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const exps = linked.filter((i) => i.type === 'expense').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const docs = linked.filter((i) => i.type === 'document');
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('cars')}</button>
      <div style={{ ...card, padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <VehicleAvatar mt={mt} size={64} />
          <div style={{ flex: 1 }}><div style={{ fontSize: 18, fontWeight: 600 }}>{[mt.make, mt.model].filter(Boolean).join(' ') || vehicle.title}</div><div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{[mt.year, mt.plate && mt.plate.toUpperCase()].filter(Boolean).join(' · ')}</div>{mt.renavam && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>Renavam {mt.renavam}</div>}</div>
          <button onClick={() => setEditing(true)} style={{ ...card, padding: 8, color: C.text2, cursor: 'pointer' }}><Cog size={15} /></button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <MiniStat label={t('spent')} value={fmtMoney(spent, lang)} color={C.green} small />
        <MiniStat label={t('maintenance')} value={maint.length} color={C.accent} />
        <MiniStat label="KM" value={mt.km ? Number(mt.km).toLocaleString(loc(lang)) : '—'} color={C.teal} small />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <Btn kind="soft" onClick={() => setAdding('maintenance')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Wrench size={14} />{t('addMaint')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('expense')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Wallet size={14} />{t('addExpense')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('document')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><FileText size={14} />{t('addDoc')}</Btn>
      </div>
      {maint.length > 0 && <><SectionTitle icon={Wrench} label={t('maintenance')} color={C.accent} />{maint.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {exps.length > 0 && <><SectionTitle icon={Wallet} label={t('expenses')} color={C.green} />{exps.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {docs.length > 0 && <><SectionTitle icon={FileText} label={t('documents')} color={C.blue} />{docs.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {linked.length === 0 && <Empty icon={Car} text={t('nothingHere')} />}
      {editing && <Modal onClose={() => setEditing(false)}><SheetHead title={vehicle.title} onClose={() => setEditing(false)} icon={Car} /><ItemForm draft={vehicle} allowedTypes={['vehicle']} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { if (confirm(t('deleteConfirmGeneric'))) { delItem(vehicle.id); setEditing(false); back(); } }} onSave={(x) => { updateItem(vehicle.id, x); setEditing(false); }} /></Modal>}
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'cars', meta: { vehicleId: vehicle.id } }} allowedTypes={[adding]} lang={lang} t={t} people={people} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'cars', ...x, meta: { ...x.meta, vehicleId: vehicle.id } }); flash(t('savedOne')); setAdding(null); }} />}
    </div>
  );
}

/* ---------------- item detail (read-only view + edit) ---------------- */
function ItemView({ item, lang, t, onAct, allItems, addItem }) {
  const Ic = typeIcon(item.type); const mt = item.meta || {}; const metaFields = META[item.type] || [];
  const rows = metaFields.filter(([k]) => k !== 'attachments' && (mt[k] || mt[k] === 0) && mt[k] !== '').map(([k, ptL, enL]) => [lang === 'pt' ? ptL : enL, String(mt[k])]);
  // horário + duração para eventos/compromissos
  if ((item.type === 'event' || item.type === 'appointment') && item.time) {
    const d = mt.durationMin;
    if (d) {
      const [h, mm] = item.time.split(':').map(Number);
      const endMin = h * 60 + mm + d;
      const endStr = pad2(Math.floor(endMin / 60) % 24) + ':' + pad2(endMin % 60);
      rows.unshift([lang === 'pt' ? 'Horário' : 'Time', `${item.time} – ${endStr} (${d} min)`]);
    } else {
      rows.unshift([lang === 'pt' ? 'Horário' : 'Time', item.time]);
    }
  }
  const atts = mt.attachments || [];
  const done = item.status === 'done';
  const actions = [];
  if (item.type === 'task') { actions.push({ label: done ? t('markUndone') : t('markDone'), icon: done ? Circle : CircleCheck, on: () => onAct({ status: done ? 'planned' : 'done' }), primary: !done }); if (!done) actions.push({ label: t('snooze'), icon: Clock, on: () => onAct({ date: addDays(item.date || todayISO(), 1) }) }); }
  if (item.type === 'bill') actions.push({ label: done ? t('markUndone') : t('markPaid'), icon: done ? Circle : CircleCheck, on: () => onAct({ status: done ? 'planned' : 'done' }), primary: !done });
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={20} style={{ color: mt.milestone ? C.accent : C.text2 }} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: C.text3 }}>{t('t_' + item.type)}</div>
          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>{mt.milestone && <Star size={14} style={{ color: C.accent, flexShrink: 0 }} />}<span>{item.title}</span></div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {item.date && <span style={{ ...card, padding: '7px 11px', fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Clock size={13} style={{ color: C.text3 }} />{fmtDate(item.date, lang)}{item.time ? ' · ' + item.time : ''}</span>}
        {item.amount != null && <span style={{ ...card, padding: '7px 11px', fontSize: 12.5, color: C.green, fontWeight: 600 }}>{fmtMoney(item.amount, lang)}</span>}
        {item.person && <span style={{ ...card, padding: '7px 11px', fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}><UserRound size={13} style={{ color: C.text3 }} />{item.person}</span>}
        {done && <span style={{ ...card, padding: '7px 11px', fontSize: 12.5, color: C.green, display: 'inline-flex', gap: 5, alignItems: 'center' }}><CircleCheck size={13} />{t('doneLabel')}</span>}
      </div>
      {mt.external && (
        <div style={{ ...card, padding: 12, marginBottom: 12, background: C.bg2, display: 'flex', gap: 9, alignItems: 'center' }}>
          <Globe size={14} style={{ color: C.text3, flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, color: C.text3, flex: 1, lineHeight: 1.45 }}>{t('externalItem')}</span>
          {mt.link && <a href={mt.link} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: C.accent, textDecoration: 'none', whiteSpace: 'nowrap' }}>{t('openThere')} →</a>}
        </div>
      )}
      {actions.length > 0 && <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>{actions.map((a, i) => <Btn key={i} kind={a.primary ? 'primary' : 'soft'} onClick={a.on} style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><a.icon size={15} />{a.label}</Btn>)}</div>}
      {rows.length > 0 && <div style={{ ...card, padding: 4, marginBottom: 12 }}>{rows.map(([l, v], i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 12px', borderTop: i ? `1px solid ${C.borderSoft}` : 'none' }}><span style={{ fontSize: 12.5, color: C.text3 }}>{l}</span><span style={{ fontSize: 13, textAlign: 'right' }}>{v}</span></div>)}</div>}
      {(() => {
        const tl = teamsLink(item.notes) || (mt.link && /teams\.microsoft\.com/.test(mt.link) ? mt.link : null);
        if (!tl) return null;
        return <a href={tl} target="_blank" rel="noreferrer" style={{ ...card, padding: '13px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 11, textDecoration: 'none', background: 'linear-gradient(135deg, #5059C9, #4B53BC)', border: 'none' }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Video size={18} style={{ color: '#fff' }} /></div>
          <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{lang === 'pt' ? 'Entrar na reunião' : 'Join meeting'}</div><div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.85)' }}>Microsoft Teams</div></div>
          <ChevronRight size={18} style={{ color: '#fff' }} />
        </a>;
      })()}
      {item.notes && <div style={{ ...card, padding: 14, marginBottom: 12, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{item.notes}</div>}
      {atts.length > 0 && <><div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{t('attachments')}</div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{atts.map((a) => <AttachThumb key={a.id} att={a} />)}</div></>}
      {mt.isExam && <ExamAnalysis item={item} lang={lang} t={t} onAct={onAct} allItems={allItems} addItem={addItem} />}
    </div>
  );
}
function ExamAnalysis({ item, lang, t, onAct, allItems, addItem }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [busy2, setBusy2] = useState(false); const [err2, setErr2] = useState(null); const [foundCount, setFoundCount] = useState(null);
  const [condSuggestions, setCondSuggestions] = useState([]);
  const saved = item.meta && item.meta.examAnalysis;
  const atts = (item.meta && item.meta.attachments) || [];
  const alreadyExtracted = (allItems || []).some((i) => i.type === 'healthMetric' && i.meta && i.meta.sourceDocId === item.id);
  const existingConditionTitles = new Set((allItems || []).filter((i) => i.type === 'condition').map((i) => normTitle(i.title)));

  const analyze = async () => {
    setBusy(true); setErr(null);
    try {
      // monta conteudo: anexos (imagem/pdf) + instrucao — busca o dado real via loadAttachment (o meta.attachments só guarda {id,name,kind})
      const content = [];
      for (const a of atts) {
        const full = await loadAttachment(a.id);
        if (!full || !full.dataUrl) continue;
        const m = /^data:(.*?);base64,(.*)$/.exec(full.dataUrl);
        if (!m) continue;
        const media = m[1]; const data = m[2];
        if (media.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: media, data } });
        else if (media === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
      }
      if (content.length === 0) throw new Error(lang === 'pt' ? 'Não consegui carregar o anexo. Tente reanexar o arquivo.' : 'Could not load attachment. Try re-attaching.');
      content.push({ type: 'text', text: lang === 'pt'
        ? 'Você é um assistente de saúde cuidadoso. Analise este exame (laboratorial ou de imagem) de forma clara e acessível para um leigo. Explique: (1) o que foi examinado/medido, (2) quais valores ou achados estão dentro ou fora do normal, (3) o que isso pode significar em linguagem simples, e (4) pontos que merecem atenção ou conversa com o médico. Seja informativo mas deixe claro que não substitui avaliação médica. Responda em português do Brasil, organizado e conciso.'
        : 'Analyze this exam (lab or imaging) for a layperson. Explain what was measured/examined, what is in/out of normal, what it may mean, and what to discuss with a doctor. Make clear it is not a substitute for medical advice.' });

      const r = await authFetch('/api/claude', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1400, messages: [{ role: 'user', content }] }) });
      const j = await r.json();
      const txt = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (!txt) throw new Error(j.error || 'Sem resposta.');
      onAct({ meta: { examAnalysis: txt, examAnalyzedAt: new Date().toISOString() } });
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const extractIndicators = async () => {
    setBusy2(true); setErr2(null); setFoundCount(null); setCondSuggestions([]);
    try {
      const atts2 = [];
      for (const a of atts) { const full = await loadAttachment(a.id); if (full && full.dataUrl) atts2.push({ dataUrl: full.dataUrl }); }
      if (!atts2.length) throw new Error(lang === 'pt' ? 'Não consegui carregar o anexo.' : 'Could not load attachment.');
      const r = await authFetch('/api/health-analyze', { method: 'POST', body: JSON.stringify({ docId: item.id, attachments: atts2, notes: item.notes, fallbackDate: item.date }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      (j.indicators || []).forEach((ind) => {
        addItem({ type: 'healthMetric', domain: 'health', title: ind.indicator, amount: ind.value, date: ind.date || item.date, meta: { unit: ind.unit, refRange: ind.refRange, status: ind.status, sourceDocId: item.id } });
      });
      setFoundCount((j.indicators || []).length);
      // achados/condições sugeridas — só as que ainda não existem na seção Condições
      const newConds = (j.conditions || []).filter((c) => !existingConditionTitles.has(normTitle(c.title)));
      setCondSuggestions(newConds);
    } catch (e) { setErr2(String(e.message || e)); }
    setBusy2(false);
  };

  const acceptCondition = (c) => {
    addItem({ type: 'condition', domain: 'health', title: c.title, meta: { status: 'ativa', sourceDocId: item.id, why: c.why } });
    setCondSuggestions((p) => p.filter((x) => x !== c));
  };

  return (
    <>
      <div style={{ ...card, padding: 14, marginTop: 12, border: `1px solid ${C.blue}33` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: saved ? 10 : 0 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.blue, display: 'flex', gap: 6, alignItems: 'center' }}><Sparkles size={14} />{lang === 'pt' ? 'Explicação em linguagem simples' : 'Plain-language explanation'}</span>
          <Btn kind="soft" onClick={analyze} disabled={busy || atts.length === 0} style={{ fontSize: 11.5, padding: '6px 11px', display: 'flex', gap: 5, alignItems: 'center' }}>{busy ? <><Loader2 size={12} className="spin" />{lang === 'pt' ? 'Analisando...' : 'Analyzing...'}</> : (saved ? (lang === 'pt' ? 'Refazer' : 'Redo') : (lang === 'pt' ? 'Explicar exame' : 'Explain exam'))}</Btn>
        </div>
        {atts.length === 0 && <div style={{ fontSize: 11.5, color: C.text3 }}>{lang === 'pt' ? 'Anexe a foto ou PDF do exame para o Claude analisar.' : 'Attach the exam to analyze.'}</div>}
        {err && <div style={{ fontSize: 11.5, color: C.rose, marginTop: 8 }}>{err}</div>}
        {saved && <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: C.text }}>{saved}</div>}
      </div>
      <div style={{ ...card, padding: 14, marginTop: 10, border: `1px solid #5B8DEF33` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#5B8DEF', display: 'flex', gap: 6, alignItems: 'center' }}><Stethoscope size={14} />{lang === 'pt' ? 'Dr. Claude — extrair indicadores e achados' : 'Dr. Claude — extract indicators & findings'}</span>
          <Btn kind="soft" onClick={extractIndicators} disabled={busy2 || atts.length === 0} style={{ fontSize: 11.5, padding: '6px 11px', display: 'flex', gap: 5, alignItems: 'center' }}>{busy2 ? <><Loader2 size={12} className="spin" />{lang === 'pt' ? 'Analisando...' : 'Analyzing...'}</> : (alreadyExtracted ? (lang === 'pt' ? 'Refazer' : 'Redo') : (lang === 'pt' ? 'Extrair' : 'Extract'))}</Btn>
        </div>
        <div style={{ fontSize: 10.5, color: C.text3, marginTop: 6 }}>{lang === 'pt' ? 'Funciona pra exames laboratoriais (valores numéricos) e de imagem (achados/diagnósticos).' : 'Works for lab exams (numbers) and imaging (findings/diagnoses).'}</div>
        {err2 && <div style={{ fontSize: 11.5, color: C.rose, marginTop: 8 }}>{err2}</div>}
        {foundCount != null && !err2 && <div style={{ fontSize: 11.5, color: foundCount > 0 ? C.green : C.text3, marginTop: 8 }}>{foundCount > 0 ? `✓ ${foundCount} ${lang === 'pt' ? 'indicadores encontrados — veja no Histórico Médico.' : 'indicators found — check Medical History.'}` : (lang === 'pt' ? 'Nenhum indicador numérico foi encontrado neste documento.' : 'No numeric indicators found.')}</div>}
        {alreadyExtracted && foundCount == null && <div style={{ fontSize: 11, color: C.text3, marginTop: 8 }}>{lang === 'pt' ? 'Já extraído — veja no Histórico Médico.' : 'Already extracted.'}</div>}
        {condSuggestions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: C.text3, marginBottom: 6 }}>{lang === 'pt' ? 'Achados que podem virar condições registradas:' : 'Findings that could become tracked conditions:'}</div>
            {condSuggestions.map((c, i) => (
              <div key={i} style={{ ...card, padding: '9px 11px', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.title}</div>
                  {c.why && <div style={{ fontSize: 10.5, color: C.text3, marginTop: 1 }}>{c.why}</div>}
                </div>
                <Btn kind="soft" onClick={() => acceptCondition(c)} style={{ padding: '5px 9px', fontSize: 11, display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}><Plus size={12} />{lang === 'pt' ? 'Adicionar' : 'Add'}</Btn>
                <button onClick={() => setCondSuggestions((p) => p.filter((x) => x !== c))} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', padding: 3, flexShrink: 0 }}><X size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function itemShareText(item, lang, t) {
  const lines = [item.title, t('t_' + item.type)];
  if (item.date) lines.push(fmtDate(item.date, lang) + (item.time ? ' · ' + item.time : ''));
  if (item.amount != null) lines.push(fmtMoney(item.amount, lang));
  if (item.person) lines.push(item.person);
  if (item.notes) lines.push('', item.notes);
  return lines.filter(Boolean).join('\n');
}
function ItemDetail({ item, lang, t, people, onClose, onSave, onDelete, onAct, allItems, addItem }) {
  const [editing, setEditing] = useState(false);
  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{t('t_' + item.type)}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {isNative() && !editing && <button onClick={() => nativeShare(item.title, itemShareText(item, lang, t))} style={{ ...card, padding: 7, color: C.text2, cursor: 'pointer' }}><Share2 size={15} /></button>}
          {!editing && !(item.meta && item.meta.external) && <button onClick={() => setEditing(true)} style={{ ...card, padding: 7, color: C.accent, cursor: 'pointer' }}><Pencil size={15} /></button>}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer' }}><X size={20} /></button>
        </div>
      </div>
      {editing
        ? <ItemForm draft={item} allowedTypes={[item.type]} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { onDelete(item.id); onClose(); }} onSave={(x) => { onSave(item.id, x); setEditing(false); }} />
        : <ItemView item={item} lang={lang} t={t} onAct={onAct} allItems={allItems} addItem={addItem} />}
    </Modal>
  );
}

/* ---------------- Settings ---------------- */
function LgDiag({ t, lang }) {
  const [data, setData] = useState(null); const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const r = await authFetch('/api/lg?debug=1'); setData(await r.json()); } catch (e) { setData({ error: String(e) }); }
    setBusy(false);
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Btn kind="soft" onClick={run} disabled={busy} style={{ width: '100%', marginBottom: 8, padding: '12px', display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>
        {busy ? <Loader2 size={14} className="spin" /> : <Power size={14} />}{lang === 'pt' ? 'Diagnóstico LG ThinQ' : 'LG ThinQ diagnostic'}
      </Btn>
      {data && (
        <div style={{ ...card, padding: 12, fontSize: 10.5, fontFamily: 'monospace', maxHeight: 280, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text2 }}>
          {JSON.stringify(data, null, 1)}
        </div>
      )}
    </div>
  );
}

function TuyaIrDiag({ t, lang }) {
  const [data, setData] = useState(null); const [busy, setBusy] = useState(false); const [lamp, setLamp] = useState(null);
  const run = async () => {
    setBusy(true);
    try { const r = await authFetch('/api/tuya?ir=1'); setData(await r.json()); } catch (e) { setData({ error: String(e) }); }
    // status cru do Abajur Carol para diagnostico
    try { const r2 = await authFetch('/api/tuya?status=eb2a4a8b85c2a8deadb1g8'); setLamp(await r2.json()); } catch (e) { setLamp({ error: String(e) }); }
    setBusy(false);
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Btn kind="soft" onClick={run} disabled={busy} style={{ width: '100%', marginBottom: 8, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>
        {busy ? <Loader2 size={14} className="spin" /> : <Power size={14} />}{lang === 'pt' ? 'Diagnóstico dos controles IR' : 'IR remotes diagnostic'}
      </Btn>
      {data && (
        <div style={{ ...card, padding: 12, fontSize: 11, fontFamily: 'monospace', maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text2 }}>
          {data.error ? 'Erro: ' + data.error : JSON.stringify({ hubs: data.hubs, remotes: data.remotes }, null, 1)}
          {lamp && '\n\n--- Abajur Carol (status) ---\n' + JSON.stringify(lamp.status || lamp, null, 1)}
        </div>
      )}
    </div>
  );
}

function OuraWebhookSetup({ lang }) {
  const [busy, setBusy] = useState(false); const [result, setResult] = useState(null);
  const [refreshing, setRefreshing] = useState(false); const [cachedAt, setCachedAt] = useState(undefined);
  const loadStatus = () => authFetch('/api/oura').then((r) => r.json()).then((j) => setCachedAt(j && j.cachedAt ? j.cachedAt : null)).catch(() => {});
  useEffect(() => { loadStatus(); }, []);
  const run = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await authFetch('/api/oura/subscribe', { method: 'POST' });
      const j = await r.json();
      setResult(r.ok ? j : { error: j.error || 'Erro' });
    } catch (e) { setResult({ error: String(e) }); }
    setBusy(false);
  };
  const refreshNow = async () => {
    setRefreshing(true);
    try { await authFetch('/api/oura?refresh=1'); await loadStatus(); } catch (e) {}
    setRefreshing(false);
  };
  return (
    <div style={{ ...card, padding: '12px 14px', marginBottom: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>{lang === 'pt' ? 'Sync automático do Oura' : 'Automatic Oura sync'}</div>
      <div style={{ fontSize: 11, color: C.text3, marginBottom: 8, lineHeight: 1.4 }}>
        {lang === 'pt' ? 'Assina os webhooks da Oura: assim que o anel sincronizar com o app (mesmo em segundo plano), os dados chegam aqui na hora. Se ficar mais de 3h sem novidade, o app busca ao vivo sozinho.' : 'Subscribes to Oura webhooks so data lands here as soon as the ring syncs. If nothing arrives for 3h, the app fetches live on its own.'}
      </div>
      <div style={{ fontSize: 11, color: C.text3, marginBottom: 8 }}>
        {lang === 'pt' ? 'Última atualização: ' : 'Last update: '}
        {cachedAt === undefined ? '…' : (cachedAt ? new Date(cachedAt).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') : (lang === 'pt' ? 'nunca' : 'never'))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="soft" onClick={run} disabled={busy} style={{ padding: '6px 12px', fontSize: 12 }}>{busy ? '…' : (lang === 'pt' ? 'Ativar' : 'Enable')}</Btn>
        <Btn kind="ghost" onClick={refreshNow} disabled={refreshing} style={{ padding: '6px 12px', fontSize: 12 }}>{refreshing ? '…' : (lang === 'pt' ? 'Atualizar agora' : 'Refresh now')}</Btn>
      </div>
      {result && (
        <div style={{ fontSize: 11, marginTop: 8, color: result.error ? C.rose : C.text2, lineHeight: 1.5 }}>
          {result.error ? result.error : (lang === 'pt'
            ? `Criadas: ${result.created.length} · já existiam: ${result.skipped.length}${result.failed.length ? ` · falharam: ${result.failed.length}` : ''}`
            : `Created: ${result.created.length} · already existed: ${result.skipped.length}${result.failed.length ? ` · failed: ${result.failed.length}` : ''}`)}
          {!!(result.failed && result.failed.length) && (
            <div style={{ marginTop: 4, color: C.rose }}>{result.failed.map((f) => `${f.key}: ${f.error}`).join(' · ')}</div>
          )}
        </div>
      )}
    </div>
  );
}
function Connections({ lang, t }) {
  const [st, setSt] = useState(null); const [busy, setBusy] = useState('');
  const load = () => authFetch('/api/connect').then((r) => r.json()).then(setSt).catch(() => setSt({}));
  useEffect(() => { load(); }, []);
  const start = async (provider) => {
    setBusy(provider);
    try {
      const r = await authFetch('/api/connect', { method: 'POST', body: JSON.stringify({ provider }) });
      const j = await r.json();
      if (j.url) window.location.href = j.url; else { alert(j.error || 'Erro'); setBusy(''); }
    } catch (e) { alert(String(e)); setBusy(''); }
  };
  const stop = async (provider) => {
    if (!confirm(t('disconnect') + '?')) return;
    await authFetch('/api/connect?provider=' + provider, { method: 'DELETE' });
    load();
  };
  const Row = ({ id, label, icon: Ic, color }) => {
    const c = st && st[id];
    const on = c && c.connected;
    return (
      <div style={{ ...card, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 11, alignItems: 'center' }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={16} style={{ color }} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 11, color: on ? C.green : C.text3, marginTop: 1 }}>
            {on ? t('connected') : (c && c.configured === false ? t('notConfigured') : '—')}
          </div>
        </div>
        {on
          ? <Btn kind="ghost" onClick={() => stop(id)} style={{ padding: '6px 12px', fontSize: 12 }}>{t('disconnect')}</Btn>
          : <Btn kind="soft" onClick={() => start(id)} disabled={busy === id} style={{ padding: '6px 12px', fontSize: 12 }}>{busy === id ? '…' : t('connect')}</Btn>}
      </div>
    );
  };
  if (!st) return <div style={{ ...card, padding: 14, marginBottom: 10, color: C.text3, fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'center' }}><Loader2 size={13} className="spin" />…</div>;
  return (
    <>
      <ResponsiveGrid min={280}>
        <Row id="oura" label="Oura Ring" icon={Activity} color={C.green} />
        <Row id="google" label="Gmail + Google Agenda" icon={Mail} color={C.blue} />
        <Row id="ticktick" label="TickTick" icon={ListTodo} color={C.green} />
        <Row id="mercadolivre" label="Mercado Livre" icon={ShoppingCart} color={C.accent} />
      </ResponsiveGrid>
      {st.oura && st.oura.connected && <OuraWebhookSetup lang={lang} />}
    </>
  );
}

function AppLockSetting({ settings, setSettings, lang }) {
  const [check, setCheck] = useState(null); // resultado de checkBiometry()
  useEffect(() => { if (isNative()) BiometricAuth.checkBiometry().then(setCheck).catch(() => setCheck({ isAvailable: false })); }, []);
  if (!isNative() || !check) return null;
  const kind = check.biometryType === BiometryType.faceId ? 'Face ID' : check.biometryType === BiometryType.touchId ? 'Touch ID' : (lang === 'pt' ? 'biometria' : 'biometry');
  if (!check.isAvailable) return null;
  const on = !!settings.appLock;
  return (
    <div style={{ ...card, padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Fingerprint size={17} style={{ color: on ? C.accent : C.text3, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{lang === 'pt' ? `Bloquear com ${kind}` : `Lock with ${kind}`}</div>
        <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>{lang === 'pt' ? 'Pede autenticação ao abrir o app' : 'Requires authentication on open'}</div>
      </div>
      <button onClick={() => setSettings((s) => ({ ...s, appLock: !on }))} style={{ width: 44, height: 26, borderRadius: 999, background: on ? C.accent : C.surface2, border: `1px solid ${on ? C.accent : C.border}`, position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 20, height: 20, borderRadius: 999, background: on ? '#FFFFFF' : C.text3, transition: 'left .15s' }} />
      </button>
    </div>
  );
}
/** Registra o token do device no backend (chamado ao ligar e no refresh do token do Firebase). */
async function registerPushToken() {
  const { token } = await FirebaseMessaging.getToken();
  if (!token) return null;
  const res = await authFetch('/api/push/register', { method: 'POST', body: JSON.stringify({ token, platform: Capacitor.getPlatform() }) });
  if (!res.ok) {
    let msg = 'Erro ao registrar o device (' + res.status + ').';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return token;
}

function PushNotificationsSetting({ lang }) {
  const [status, setStatus] = useState(null); // 'granted' | 'denied' | 'prompt' | null (carregando)
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    if (!isNative()) return;
    FirebaseMessaging.checkPermissions().then((r) => {
      setStatus(r.receive);
      // a permissão do iOS já pode estar concedida de uma tentativa anterior (ex: o
      // registro falhou por outro motivo) — nesse caso o botão "Ativar" não aparece
      // de novo, então tenta registrar o token sozinho sempre que a tela abrir.
      if (r.receive === 'granted') registerPushToken().catch((e) => setTestMsg(String(e.message || e)));
    }).catch(() => setStatus('prompt'));
    const sub = FirebaseMessaging.addListener('tokenReceived', () => { registerPushToken().catch(() => {}); });
    return () => { sub.then((h) => h.remove()).catch(() => {}); };
  }, []);

  if (!isNative() || !status) return null;

  const enable = async () => {
    setBusy(true); setTestMsg('');
    try {
      const perm = await FirebaseMessaging.requestPermissions();
      setStatus(perm.receive);
      if (perm.receive === 'granted') await registerPushToken();
    } catch (e) { setTestMsg(String(e.message || e)); }
    setBusy(false);
  };

  const sendTest = async () => {
    setBusy(true); setTestMsg('');
    try {
      const r = await authFetch('/api/push/test', { method: 'POST' });
      const j = await r.json();
      setTestMsg(j.error ? j.error : (lang === 'pt' ? 'Enviada — deve chegar em instantes.' : 'Sent — should arrive shortly.'));
    } catch (e) { setTestMsg(String(e.message || e)); }
    setBusy(false);
  };

  const on = status === 'granted';
  return (
    <div style={{ ...card, padding: '12px 14px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Bell size={17} style={{ color: on ? C.accent : C.text3, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{lang === 'pt' ? 'Notificações' : 'Notifications'}</div>
          <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>
            {status === 'granted' ? (lang === 'pt' ? 'Ativadas neste aparelho' : 'Enabled on this device')
              : status === 'denied' ? (lang === 'pt' ? 'Bloqueadas — ative em Ajustes do iOS' : 'Blocked — enable in iOS Settings')
              : (lang === 'pt' ? 'Avise sobre compromissos, tarefas e mais' : 'Get notified about events, tasks and more')}
          </div>
        </div>
        {!on && status !== 'denied' && <Btn kind="soft" onClick={enable} disabled={busy} style={{ padding: '6px 12px', fontSize: 12 }}>{busy ? '…' : (lang === 'pt' ? 'Ativar' : 'Enable')}</Btn>}
      </div>
      {on && (
        <button onClick={sendTest} disabled={busy} style={{ marginTop: 10, width: '100%', padding: '8px', borderRadius: 10, background: 'transparent', border: `1px solid ${C.border}`, color: C.text2, fontSize: 12, cursor: 'pointer' }}>
          {busy ? '…' : (lang === 'pt' ? 'Mandar notificação de teste' : 'Send test notification')}
        </button>
      )}
      {testMsg && <div style={{ fontSize: 11, color: C.text3, marginTop: 6 }}>{testMsg}</div>}
    </div>
  );
}

function SettingsSheet({ settings, setSettings, lang, t, items, setItems, theme, applyTheme, onClose }) {
  const [name, setName] = useState(settings.name);
  const dock = settings.dock || DEFAULT_DOCK;
  const toggleDock = (k) => setSettings((s) => { const cur = s.dock || DEFAULT_DOCK; const has = cur.includes(k); if (has) return { ...s, dock: cur.filter((x) => x !== k) }; if (cur.length >= 5) return s; return { ...s, dock: [...cur, k] }; });
  const exportJSON = () => { const blob = new Blob([JSON.stringify({ items, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'life-control-export.json'; a.click(); URL.revokeObjectURL(url); };
  return (
    <Modal onClose={onClose} wide>
      <SheetHead title={t('settings')} onClose={onClose} icon={Cog} />
      <ResponsiveGrid min={200}>
        <Field label={t('name')}><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setSettings((s) => ({ ...s, name }))} style={inputStyleBig} /></Field>
        <Field label={t('height') + ' (cm)'}><input type="number" value={settings.profile && settings.profile.height || ''} onChange={(e) => setSettings((s) => ({ ...s, profile: { ...(s.profile || {}), height: e.target.value } }))} style={inputStyleBig} /></Field>
      </ResponsiveGrid>
      <Field label={t('language')}><div style={{ display: 'flex', gap: 8 }}><Chip active={lang === 'pt'} onClick={() => setSettings((s) => ({ ...s, lang: 'pt' }))}>Português (BR)</Chip><Chip active={lang === 'en'} onClick={() => setSettings((s) => ({ ...s, lang: 'en' }))}>English (US)</Chip></div></Field>
      <AppLockSetting settings={settings} setSettings={setSettings} lang={lang} />
      <PushNotificationsSetting lang={lang} />
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{t('editDock')}</div>
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8 }}>{t('dockHint')} ({dock.length}/5)</div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
        {DOCKABLE.map((k) => { const on = dock.includes(k); const Ic = navIcon(k); return (
          <button key={k} onClick={() => toggleDock(k)} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 13, background: on ? C.accentSoft : 'transparent', color: on ? C.accent : C.text2, border: `1px solid ${on ? C.accent + '55' : C.border}` }}><Ic size={14} />{navLabel(k, t)}</button>
        ); })}
      </div>
      <div style={{ height: 1, background: C.borderSoft, margin: '8px 0 20px' }} />
      <div style={{ fontSize: 12, color: C.text, textTransform: 'uppercase', letterSpacing: '.06em', margin: '4px 0 12px', fontWeight: 700 }}>{t('connections')}</div>
      <Connections lang={lang} t={t} />
      <TuyaIrDiag t={t} lang={lang} />
      <LgDiag t={t} lang={lang} />
      <div style={{ height: 1, background: C.borderSoft, margin: '20px 0' }} />
      <div style={{ fontSize: 12, color: C.text, textTransform: 'uppercase', letterSpacing: '.06em', margin: '4px 0 12px', fontWeight: 700 }}>{lang === 'pt' ? 'Dados' : 'Data'}</div>
      <ResponsiveGrid min={230}>
        <div style={{ ...card, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, color: C.text2, marginBottom: 8, fontWeight: 600 }}>{lang === 'pt' ? 'Saldo na tela Hoje' : 'Balance on Today'}</div>
          <select value={settings.todayAccountId || ''} onChange={(e) => setSettings((s) => ({ ...s, todayAccountId: e.target.value || null }))} style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none' }}>
            <option value="">{lang === 'pt' ? 'Automático (conta Alelo)' : 'Auto (Alelo)'}</option>
            {items.filter((i) => i.type === 'account').map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
          <div style={{ fontSize: 11, color: C.text3, marginTop: 6, lineHeight: 1.4 }}>{lang === 'pt' ? 'Escolha qual conta ou cartão aparece no terceiro card da tela Hoje.' : 'Pick which account shows on Today.'}</div>
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, color: C.text2, marginBottom: 10, fontWeight: 600 }}>{lang === 'pt' ? 'Aparência' : 'Appearance'}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => applyTheme && applyTheme('dark')} style={{ flex: 1, ...card, padding: '11px', cursor: 'pointer', border: `1px solid ${theme !== 'light' ? C.accent : C.border}`, color: theme !== 'light' ? C.accent : C.text2, display: 'flex', gap: 7, justifyContent: 'center', alignItems: 'center', fontSize: 13, fontWeight: 600 }}><Moon size={15} />{lang === 'pt' ? 'Escuro' : 'Dark'}</button>
            <button onClick={() => applyTheme && applyTheme('light')} style={{ flex: 1, ...card, padding: '11px', cursor: 'pointer', border: `1px solid ${theme === 'light' ? C.accent : C.border}`, color: theme === 'light' ? C.accent : C.text2, display: 'flex', gap: 7, justifyContent: 'center', alignItems: 'center', fontSize: 13, fontWeight: 600 }}><Sun size={15} />{lang === 'pt' ? 'Claro' : 'Light'}</button>
          </div>
        </div>
      </ResponsiveGrid>
      <div style={{ marginBottom: 12 }}><HintCard icon={Activity} text={t('appleHealth')} /></div>
      <Btn kind="soft" onClick={() => { if (confirm(lang === 'pt' ? 'Apagar TODOS os dados do app e começar do zero? As conexões (Google, Oura, TickTick, Tuya, LG) permanecem.' : 'Erase all app data and start fresh? Connections stay.')) { setItems([]); onClose(); } }} style={{ width: '100%', marginBottom: 12, padding: '13px', display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', color: C.rose }}><Trash2 size={15} />{lang === 'pt' ? 'Zerar app (começar do zero)' : 'Reset app'}</Btn>
      <Btn kind="soft" onClick={exportJSON} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Download size={15} />{t('exportData')}</Btn>
      <Btn kind="soft" onClick={() => document.getElementById('lcc-import').click()} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Paperclip size={15} />{lang === 'pt' ? 'Importar JSON' : 'Import JSON'}</Btn>
      <input id="lcc-import" type="file" accept="application/json" style={{ display: 'none' }} onChange={async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const txt = await f.text(); const n = await importExportedJson(txt); alert((lang === 'pt' ? 'Importados: ' : 'Imported: ') + n); window.location.reload(); }
        catch (err) { alert('Erro: ' + err.message); }
        e.target.value = '';
      }} />
      <Btn kind="ghost" onClick={async () => {
        if (isNative()) { try { const { token } = await FirebaseMessaging.getToken(); if (token) await authFetch('/api/push/register', { method: 'DELETE', body: JSON.stringify({ token }) }); } catch (e) {} }
        await supabase.auth.signOut(); window.location.reload();
      }} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>{lang === 'pt' ? 'Sair da conta' : 'Sign out'}</Btn>
      <Btn kind="danger" onClick={() => { if (confirm(t('clearConfirm'))) { setItems([]); persistSeeded(); onClose(); } }} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Trash2 size={15} />{t('clearData')}</Btn>
      {!hasStore() && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 14, textAlign: 'center' }}>{t('noPersist')}</div>}
      <div style={{ fontSize: 10.5, color: C.text3, marginTop: 16, textAlign: 'center', opacity: 0.7 }}>{APP_VERSION}</div>
    </Modal>
  );
}

/* ---------------- sample data ---------------- */
function SEED() {
  const T = todayISO(); const now = Date.now(); let c = 0;
  const mk = (o) => ({ id: 'seed_' + (c++), createdAt: now - c * 60000, status: 'planned', currency: 'BRL', ...o, meta: { ...(o.meta || {}) } });
  const pCarol = 'p_carol', pDudu = 'p_dudu', pMaria = 'p_maria', pRoberto = 'p_roberto', vVolvo = 'v_volvo';
  const aItau = 'a_itau', aAlelo = 'a_alelo', aNubank = 'a_nubank', aXP = 'a_xp';
  const M = (n, d) => { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() - n); x.setDate(Math.min(d, 27)); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; };
  return [
    mk({ id: pCarol, type: 'person', domain: 'personal', title: 'Carol', meta: { relationship: 'Esposa', phone: '+55 11 99876-5432', email: 'carol@email.com', address: 'Rua das Acácias, 250 — São Paulo' } }),
    mk({ id: pDudu, type: 'person', domain: 'personal', title: 'Eduardo (Dudu)', meta: { relationship: 'Filho', birthdate: '2016-04-12' } }),
    mk({ id: pMaria, type: 'person', domain: 'personal', title: 'Maria', meta: { relationship: 'Filha', birthdate: '2019-09-03' } }),
    mk({ id: pRoberto, type: 'person', domain: 'personal', title: 'Roberto', meta: { relationship: 'Caseiro', role: 'Staff', phone: '+55 11 98123-4567' } }),
    mk({ type: 'person', domain: 'personal', title: 'João Almeida', notes: 'Fecha o IR até abril. Enviar notas fiscais todo mês.', meta: { relationship: 'Contador', company: 'Almeida Contabilidade', phone: '+55 11 3333-2211', email: 'joao@almeidacont.com.br', address: 'Av. Paulista, 1000 — São Paulo' } }),
    mk({ id: aItau, type: 'account', domain: 'finance', title: 'Itaú — Conta Corrente', meta: { kind: 'checking', institution: 'Itaú', balance: 8450, showOnToday: false } }),
    mk({ id: aAlelo, type: 'account', domain: 'finance', title: 'Alelo — Refeição', meta: { kind: 'benefit', institution: 'Alelo', balance: 642.30, showOnToday: true } }),
    mk({ id: aNubank, type: 'account', domain: 'finance', title: 'Nubank — Cartão', meta: { kind: 'credit', institution: 'Nubank', balance: 2340 } }),
    mk({ id: aXP, type: 'account', domain: 'finance', title: 'XP — Investimentos', meta: { kind: 'investment', institution: 'XP', balance: 45200 } }),
    mk({ type: 'message', domain: 'personal', title: 'Farmácia', notes: 'Amor, consegue passar na farmácia e pegar a vitamina D das crianças? 🙏', meta: { channel: 'whatsapp', sender: 'Carol', unread: true }, date: T }),
    mk({ type: 'message', domain: 'work', title: 'Deck Q3', notes: 'Bruno, consegue revisar o deck do Q3 antes das 15h? Preciso mandar pro board hoje.', meta: { channel: 'teams', sender: 'Ricardo (Chefe)', unread: true }, date: T }),
    mk({ type: 'message', domain: 'kids', title: 'Reunião de pais', notes: 'Prezados, a reunião de pais do Eduardo será na próxima semana às 19h. Por favor, confirme presença.', meta: { channel: 'email', sender: 'Escola Beacon', unread: true }, date: T }),
    mk({ type: 'message', domain: 'home', title: 'Acabou o gás', notes: 'Seu Bruno, o gás da cozinha acabou. Quer que eu já chame a entrega?', meta: { channel: 'whatsapp', sender: 'Roberto (caseiro)', unread: true }, date: T }),
    mk({ type: 'message', domain: 'finance', title: 'Fatura fechada', notes: 'Sua fatura Nubank fechou em R$ 2.340,00, com vencimento no dia 18.', meta: { channel: 'email', sender: 'Nubank', unread: false }, date: addDays(T, -1) }),
    mk({ type: 'note', domain: 'personal', title: 'Confirmar horário da natação da Maria', status: 'inbox' }),
    mk({ type: 'task', domain: 'work', title: 'Revisar deck Q3 antes das 15h', priority: 1, date: T, time: '14:00' }),
    mk({ type: 'task', domain: 'home', title: 'Marcar reunião do condomínio', priority: 3, date: addDays(T, -2) }),
    mk({ type: 'task', domain: 'cars', title: 'Pagar IPVA do Volvo', priority: 2, date: addDays(T, 5), meta: { vehicleId: vVolvo } }),
    mk({ type: 'task', domain: 'cars', title: 'Agendar revisão de 30.000 km', priority: 2, date: addDays(T, 3), meta: { vehicleId: vVolvo } }),
    mk({ type: 'task', domain: 'kids', title: 'Comprar presente de aniversário da Maria', priority: 2, date: addDays(T, 10), person: 'Maria', meta: { personId: pMaria } }),
    mk({ type: 'task', domain: 'travel', title: 'Renovar passaporte', priority: 2, date: addDays(T, 40) }),
    mk({ type: 'event', domain: 'kids', title: 'Reunião de pais — Escola do Dudu', date: addDays(T, 7), time: '19:00', person: 'Eduardo (Dudu)', meta: { personId: pDudu, milestone: true } }),
    mk({ type: 'event', domain: 'personal', title: 'Jantar de aniversário da Carol', date: addDays(T, 14), time: '20:30', person: 'Carol', meta: { personId: pCarol, milestone: true } }),
    mk({ type: 'appointment', domain: 'health', title: 'Cardiologista — check-up', date: addDays(T, 4), time: '09:30', meta: { doctor: 'Dr. Antônio', specialty: 'Cardiologia', location: 'Hospital Albert Einstein' } }),
    mk({ type: 'appointment', domain: 'kids', title: 'Dentista do Dudu', date: addDays(T, 6), time: '16:00', person: 'Eduardo (Dudu)', meta: { personId: pDudu } }),
    mk({ type: 'med', domain: 'health', title: 'Vitamina D', meta: { dose: '2000 UI', frequency: '1x ao dia' } }),
    mk({ type: 'income', domain: 'finance', title: 'Salário', amount: 18500, date: M(0, 5), meta: { accountId: aItau, category: 'salario', source: 'Empresa' } }),
    mk({ type: 'income', domain: 'finance', title: 'Salário', amount: 18500, date: M(1, 5), meta: { accountId: aItau, category: 'salario', source: 'Empresa' } }),
    mk({ type: 'income', domain: 'finance', title: 'Salário', amount: 18500, date: M(2, 5), meta: { accountId: aItau, category: 'salario', source: 'Empresa' } }),
    mk({ type: 'income', domain: 'finance', title: 'Dividendos', amount: 820, date: M(0, 10), meta: { accountId: aXP, category: 'investimento' } }),
    mk({ type: 'income', domain: 'finance', title: 'Crédito benefício', amount: 900, date: M(0, 1), meta: { accountId: aAlelo, category: 'salario', source: 'Alelo' } }),
    mk({ type: 'expense', domain: 'home', title: 'Mercado da semana', amount: 487.90, date: T, meta: { accountId: aNubank, category: 'alimentacao' } }),
    mk({ type: 'expense', domain: 'health', title: 'Farmácia — remédios', amount: 132.40, date: addDays(T, -2), meta: { accountId: aNubank, category: 'saude' } }),
    mk({ type: 'expense', domain: 'cars', title: 'Gasolina', amount: 300, date: addDays(T, -1), meta: { vehicleId: vVolvo, accountId: aItau, category: 'transporte' } }),
    mk({ type: 'expense', domain: 'kids', title: 'Mensalidade escolar', amount: 2800, date: addDays(T, -5), person: 'Eduardo (Dudu)', meta: { personId: pDudu, accountId: aItau, category: 'educacao' } }),
    mk({ type: 'expense', domain: 'personal', title: 'Uber', amount: 44.90, date: T, meta: { accountId: aNubank, category: 'transporte' } }),
    mk({ type: 'expense', domain: 'personal', title: 'Almoço iFood', amount: 68.50, date: addDays(T, -1), meta: { accountId: aAlelo, category: 'alimentacao' } }),
    mk({ type: 'expense', domain: 'personal', title: 'Cinema com a Carol', amount: 96, date: addDays(T, -3), person: 'Carol', meta: { personId: pCarol, accountId: aNubank, category: 'lazer' } }),
    mk({ type: 'expense', domain: 'home', title: 'Jantar restaurante', amount: 240, date: addDays(T, -4), meta: { accountId: aNubank, category: 'alimentacao' } }),
    mk({ type: 'expense', domain: 'personal', title: 'Assinatura streaming', amount: 55.90, date: addDays(T, -6), meta: { accountId: aNubank, category: 'servicos' } }),
    mk({ type: 'expense', domain: 'kids', title: 'Presente Maria', amount: 180, date: addDays(T, -7), person: 'Maria', meta: { personId: pMaria, accountId: aNubank, category: 'compras' } }),
    mk({ type: 'expense', domain: 'home', title: 'Mercado (mês passado)', amount: 1520, date: M(1, 8), meta: { accountId: aNubank, category: 'alimentacao' } }),
    mk({ type: 'expense', domain: 'kids', title: 'Mensalidade (mês passado)', amount: 2800, date: M(1, 6), person: 'Eduardo (Dudu)', meta: { personId: pDudu, accountId: aItau, category: 'educacao' } }),
    mk({ type: 'expense', domain: 'cars', title: 'Combustível (mês passado)', amount: 640, date: M(1, 12), meta: { vehicleId: vVolvo, accountId: aItau, category: 'transporte' } }),
    mk({ type: 'expense', domain: 'personal', title: 'Restaurantes (2 meses)', amount: 980, date: M(2, 15), meta: { accountId: aNubank, category: 'alimentacao' } }),
    mk({ type: 'expense', domain: 'home', title: 'Mercado (2 meses)', amount: 1380, date: M(2, 8), meta: { accountId: aNubank, category: 'alimentacao' } }),
    mk({ type: 'bill', domain: 'finance', title: 'Conta de luz (Enel)', amount: 342.10, date: addDays(T, 8), meta: { payee: 'Enel', accountId: aItau, category: 'servicos' } }),
    mk({ type: 'bill', domain: 'finance', title: 'Internet Vivo Fibra', amount: 129.90, date: addDays(T, 12), meta: { payee: 'Vivo', accountId: aItau, category: 'servicos' } }),
    mk({ type: 'bill', domain: 'finance', title: 'Fatura Nubank', amount: 2340, date: addDays(T, 18), meta: { payee: 'Nubank', accountId: aNubank, category: 'servicos' } }),
    mk({ type: 'document', domain: 'docs', title: 'CNH', date: addDays(T, 45), meta: { number: '01234567890', issuer: 'Detran-SP', holder: 'Bruno' } }),
    mk({ type: 'document', domain: 'travel', title: 'Passaporte', date: addDays(T, 200), meta: { holder: 'Bruno' } }),
    mk({ type: 'document', domain: 'health', title: 'Exame de sangue — hemograma', date: addDays(T, -20), meta: { issuer: 'Fleury' } }),
    mk({ type: 'document', domain: 'health', title: 'Carteirinha do plano de saúde', meta: { number: '9988776655', issuer: 'Bradesco Saúde' } }),
    mk({ type: 'document', domain: 'health', title: 'Carteirinha de vacinação', meta: { holder: 'Bruno' } }),
    mk({ type: 'document', domain: 'cars', title: 'Apólice do seguro', date: addDays(T, 90), meta: { issuer: 'Porto Seguro', vehicleId: vVolvo } }),
    mk({ type: 'document', domain: 'kids', title: 'Boletim escolar — Dudu', person: 'Eduardo (Dudu)', meta: { personId: pDudu } }),
    mk({ id: vVolvo, type: 'vehicle', domain: 'cars', title: 'Volvo XC60', meta: { make: 'Volvo', model: 'XC60', year: 2023, km: 28450, plate: 'BRA2E19', renavam: '12345678901', color: '#C7CBD1' } }),
    mk({ type: 'maintenance', domain: 'cars', title: 'Revisão de 30.000 km', amount: 1200, date: addDays(T, 3), meta: { vehicleId: vVolvo, workshop: 'Volvo Center', km: 30000, nextKm: 40000 } }),
    mk({ type: 'trip', domain: 'travel', title: 'Férias em Portugal', date: addDays(T, 60), person: 'Carol', meta: { destination: 'Lisboa', endDate: addDays(T, 72), hotel: 'Hotel Avenida Palace', locator: 'PT4X9Z', milestone: true } }),
    mk({ type: 'flight', domain: 'travel', title: 'GRU → LIS', date: addDays(T, 60), time: '22:15', meta: { airline: 'LATAM', flightNumber: 'LA 8084', from: 'GRU', to: 'LIS', seat: '12A', durationMin: 600, locator: 'PT4X9Z' } }),
    mk({ type: 'flight', domain: 'travel', title: 'LIS → GRU', date: addDays(T, 72), time: '11:40', meta: { airline: 'LATAM', flightNumber: 'LA 8085', from: 'LIS', to: 'GRU', seat: '14C', durationMin: 640, locator: 'PT4X9Z' } }),
    mk({ type: 'trip', domain: 'travel', title: 'Rio de Janeiro — reunião', date: addDays(T, 12), time: '07:20', person: 'Ricardo (Chefe)', meta: { destination: 'Rio de Janeiro', endDate: addDays(T, 13), hotel: 'Hotel Fasano Rio', locator: 'RJ2K7', milestone: true } }),
    mk({ type: 'flight', domain: 'travel', title: 'GRU → GIG', date: addDays(T, 12), time: '07:20', meta: { airline: 'GOL', flightNumber: 'G3 1002', from: 'GRU', to: 'GIG', seat: '3C', durationMin: 65, locator: 'RJ2K7' } }),
    mk({ type: 'flight', domain: 'travel', title: 'GIG → GRU', date: addDays(T, 13), time: '20:10', meta: { airline: 'GOL', flightNumber: 'G3 1099', from: 'GIG', to: 'GRU', seat: '1A', durationMin: 65, locator: 'RJ2K7' } }),
    mk({ type: 'gift', domain: 'kids', title: 'Lego Star Wars', person: 'Maria', meta: { personId: pMaria } }),
    mk({ type: 'gift', domain: 'kids', title: 'Tênis Nike', person: 'Eduardo (Dudu)', meta: { personId: pDudu } }),
    mk({ type: 'shopping', domain: 'kids', title: 'Material escolar', person: 'Eduardo (Dudu)', meta: { personId: pDudu } }),
    mk({ type: 'note', domain: 'personal', title: 'Ideias de passeio no fim de semana', notes: 'Parque Ibirapuera, cinema, ou praia se o tempo ajudar.' }),
  ];
}
const SEED_SETTINGS = { health: { [todayISO()]: { readiness: 82, sleep: 76 } }, profile: { weight: 78, height: 180 } };

function AppLockScreen({ lang, onUnlock }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = async () => {
    setBusy(true); setFailed(false);
    const ok = await onUnlock();
    setBusy(false);
    if (!ok) setFailed(true);
  };
  useEffect(() => { attempt(); }, []);
  return (
    <div style={{ background: '#0A0E17', color: '#FFFFFF', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
      <img src="/logo.svg" width={64} height={64} alt="" style={{ borderRadius: 14 }} />
      <Fingerprint size={32} style={{ color: failed ? '#EF4444' : '#94A3B8' }} />
      <button onClick={attempt} disabled={busy} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.08)', color: '#FFFFFF', borderRadius: 999, padding: '11px 22px', fontSize: 13.5, cursor: 'pointer' }}>
        {busy ? (lang === 'pt' ? 'Verificando…' : 'Verifying…') : failed ? (lang === 'pt' ? 'Tentar de novo' : 'Try again') : (lang === 'pt' ? 'Desbloquear' : 'Unlock')}
      </button>
    </div>
  );
}

/* ---------------- App ---------------- */
function App() {
  const [ready, setReady] = useState(false);
  const [wide, setWide] = useState(false);
  // breakpoint extra pra telas grandes (ex: iPad Pro 13" em paisagem, ~1366pt) — usa mais a largura disponível
  // em vez de ficar com a mesma largura de conteúdo de um iPad Mini/Air em paisagem.
  const [xwide, setXwide] = useState(false);
  const [sideEditing, setSideEditing] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = typeof window !== 'undefined' ? window.innerWidth : 0;
      setWide(w >= 900); setXwide(w >= 1180);
    };
    check(); window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState({ lang: 'pt', name: '', health: {}, profile: {}, dock: DEFAULT_DOCK, devices: DEFAULT_DEVICES });
  const [active, setActive] = useState({ screen: 'home', module: null });
  const [detail, setDetail] = useState(null); const [showCapture, setShowCapture] = useState(false); const [showSettings, setShowSettings] = useState(false);
  const [claudeSeed, setClaudeSeed] = useState(null); const [composeSeed, setComposeSeed] = useState(null);
  const [newsData, setNewsData] = useState(null); const [newsLoading, setNewsLoading] = useState(false);
  const [toast, setToast] = useState(null); const [undo, setUndo] = useState(null); const undoRef = useRef();
  const [theme, setThemeState] = useState(_theme); const applyTheme = (name) => { setTheme(name); setThemeState(name); };
  const [ouraByDate, setOuraByDate] = useState({}); const [ouraOn, setOuraOn] = useState(false); const [lastSleep, setLastSleep] = useState(null);
  const [gmail, setGmail] = useState({ loading: true, connected: false, messages: [], error: null });
  const [ticktick, setTicktick] = useState({ loading: true, connected: false, tasks: [], projects: [] });
  const [gEvents, setGEvents] = useState([]); const [gMsgs, setGMsgs] = useState([]);
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const up = () => setIsOnline(true), down = () => setIsOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    // no app nativo, o plugin de rede é mais confiável que os eventos do WebView
    let netHandle;
    if (isNative()) Network.addListener('networkStatusChange', (s) => setIsOnline(!!s.connected)).then((h) => { netHandle = h; }).catch(() => {});
    return () => {
      window.removeEventListener('online', up); window.removeEventListener('offline', down);
      if (netHandle) netHandle.remove();
    };
  }, []);
  useEffect(() => {
    if (!isNative()) return;
    StatusBar.setStyle({ style: StatusBarStyle.Dark }).catch(() => {}); // texto claro, pro fundo escuro do app
    StatusBar.setBackgroundColor({ color: '#0A0E17' }).catch(() => {}); // Android; iOS ignora (barra é sobreposta)
  }, []);
  const lang = settings.lang; const t = makeT(lang);
  const people = items.filter((i) => i.type === 'person');
  const dock = settings.dock && settings.dock.length ? settings.dock : DEFAULT_DOCK;
  // Bloqueio por Face ID/Touch ID (opcional, só no app nativo): tranca ao abrir/voltar do
  // segundo plano; settings.appLock só existe depois que os settings carregam (ready).
  const appLockOn = ready && isNative() && !!settings.appLock;
  const [locked, setLocked] = useState(false);
  // o próprio prompt do Face ID dispara "primeiro plano"/"segundo plano" quando aparece/some —
  // sem essas travas, isso reacionava o bloqueio na hora e criava um loop infinito de Face ID.
  // authBusyRef ignora os eventos que acontecem durante e logo após a autenticação; e mesmo que
  // algum evento escape dessa janela, só trancamos de novo se tivermos visto uma saída real
  // (isActive:false) depois da autenticação — um "voltou" solto, sem uma "saída" real antes, é
  // sempre um eco do próprio prompt, nunca o usuário saindo e voltando pro app de verdade.
  const authBusyRef = useRef(false);
  const wasBackgroundedRef = useRef(false);
  useEffect(() => {
    if (!appLockOn) { setLocked(false); return; }
    setLocked(true);
    wasBackgroundedRef.current = false;
    let handle;
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (authBusyRef.current) return;
      if (!isActive) { wasBackgroundedRef.current = true; return; }
      if (wasBackgroundedRef.current) { wasBackgroundedRef.current = false; setLocked(true); }
    }).then((h) => { handle = h; }).catch(() => {});
    return () => { if (handle) handle.remove(); };
  }, [appLockOn]);
  // Toques nos botões dos widgets de iOS chegam aqui como "lifecontrol://open?action=...":
  // o Capacitor entrega URLs de esquema customizado como o evento "appUrlOpen". Cada ação
  // navega pra tela certa e larga uma flag global de uma vez só (mesmo padrão que
  // window.__lccOpenAccount já usa) pra essa tela abrir seu próprio AddModal já preenchido.
  useEffect(() => {
    if (!isNative()) return;
    let handle;
    CapApp.addListener('appUrlOpen', ({ url }) => {
      let u; try { u = new URL(url); } catch (e) { return; }
      if (u.protocol !== 'lifecontrol:') return;
      const action = u.searchParams.get('action');
      const accountId = u.searchParams.get('accountId');
      if (action === 'addMeal') {
        window.__lccOpenAddMeal = true;
        setActive({ screen: 'diet', module: null });
      } else if (action === 'addExpense') {
        window.__lccOpenAccount = accountId || null;
        window.__lccOpenAddExpense = true;
        setActive({ screen: 'dashboard', module: moduleByKey('finance') });
      } else if (action === 'addPurchase') {
        window.__lccOpenAddPurchase = true;
        window.__lccPurchaseAccountId = accountId || null;
        setActive({ screen: 'dashboard', module: moduleByKey('purchases') });
      } else if (action === 'purchases') {
        setActive({ screen: 'dashboard', module: moduleByKey('purchases') });
      } else {
        setActive({ screen: 'home', module: null });
      }
    }).then((h) => { handle = h; }).catch(() => {});
    return () => { if (handle) handle.remove(); };
  }, []);
  const unlockApp = async () => {
    authBusyRef.current = true;
    wasBackgroundedRef.current = false;
    try { await BiometricAuth.authenticate({ reason: lang === 'pt' ? 'Desbloquear o Life Control' : 'Unlock Life Control', allowDeviceCredential: true }); setLocked(false); return true; }
    catch (e) { return false; }
    finally { setTimeout(() => { authBusyRef.current = false; wasBackgroundedRef.current = false; }, 1200); }
  };
  useEffect(() => { (async () => {
    const s = await loadState();
    if (s.items && s.items.length) setItems(s.items);
    else setItems([]); // comeca vazio: sem dados de exemplo
    // sem nome salvo ainda (usuário novo): usa o e-mail de login como saudação
    // inicial, em vez de um nome fixo — cada um vê o próprio nome, não o de outra pessoa.
    const savedName = s.settings && s.settings.name;
    if (s.settings) setSettings((p) => ({ ...p, ...s.settings, health: s.settings.health || {}, profile: s.settings.profile || {}, dock: s.settings.dock || DEFAULT_DOCK, devices: s.settings.devices || DEFAULT_DEVICES }));
    if (!savedName) {
      try {
        const { data } = await supabase.auth.getSession();
        const email = data && data.session && data.session.user && data.session.user.email;
        const derived = nameFromEmail(email);
        if (derived) setSettings((p) => (p.name ? p : { ...p, name: derived }));
      } catch (e) {}
    }
    setReady(true);
  })(); }, []);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    authFetch('/api/oura').then((r) => r.json()).then((j) => { if (!alive || !j) return; if (j.byDate) { setOuraByDate(j.byDate); setHealth((h) => ({ ...h, ...j.byDate })); } if (j.lastSleep) setLastSleep(j.lastSleep); setOuraOn(!!j.connected); }).catch(() => {});
    loadGmail();
    loadNews();
    authFetch('/api/ticktick').then((r) => r.json()).then((j) => { if (alive && j) setTicktick({ loading: false, connected: !!j.connected, tasks: j.tasks || [], projects: j.projects || [], error: j.error }); }).catch(() => { if (alive) setTicktick((p) => ({ ...p, loading: false })); });
    authFetch('/api/google').then((r) => r.json()).then((j) => {
      if (!alive || !j) return;
      if (Array.isArray(j.events)) setGEvents(j.events);
      if (Array.isArray(j.messages)) setGMsgs(j.messages);
      if (typeof window !== 'undefined') window.__lccGoogleDiag = { calendarsFound: j.calendarsFound, calendarErr: j.calendarErr, connected: j.connected, count: (j.events || []).length };
    }).catch(() => {});
    return () => { alive = false; };
  }, [ready]);
  // Hoje (wide) fica aberta parada na tela o dia todo — atualiza sozinha a cada 10min
  // o que muda com o tempo: saúde (passos), agenda (Google), saldo (itens) e notícias.
  // Clima/câmbio se atualizam por conta própria dentro da própria barra de clima.
  useEffect(() => {
    if (!ready || !wide || active.screen !== 'home') return;
    const id = setInterval(() => {
      authFetch('/api/oura').then((r) => r.json()).then((j) => { if (j) { if (j.byDate) { setOuraByDate(j.byDate); setHealth((h) => ({ ...h, ...j.byDate })); } if (j.lastSleep) setLastSleep(j.lastSleep); setOuraOn(!!j.connected); } }).catch(() => {});
      authFetch('/api/google?ts=' + Date.now()).then((r) => r.json()).then((j) => { if (!j) return; if (Array.isArray(j.events)) setGEvents(j.events); if (Array.isArray(j.messages)) setGMsgs(j.messages); }).catch(() => {});
      loadState().then((s) => { if (s.items) setItems(s.items); }).catch(() => {});
      loadNews(true);
    }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [ready, wide, active.screen]);

  const saveTimer = useRef();
  useEffect(() => {
    if (!ready) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await persistItems(items);
      if (typeof window !== 'undefined' && window.__lccSaveError) setToast('Erro ao salvar: ' + window.__lccSaveError);
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [items, ready]);
  useEffect(() => { if (ready) persistSettings(settings); }, [settings, ready]);

  const loadNews = (force) => {
    if (newsLoading) return;
    if (newsData && !force) return; // ja temos, nao recarrega ao navegar
    setNewsLoading(true);
    authFetch('/api/news' + (force ? '?force=1' : '')).then((r) => r.json())
      .then((j) => { setNewsData(j.items || []); setNewsLoading(false); })
      .catch(() => setNewsLoading(false));
  };
  const reloadTicktick = () => authFetch('/api/ticktick').then((r) => r.json()).then((j) => { if (j) setTicktick({ loading: false, connected: !!j.connected, tasks: j.tasks || [], projects: j.projects || [], error: j.error }); }).catch(() => {});
  const ttComplete = async (task) => {
    setTicktick((p) => ({ ...p, tasks: p.tasks.map((x) => x.id === task.ttId ? { ...x, status: 'done' } : x) }));
    try { await authFetch('/api/ticktick', { method: 'POST', body: JSON.stringify({ op: 'complete', id: task.ttId, projectId: task.ttProject }) }); } catch (e) {}
  };
  const ttCreate = async (payload) => {
    try { await authFetch('/api/ticktick', { method: 'POST', body: JSON.stringify({ op: 'create', ...payload }) }); reloadTicktick(); } catch (e) {}
  };
  const loadGmail = () => {
    setGmail((p) => ({ ...p, loading: true }));
    authFetch('/api/gmail').then((r) => r.json())
      .then((j) => setGmail({ loading: false, connected: !!j.connected, messages: j.messages || [], error: j.error || null }))
      .catch((e) => setGmail({ loading: false, connected: false, messages: [], error: String(e) }));
  };
  const refreshGoogle = () => authFetch('/api/google?ts=' + Date.now()).then((r) => r.json()).then((j) => {
    if (!j) return;
    if (Array.isArray(j.events)) setGEvents(j.events);
    if (Array.isArray(j.messages)) setGMsgs(j.messages);
  }).catch(() => {});
  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 2000); };
  // "salvar para ler depois" — usado tanto na Notícias quanto na Hoje (wide), pra
  // aparecer marcado nos dois lugares e permitir ler mesmo depois do feed rodar.
  const saveNewsItem = (n) => { addItem({ type: 'note', domain: 'personal', title: n.title, notes: (n.summary || '') + '\n\n' + n.link, meta: { link: n.link, source: 'news', theme: n.theme, pub: n.pub, sourceName: n.source } }); flash(lang === 'pt' ? 'Salvo ✓' : 'Saved ✓'); };
  // Avisa se a sincronização de sessão com os widgets falhou (ver syncNativeSession, no topo do
  // arquivo) — sem isso a falha é totalmente silenciosa e só aparece muito depois, no widget.
  useEffect(() => {
    if (isNative() && window.__lccNativeSyncError) {
      const msg = window.__lccNativeSyncError; window.__lccNativeSyncError = null;
      flash((lang === 'pt' ? 'Widgets: ' : 'Widgets: ') + msg);
    }
  }, []);

  // ---- Pull-to-refresh (puxar pra baixo no topo) ----
  const [pull, setPull] = useState(0); const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef({ y0: 0, active: false });
  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const jobs = [refreshGoogle(), loadGmail(), reloadTicktick(), loadNews(true)];
      await Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => {})));
      try { const j = await (await authFetch('/api/oura')).json(); if (j) { if (j.byDate) { setOuraByDate(j.byDate); setHealth((h) => ({ ...h, ...j.byDate })); } if (j.lastSleep) setLastSleep(j.lastSleep); setOuraOn(!!j.connected); } } catch (e) {}
    } finally { setTimeout(() => setRefreshing(false), 300); }
  };
  const scrollTop = () => (window.scrollY || window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0);
  const onTouchStart = (e) => {
    if (scrollTop() <= 2 && !refreshing) { pullRef.current = { y0: e.touches[0].clientY, active: true }; }
  };
  const onTouchMove = (e) => {
    if (!pullRef.current.active) return;
    const dy = e.touches[0].clientY - pullRef.current.y0;
    if (dy > 0 && scrollTop() <= 2) { setPull(Math.min(80, dy * 0.55)); }
    else if (dy < 0) { pullRef.current.active = false; setPull(0); }
  };
  const onTouchEnd = () => {
    if (!pullRef.current.active) return;
    pullRef.current.active = false;
    if (pull > 50) doRefresh();
    setPull(0);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const conn = q.get('conn');
    if (!conn) return;
    const okMsg = conn === 'oura' ? 'Oura conectado ✓' : conn === 'ticktick' ? 'TickTick conectado ✓' : 'Google conectado ✓';
    setToast(q.get('ok') ? okMsg : 'Erro: ' + (q.get('erro') || ''));
    setTimeout(() => setToast(null), 4000);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);
  const persistNow = (next) => { persistItems(next).then(() => { if (typeof window !== 'undefined' && window.__lccSaveError) flash(t('saveError')); }); return next; };
  const addItems = (arr) => {
    const withIds = arr.map((x) => ({ id: uid(), createdAt: Date.now(), status: 'planned', currency: 'BRL', meta: {}, ...x }));
    setItems((p) => persistNow([...withIds, ...p]));
    // qualquer evento/compromisso novo com convidados pendentes já dispara o convite de verdade
    withIds.forEach((it) => maybeSendInvites(it, people, updateItem, lang));
    return withIds;
  };
  const addItem = (x) => addItems([x]);
  const updateItem = (id, patch) => {
    const prev = items.find((i) => i.id === id);
    setItems((p) => persistNow(p.map((i) => (i.id === id ? { ...i, ...patch } : i))));
    // idem quando o item é editado (ex.: adicionou uma pessoa a um compromisso já existente)
    if (prev) maybeSendInvites({ ...prev, ...patch, meta: { ...prev.meta, ...(patch.meta || {}) } }, people, updateItem, lang);
  };
  const toggleTask = (id) => {
    if (String(id).startsWith('tt_')) { const it = ttItems.find((x) => x.id === id); if (it && it.status !== 'done') ttComplete(it); return; }
    const it = items.find((i) => i.id === id);
    setItems((p) => persistNow(p.map((i) => (i.id === id ? { ...i, status: i.status === 'done' ? 'planned' : 'done' } : i))));
    clearTimeout(undoRef.current);
    if (it && it.status !== 'done') { hapticSuccess(); setUndo(id); undoRef.current = setTimeout(() => setUndo(null), 3200); } else setUndo(null);
  };
  const delItem = (id) => { hapticWarning(); setItems((p) => persistNow(p.filter((i) => i.id !== id))); };
  const setHealth = (fn) => setSettings((s) => ({ ...s, health: typeof fn === 'function' ? fn(s.health || {}) : fn }));
  const setHealthSummary = (v) => setSettings((s) => ({ ...s, healthSummary: v }));
  const setDietSummary = (v) => setSettings((s) => ({ ...s, dietSummary: v }));
  const setProfile = (fn) => setSettings((s) => ({ ...s, profile: typeof fn === 'function' ? fn(s.profile || {}) : fn }));
  const addWeight = (kg) => setSettings((s) => {
    const d = todayISO();
    const list = (s.weights || []).filter((x) => x.date !== d).concat([{ date: d, kg }]);
    return { ...s, weights: list.slice(-120), profile: { ...(s.profile || {}), weight: kg } };
  });
  const setDevices = (fn) => setSettings((s) => ({ ...s, devices: typeof fn === 'function' ? fn(s.devices || DEFAULT_DEVICES) : fn }));
  // lista de compras da semana (widget da Hoje, versão wide) — vive em settings, igual pesos/dieta
  const toggleGroceryItem = (id) => setSettings((s) => ({ ...s, groceryList: (s.groceryList || []).map((i) => (i.id === id ? { ...i, checked: !i.checked } : i)) }));
  const removeGroceryItem = (id) => setSettings((s) => ({ ...s, groceryList: (s.groceryList || []).filter((i) => i.id !== id) }));
  const addGroceryItem = (text) => { if (!text || !text.trim()) return; setSettings((s) => ({ ...s, groceryList: [...(s.groceryList || []), { id: uid(), text: text.trim(), checked: false }] })); };
  const setTuyaPrefs = (fn) => setSettings((s) => ({ ...s, tuyaPrefs: typeof fn === 'function' ? fn(s.tuyaPrefs || {}) : fn }));
  const openModuleKey = (key) => setActive({ screen: 'dashboard', module: moduleByKey(key) });
  const openAccount = (accId) => { if (typeof window !== 'undefined') window.__lccOpenAccount = accId; setActive({ screen: 'dashboard', module: moduleByKey('finance') }); };
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? t('goodMorning') : h < 18 ? t('goodAfternoon') : t('goodEvening'); };
  const navTo = (k) => { if (SCREEN_ICONS[k]) setActive({ screen: k, module: k === 'dashboard' ? null : null }); else setActive({ screen: 'dashboard', module: moduleByKey(k) }); };

  // pendências: itens de varreduras de e-mail que esperam uma decisão sua (aceitar/recusar) —
  // cada tela dona da fila (Casa, Viagens, Saúde, Compras) reporta sua contagem aqui, pro sino global
  const [pendingCounts, setPendingCounts] = useState({ house: 0, travel: 0, health: 0, purchases: 0, work: 0 });
  const setPendingCount = (key, n) => setPendingCounts((p) => (p[key] === n ? p : { ...p, [key]: n }));
  const pendingTotal = Object.values(pendingCounts).reduce((a, b) => a + b, 0);
  const [bellOpen, setBellOpen] = useState(false);
  const PENDING_MODULES = { house: 'house', travel: 'travel', health: 'health', purchases: 'shopping', work: 'tasks' };
  const PENDING_LABELS = { house: lang === 'pt' ? 'Casa' : 'House', travel: lang === 'pt' ? 'Viagens' : 'Travel', health: lang === 'pt' ? 'Saúde' : 'Health', purchases: lang === 'pt' ? 'Compras' : 'Purchases', work: lang === 'pt' ? 'Tarefas (Trab)' : 'Tasks (Work)' };
  const NotifBell = ({ small }) => (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setBellOpen((v) => !v)} style={small ? { ...card, padding: 7, color: C.text2, cursor: 'pointer', position: 'relative' } : { background: 'none', border: 'none', color: C.text2, cursor: 'pointer', position: 'relative', display: 'flex' }}>
        <Bell size={small ? 15 : 19} />
        {pendingTotal > 0 && <span style={{ position: 'absolute', top: -3, right: -3, minWidth: 15, height: 15, borderRadius: 999, background: C.rose, color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{pendingTotal}</span>}
      </button>
      {bellOpen && (
        <>
          <div onClick={() => setBellOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 59 }} />
          <div style={{ ...card, position: 'absolute', top: '110%', right: 0, width: 240, padding: 8, zIndex: 60 }}>
            {pendingTotal === 0 ? (
              <div style={{ padding: 10, fontSize: 12.5, color: C.text3, textAlign: 'center' }}>{lang === 'pt' ? 'Nenhuma pendência.' : 'Nothing pending.'}</div>
            ) : Object.entries(pendingCounts).filter(([, n]) => n > 0).map(([k, n]) => (
              <button key={k} onClick={() => { setBellOpen(false); openModuleKey(PENDING_MODULES[k]); }} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 8px', borderRadius: 8, color: C.text }}>
                <span style={{ fontSize: 13 }}>{PENDING_LABELS[k]}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.rose, background: C.rose + '1e', borderRadius: 999, padding: '2px 8px' }}>{n}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  if (!ready) return <div style={{ background: C.bg, color: C.text, height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
    <img className="lcc-pulse" src="/logo.svg" width={56} height={56} alt="" style={{ borderRadius: 12 }} />
    <div style={{ fontSize: 12, color: C.text3, letterSpacing: '.08em', textTransform: 'uppercase' }}>Life in Control</div>
  </div>;
  if (appLockOn && locked) return <AppLockScreen lang={lang} onUnlock={unlockApp} />;

  const ttItems = (ticktick.tasks || []).map((t) => ({
    id: 'tt_' + t.id, ttId: t.id, ttProject: t.projectId, type: 'task', domain: 'personal',
    title: t.title, notes: t.notes, date: t.date, status: t.status,
    priority: t.priority >= 5 ? 1 : t.priority >= 3 ? 2 : 3,
    meta: { external: 'ticktick', project: t.projectName, link: 'https://ticktick.com' },
    _tags: t.tags || [],
  }));
  const allItems = [...items, ...(gEvents || []), ...(gMsgs || []), ...ttItems];
  const mergedHealth = { ...(settings.health || {}), ...ouraByDate };
  const shared = { items: allItems, people, lang, t, toggleTask, onOpen: setDetail, addItem, addItems, updateItem, delItem, flash, setPendingCount };
  const renderModule = (mo) => {
    const back = () => setActive({ screen: 'dashboard', module: null });
    if (mo.custom === 'travel') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><TravelScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'cars') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><CarsScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'people') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><PeopleScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'work') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><WorkScreen module={mo} {...shared} back={back} gmail={gmail} loadGmail={loadGmail} /></ErrorBoundary>;
    if (mo.custom === 'purchases') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><PurchasesScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'finance') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><FinanceScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'health') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><HealthScreen module={mo} {...shared} back={back} health={mergedHealth} setHealth={setHealth} ouraOn={ouraOn} lastSleep={lastSleep} weights={settings.weights || []} addWeight={addWeight} profile={settings.profile || {}} setProfile={setProfile} goMedical={() => setActive({ screen: 'medical', module: null })} goDiet={() => setActive({ screen: 'diet', module: null })} goDocs={() => setActive({ screen: 'healthDocs', module: null })} healthSummary={settings.healthSummary} setHealthSummary={setHealthSummary} /></ErrorBoundary>;
    if (mo.custom === 'house') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><HouseScreen module={mo} {...shared} back={back} devices={settings.devices || DEFAULT_DEVICES} setDevices={setDevices} tuyaPrefs={settings.tuyaPrefs || {}} setTuyaPrefs={setTuyaPrefs} /></ErrorBoundary>;
    if (mo.custom === 'kids') return <KidsScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'docs') return <DocsScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'gmail') return <GmailScreen module={mo} lang={lang} t={t} back={back} state={gmail} setState={setGmail} load={loadGmail} />;
    return <ModuleScreen module={mo} {...shared} back={back} ttConnected={ticktick.connected} ttProjects={ticktick.projects} onCreateTick={ttCreate} reloadTick={reloadTicktick} />;
  };

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} style={{ background: C.bg, color: C.text, minHeight: '100vh', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', maxWidth: wide ? (xwide ? 1440 : 1080) : 480, margin: '0 auto', position: 'relative', paddingBottom: wide ? 24 : 'calc(env(safe-area-inset-bottom, 0px) + 84px)', display: wide ? 'flex' : 'block', gap: wide ? 0 : undefined, alignItems: 'flex-start' }}>
      {wide && (
        <div style={{ width: xwide ? 250 : 226, flexShrink: 0, position: 'sticky', top: 0, height: '100vh', borderRight: `1px solid ${C.borderSoft}`, padding: '18px 12px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '2px 8px 0' }}>
            <button onClick={() => setActive({ screen: 'home', module: null })} style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: 0 }}>
              <span style={{ width: 28, height: 28, borderRadius: 8, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', fontSize: 13, flexShrink: 0 }}>L</span>
              <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '.1px' }}>Life Control</span>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <NotifBell />
              <button onClick={() => setSideEditing((v) => !v)} title={lang === 'pt' ? 'Ordenar atalhos do celular' : 'Reorder phone shortcuts'} style={{ background: 'none', border: 'none', color: sideEditing ? C.accent : C.text3, cursor: 'pointer', display: 'flex', padding: 4 }}>{sideEditing ? <Check size={15} /> : <Pencil size={13} />}</button>
            </div>
          </div>

          {sideEditing ? (
            <DragReorderList orderKeys={dock} onReorder={(next) => setSettings((s) => ({ ...s, dock: next }))} renderItem={(k, idx, handleProps) => {
              const Ic = navIcon(k);
              return (
                <div style={{ background: 'none', display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', borderRadius: 11, fontSize: 14, color: C.text2, border: `1px solid ${C.borderSoft}` }}>
                  <Ic size={19} />{navLabel(k, t)}
                  <div {...handleProps} style={{ ...handleProps.style, marginLeft: 'auto', color: C.text3, padding: 4 }}><GripVertical size={16} /></div>
                </div>
              );
            }} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {WIDE_NAV_GROUPS.map((g) => (
                <div key={g.label.pt}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: C.text3, textTransform: 'uppercase', padding: '0 10px 7px' }}>{lang === 'pt' ? g.label.pt : g.label.en}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {g.keys.map((k) => {
                      const Ic = navIcon(k); const isMod = !SCREEN_ICONS[k];
                      const activeK = isMod ? (active.module && active.module.key === k) : (active.screen === k && (k !== 'dashboard' || !active.module));
                      return (
                        <button key={k} onClick={() => navTo(k)} style={{ background: activeK ? C.accentSoft : 'none', border: 'none', cursor: 'pointer', color: activeK ? C.accent : C.text2, display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 9, fontSize: 13.5, fontWeight: activeK ? 600 : 500, width: '100%', textAlign: 'left' }}>
                          <Ic size={17} />{navLabel(k, t)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ flex: sideEditing ? 1 : undefined }} />

          <button onClick={() => setShowCapture(true)} style={{ background: C.accent, color: '#FFFFFF', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', borderRadius: 12, fontSize: 14, fontWeight: 600, width: '100%' }}><Plus size={18} />{lang === 'pt' ? 'Capturar' : 'Capture'}</button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setSettings((s) => ({ ...s, lang: s.lang === 'pt' ? 'en' : 'pt' }))} style={{ ...card, flex: 1, padding: '8px', color: C.text2, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}><Globe size={13} />{lang.toUpperCase()}</button>
            <button onClick={() => setShowSettings(true)} style={{ ...card, flex: 1, padding: '8px', color: C.text2, cursor: 'pointer', display: 'flex', justifyContent: 'center' }}><Cog size={15} /></button>
          </div>

          <div style={{ borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={() => applyTheme(theme === 'light' ? 'dark' : 'light')} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 10px', borderRadius: 10, border: 'none', background: 'transparent', color: C.text2, fontSize: 13, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              {theme === 'light' ? <Sun size={17} /> : <Moon size={17} />}
              <span>{theme === 'light' ? (lang === 'pt' ? 'Modo escuro' : 'Dark mode') : (lang === 'pt' ? 'Modo claro' : 'Light mode')}</span>
            </button>
            <button onClick={() => setShowSettings(true)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%', fontFamily: 'inherit' }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', background: C.surface2, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 700, color: C.text2, flexShrink: 0 }}>{(settings.name || (lang === 'pt' ? 'V' : 'Y'))[0].toUpperCase()}</span>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{settings.name || (lang === 'pt' ? 'Você' : 'You')}</div>
                <div style={{ fontSize: 11, color: C.text3 }}>{lang === 'pt' ? 'Ajustes' : 'Settings'}</div>
              </span>
            </button>
          </div>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, maxWidth: wide ? (xwide ? 1020 : 720) : undefined, margin: wide ? '0 auto' : undefined, width: '100%' }}>
      {!wide && (
      <div style={{ height: refreshing ? 44 : pull, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: pullRef.current.active ? 'none' : 'height .2s', color: C.text3 }}>
        {(refreshing || pull > 10) && <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12 }}><RefreshCw size={15} className={refreshing ? 'spin' : ''} style={{ transform: refreshing ? 'none' : `rotate(${pull * 4}deg)` }} />{refreshing ? t('refreshing') : (pull > 55 ? t('releaseRefresh') : t('pullRefresh'))}</div>}
      </div>
      )}
      <style>{`.spin{animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}@keyframes pop{0%{transform:scale(.5)}55%{transform:scale(1.18)}100%{transform:scale(1)}}@keyframes slideup{from{transform:translate(-50%,14px);opacity:0}to{transform:translate(-50%,0);opacity:1}} *::-webkit-scrollbar{width:0} input,textarea,select{font-family:inherit} select option{background:${_theme === 'light' ? '#FFFFFF' : '#131B2A'};color:${_theme === 'light' ? '#0F172A' : '#FFFFFF'}}`}</style>
      {!wide && (
      <div style={{ padding: '16px 18px 8px', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={() => setActive({ screen: 'home', module: null })} style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', display: 'flex', alignItems: 'center', gap: 7, padding: 0 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: C.accent }} />Life in Control</button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setSettings((s) => ({ ...s, lang: s.lang === 'pt' ? 'en' : 'pt' }))} style={{ ...card, padding: '5px 10px', color: C.text2, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}><Globe size={13} />{lang.toUpperCase()}</button>
          <NotifBell small />
          <button onClick={() => setShowSettings(true)} style={{ ...card, padding: 7, color: C.text2, cursor: 'pointer' }}><Cog size={15} /></button>
        </div>
      </div>
      )}
      <div style={{ padding: wide ? '24px 24px 40px' : '0 16px' }}>
        {active.screen === 'home' && (wide
          ? <TodayWideScreen {...shared} ttItems={ttItems} news={newsData} newsLoading={newsLoading} onRefreshNews={() => loadNews(true)} greeting={greeting} name={settings.name} addItems={addItems} health={mergedHealth} goModule={openModuleKey} goNews={() => setActive({ screen: 'news', module: null })} goScreen={(s) => setActive({ screen: s, module: null })} todayAccountId={settings.todayAccountId} groceryList={settings.groceryList || []} toggleGroceryItem={toggleGroceryItem} removeGroceryItem={removeGroceryItem} addGroceryItem={addGroceryItem} onSaveNews={saveNewsItem} />
          : <TodayScreen {...shared} ttItems={ttItems} news={newsData} newsLoading={newsLoading} onRefreshNews={() => loadNews(true)} greeting={greeting} name={settings.name} addItems={addItems} health={mergedHealth} setHealth={setHealth} ouraOn={ouraOn} goModule={openModuleKey} openClaude={(q) => setClaudeSeed(q)} goNews={() => setActive({ screen: 'news', module: null })} openAccount={openAccount} todayAccountId={settings.todayAccountId} />
        )}
        {active.screen === 'news' && <NewsScreen lang={lang} t={t} back={() => setActive({ screen: 'home', module: null })}
          news={newsData} loading={newsLoading} onRefresh={() => loadNews(true)}
          savedNews={items.filter((i) => i.type === 'note' && i.meta && i.meta.source === 'news')}
          onSaveItem={saveNewsItem}
          onUnsave={(it) => { if (it && it.id) { delItem(it.id); flash(lang === 'pt' ? 'Removido' : 'Removed'); } }}
          onSendItem={(n) => setComposeSeed({ to: '', subject: n.title, body: (n.summary || n.title) + '\n\n' + n.link })} />}
        {active.screen === 'medical' && <MedicalHistoryScreen items={allItems} people={people} lang={lang} t={t} back={() => setActive({ screen: 'dashboard', module: moduleByKey('health') })} addItem={addItem} updateItem={updateItem} flash={flash} health={mergedHealth} onOpen={setDetail} openClaude={(q) => setClaudeSeed(q)} goIndicatorsFull={() => setActive({ screen: 'indicatorsFull', module: null })} />}
        {active.screen === 'indicatorsFull' && <IndicatorsFullScreen items={allItems} lang={lang} t={t} back={() => setActive({ screen: 'medical', module: null })} />}
        {active.screen === 'diet' && <DietScreen items={allItems} lang={lang} t={t} back={() => setActive({ screen: 'dashboard', module: moduleByKey('health') })} addItem={addItem} delItem={delItem} onOpen={setDetail} flash={flash} dietSummary={settings.dietSummary} setDietSummary={setDietSummary} openClaude={(q) => setClaudeSeed(q)} />}
        {active.screen === 'healthDocs' && <HealthDocsScreen items={allItems} lang={lang} t={t} back={() => setActive({ screen: 'dashboard', module: moduleByKey('health') })} onOpen={setDetail} />}
        {active.screen === 'messages' && <MessagesScreen {...shared} setItems={setItems} />}
        {active.screen === 'calendar' && <CalendarScreen {...shared} onRefresh={() => Promise.all([refreshGoogle(), loadGmail()])} onMount={() => { refreshGoogle(); loadGmail(); }} />}
        {active.screen === 'claude' && <ClaudeScreen items={allItems} lang={lang} t={t} name={settings.name} />}
        {active.screen === 'dashboard' && (active.module ? renderModule(active.module) : <DashboardScreen items={allItems} lang={lang} t={t} gmailCount={gmail.messages.length} open={(mo) => setActive({ screen: 'dashboard', module: mo })} goNews={() => setActive({ screen: 'news', module: null })} order={settings.moduleOrder || []} setOrder={(o) => setSettings((st) => ({ ...st, moduleOrder: o }))} />)}
      </div>
      </div>

      {!wide && active.screen !== 'claude' && (
        <div style={{ position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)', left: 0, right: 0, zIndex: 30, pointerEvents: 'none' }}>
          <div style={{ maxWidth: 480, margin: '0 auto', position: 'relative', height: 0 }}>
            <button onClick={() => { haptic(12); setShowCapture(true); }} style={{ position: 'absolute', right: 18, bottom: 0, pointerEvents: 'auto', background: C.accent, color: '#FFFFFF', border: 'none', width: 52, height: 52, borderRadius: 16, cursor: 'pointer', boxShadow: '0 8px 24px rgba(37,99,235,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={24} /></button>
          </div>
        </div>
      )}

      {!wide && <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: _theme === 'light' ? 'rgba(255,255,255,.92)' : 'rgba(11,11,15,.9)', backdropFilter: 'blur(12px)', borderTop: `1px solid ${C.borderSoft}`, zIndex: 20 }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', justifyContent: 'space-around', padding: '9px 4px 12px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
          {dock.map((k) => {
            const Ic = navIcon(k); const isMod = !SCREEN_ICONS[k];
            const activeK = isMod ? (active.module && active.module.key === k) : (active.screen === k && (k !== 'dashboard' || !active.module));
            const badge = k === 'messages' ? allItems.filter((i) => i.type === 'message' && i.meta && i.meta.unread).length + allItems.filter((i) => i.status === 'inbox').length : 0;
            return <button key={k} onClick={() => { haptic(); navTo(k); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: activeK ? C.accent : C.text3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, position: 'relative', padding: '2px 8px' }}>
              <Ic size={21} /><span style={{ fontSize: 10.5 }}>{navLabel(k, t)}</span>
              {badge > 0 && <span style={{ position: 'absolute', top: -3, right: 4, background: C.rose, color: '#fff', fontSize: 9, borderRadius: 999, minWidth: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{badge}</span>}
            </button>;
          })}
        </div>
      </div>}

      {composeSeed && <GmailCompose lang={lang} t={t} initial={composeSeed} onClose={() => setComposeSeed(null)} />}
      {showCapture && <CaptureSheet lang={lang} t={t} onClose={() => setShowCapture(false)} addItems={addItems} flash={flash} />}
      {showSettings && <SettingsSheet settings={settings} setSettings={setSettings} lang={lang} t={t} items={items} setItems={setItems} theme={theme} applyTheme={applyTheme} onClose={() => setShowSettings(false)} />}
      {detail && <ErrorBoundary fallback={() => <Modal onClose={() => setDetail(null)}><SheetHead title={lang === 'pt' ? 'Erro' : 'Error'} onClose={() => setDetail(null)} icon={AlertTriangle} /><div style={{ ...card, padding: 16, fontSize: 13, color: C.text2 }}>{lang === 'pt' ? 'Não consegui abrir este item. Tente novamente ou edite-o pela lista.' : "Couldn't open this item."}</div></Modal>}><ItemDetail item={detail} lang={lang} t={t} people={people} onClose={() => setDetail(null)} onSave={updateItem} onDelete={delItem} onAct={(patch) => { updateItem(detail.id, patch); setDetail((d) => ({ ...d, ...patch, meta: { ...(d.meta || {}), ...(patch.meta || {}) } })); }} allItems={allItems} addItem={addItem} /></ErrorBoundary>}
      {undo && <div style={{ position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)', background: C.surface2, border: `1px solid ${C.border}`, color: C.text, padding: '8px 10px 8px 16px', borderRadius: 999, fontSize: 13, zIndex: 60, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 12, animation: 'slideup .2s ease' }}><span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><CircleCheck size={15} style={{ color: C.green }} />{t('doneLabel')}</span><button onClick={() => toggleTask(undo)} style={{ background: 'none', border: 'none', color: C.accent, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>{t('undo')}</button></div>}
      {claudeSeed && <ClaudeOverlay seed={claudeSeed} onClose={() => setClaudeSeed(null)} items={allItems} lang={lang} t={t} name={settings.name} />}
      {toast && <div style={{ position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)', maxWidth: 'calc(100vw - 32px)', width: 'max-content', background: C.surface2, border: `1px solid ${C.border}`, color: C.text, padding: '9px 16px', borderRadius: 16, fontSize: 13, lineHeight: 1.4, textAlign: 'center', zIndex: 60, whiteSpace: 'normal', wordBreak: 'break-word' }}>{toast}</div>}
      {!isOnline && <div style={{ position: 'fixed', top: 0, left: 0, right: 0, background: C.sky, color: '#1A1200', textAlign: 'center', fontSize: 11.5, fontWeight: 600, padding: '6px 10px', zIndex: 90 }}>{lang === 'pt' ? 'Offline — vendo dados salvos no aparelho; alterações sincronizam ao reconectar' : 'Offline — showing data saved on this device; changes sync once back online'}</div>}
    </div>
  );
}


/* ============================================================
   Porta de entrada: login -> app
   ============================================================ */
export default function Page() {
  const [session, setSession] = useState(null);
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    installStorage();
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => {});
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setBooted(true); syncNativeSession(data.session); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { kvCache.clear(); setSession(s); syncNativeSession(s); });
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!booted) return <div style={{ background: '#0A0E17', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
    <img className="lcc-pulse" src="/logo.svg" width={56} height={56} alt="" style={{ borderRadius: 12 }} />
    <div style={{ fontSize: 12, color: '#94A3B8', letterSpacing: '.08em', textTransform: 'uppercase' }}>Life in Control</div>
  </div>;
  if (!session) return <Login />;
  return <App />;
}
