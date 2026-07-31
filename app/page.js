'use client';
import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

/* ============================================================
   Supabase (cliente)
   ============================================================ */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

/* ============================================================
   Armazenamento: window.storage apontando para o Supabase
   (mantem a interface que o app ja usa)
   ============================================================ */
const kvCache = new Map();
async function currentUid() {
  const { data } = await supabase.auth.getUser();
  return data && data.user ? data.user.id : null;
}
function installStorage() {
  if (typeof window === 'undefined') return;
  window.storage = {
    async get(key) {
      if (kvCache.has(key)) return { key, value: kvCache.get(key) };
      const user_id = await currentUid(); if (!user_id) return null;
      const { data, error } = await supabase.from('kv').select('value').eq('user_id', user_id).eq('key', key).maybeSingle();
      if (error || !data) return null;
      kvCache.set(key, data.value);
      return { key, value: data.value };
    },
    async set(key, value) {
      const user_id = await currentUid(); if (!user_id) return null;
      kvCache.set(key, value);
      const { error } = await supabase.from('kv').upsert({ user_id, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
      if (error) {
        console.error('storage.set', key, error);
        if (typeof window !== 'undefined') window.__lccSaveError = (error.message || String(error));
        return null;
      }
      if (typeof window !== 'undefined') window.__lccSaveError = null;
      return { key, value };
    },
    async delete(key) {
      const user_id = await currentUid(); if (!user_id) return null;
      kvCache.delete(key);
      await supabase.from('kv').delete().eq('user_id', user_id).eq('key', key);
      return { key, deleted: true };
    },
    async list(prefix = '') {
      const user_id = await currentUid(); if (!user_id) return { keys: [], prefix };
      const { data, error } = await supabase.from('kv').select('key').eq('user_id', user_id).like('key', prefix + '%');
      if (error || !data) return { keys: [], prefix };
      return { keys: data.map((r) => r.key), prefix };
    },
  };
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
  const { data: sess } = await supabase.auth.getSession();
  const token = sess && sess.session ? sess.session.access_token : '';
  return fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
}

/* ============================================================
   Login (e-mail + senha)
   ============================================================ */

const LC = { bg: '#0B0B0F', surface: '#16161E', border: '#282833', text: '#ECECEF', text3: '#63636F', accent: '#E6B450' };

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
          <span style={{ fontSize: 17, fontWeight: 700 }}>Life Control</span>
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
          style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: 'none', background: LC.accent, color: '#171200', fontWeight: 600, fontSize: 15, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Aguarde…' : mode === 'up' ? 'Criar conta' : 'Entrar'}
        </button>

        <button onClick={() => { setMode(mode === 'up' ? 'in' : 'up'); setErr(''); setMsg(''); }}
          style={{ width: '100%', marginTop: 10, padding: '10px', borderRadius: 12, background: 'transparent', border: `1px solid ${LC.border}`, color: LC.text3, fontSize: 13, cursor: 'pointer' }}>
          {mode === 'up' ? 'Já tenho conta — entrar' : 'Primeira vez — criar conta'}
        </button>

        {err && <div style={{ color: '#F0787C', fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>{err}</div>}
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
  MapPin, Building2, Pencil, Tv, Radio
} from 'lucide-react';

/* ---------------- palette ---------------- */
const C = {
  bg: '#08080C', bg2: '#12121B', surface: '#1A1A25', surface2: '#24242F',
  border: '#353543', borderSoft: '#2A2A36',
  text: '#F7F7FA', text2: '#B8B8C6', text3: '#8A8A99',
  accent: '#F5C263', accentSoft: 'rgba(245,194,99,0.16)',
  rose: '#FF8A8E', green: '#6FD9A4', blue: '#7FBAF5', violet: '#B0A2FF',
  teal: '#6ECDCD', sky: '#8FCFF7',
};

/* ---------------- i18n ---------------- */
const L = (pt, en) => ({ pt, en });
const S = {
  goodMorning: L('Bom dia', 'Good morning'), goodAfternoon: L('Boa tarde', 'Good afternoon'), goodEvening: L('Boa noite', 'Good evening'),
  capturePh: L('O que precisa entrar? Uma tarefa, gasto, evento, ideia…', 'What needs to go in? A task, expense, event, idea…'),
  interpret: L('Interpretar', 'Interpret'), thinking: L('Pensando…', 'Thinking…'), save: L('Salvar', 'Save'), confirm: L('Confirmar', 'Confirm'),
  toInbox: L('Guardar', 'Save'), discard: L('Descartar', 'Discard'), cancel: L('Cancelar', 'Cancel'),
  delete: L('Excluir', 'Delete'), edit: L('Editar', 'Edit'), resolve: L('Resolver', 'Resolve'),
  attention: L('Precisa da sua atenção', 'Needs your attention'), todayPlan: L('O que vai rolar hoje', "Today's plan"),
  longTerm: L('Longo prazo', 'Long term'), nothingToday: L('Nenhum compromisso à frente hoje.', 'Nothing left today.'),
  noAttention: L('Nada urgente agora.', 'Nothing urgent right now.'), noLongTerm: L('Nada marcado à frente.', 'Nothing ahead yet.'),
  home: L('Hoje', 'Today'), messages: L('Mensagens', 'Messages'), calendar: L('Calendário', 'Calendar'),
  dashboard: L('Painel de Controle', 'Dashboard'), dashShort: L('Painel', 'Dashboard'), claude: L('Claude', 'Claude'),
  tasks: L('Tarefas', 'Tasks'), health: L('Saúde', 'Health'), house: L('Casa', 'Home'), finance: L('Finanças', 'Finance'), kids: L('Filhos', 'Kids'),
  people: L('Pessoas', 'People'), docs: L('Documentos', 'Documents'), cars: L('Carros', 'Cars'), travel: L('Viagens', 'Travel'),
  readiness: L('Prontidão', 'Readiness'), sleepScore: L('Sono', 'Sleep'),
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
  pullRefresh: L('Puxe para atualizar', 'Pull to refresh'), releaseRefresh: L('Solte para atualizar', 'Release to refresh'), refreshing: L('Atualizando…', 'Refreshing…'),
  openRemote: L('Abrir controle', 'Open remote'), brightness: L('Brilho', 'Brightness'), color: L('Cor', 'Color'), whiteLight: L('Luz branca', 'White'), turnOff: L('Desligar', 'Turn off'),
  acMode: L('Modo', 'Mode'), cold: L('Frio', 'Cool'), hot: L('Quente', 'Heat'), fan: L('Ventilar', 'Fan'), fanSpeed: L('Velocidade', 'Fan speed'),
  power: L('Liga/Desliga', 'Power'), volume: L('Volume', 'Volume'), input: L('Entrada', 'Input'), changeInput: L('Trocar', 'Switch'), back: L('Voltar', 'Back'),
  irNote: L('Comandos por infravermelho. Se algum botão não responder, me diga qual — ajusto o código dele.', 'IR commands. If a button does not respond, tell me which one.'),
  screenError: L('Algo deu errado nesta tela', 'Something went wrong on this screen'),
  screenErrorHint: L('O resto do app continua funcionando. Tente voltar e abrir de novo.', 'The rest of the app still works. Go back and reopen.'),
  composeNew: L('Escrever e-mail', 'Compose'), toField: L('Para', 'To'), subjectField: L('Assunto', 'Subject'),
  emailBody: L('Mensagem', 'Message'), sendingE: L('Enviando…', 'Sending…'), saveError: L('Erro ao salvar. Tente de novo.', 'Save failed. Try again.'),
  externalItem: L('Item externo — edite no app de origem.', 'External item — edit in the source app.'),
  openThere: L('Abrir no app de origem', 'Open in source app'),
  onlyCommitments: L('Compromissos', 'Commitments'), everything: L('Tudo', 'Everything'),
  exams: L('Últimos exames', 'Recent exams'), support: L('Suporte (carteirinhas, vacinação)', 'Support (cards, vaccination)'),
  myKids: L('Minha prole', 'My kids'),
  company: L('Empresa', 'Company'), address: L('Endereço', 'Address'), contact: L('Contato', 'Contact'),
  routeMapNote: L('Exemplo com suas viagens cadastradas — aeroportos conhecidos são plotados.', 'Example from your saved trips — known airports are plotted.'),
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
  t_task: L('Tarefa', 'Task'), t_event: L('Evento', 'Event'), t_expense: L('Gasto', 'Expense'), t_meal: L('Refeição', 'Meal'),
  t_med: L('Medicação', 'Medication'), t_appointment: L('Consulta', 'Appointment'), t_document: L('Documento', 'Document'),
  t_vehicle: L('Veículo', 'Vehicle'), t_trip: L('Viagem', 'Trip'), t_flight: L('Voo', 'Flight'), t_shopping: L('Compra', 'Shopping'),
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
  fAll: L('Todos', 'All'), fWork: L('Trabalho', 'Work'), fPersonal: L('Pessoal', 'Personal'), fKids: L('Filhos', 'Kids'), fHouse: L('Casa', 'Home'), fHealth: L('Saúde', 'Health'),
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
  // kids
  school: L('Escola', 'School'), gifts: L('Presentes', 'Gifts'), agenda: L('Agenda', 'Agenda'),
  markKidHint: L('Cadastre em Pessoas com relação "Filho" ou "Filha" para aparecer aqui.', 'Add in People with relationship "Son"/"Daughter" to show here.'),
  // ticktick
  tickHint: L('Estruturado para sincronizar com o TickTick (mão dupla) quando ligarmos a integração.', 'Structured to sync with TickTick (two-way) once we wire it.'),
};
function makeT(lang) { return (k) => (S[k] ? S[k][lang] : k); }

const META = {
  flight: [['airline', 'Companhia', 'Airline'], ['flightNumber', 'Nº do voo', 'Flight #'], ['from', 'Origem', 'From'], ['to', 'Destino', 'To'], ['seat', 'Assento', 'Seat'], ['locator', 'Localizador', 'Locator'], ['aircraft', 'Aeronave', 'Aircraft'], ['durationMin', 'Duração (min)', 'Duration (min)', 'number']],
  trip: [['destination', 'Destino', 'Destination'], ['endDate', 'Volta', 'Return', 'date'], ['locator', 'Reserva', 'Booking'], ['hotel', 'Hotel', 'Hotel']],
  vehicle: [['make', 'Montadora', 'Make'], ['model', 'Modelo', 'Model'], ['year', 'Ano', 'Year', 'number'], ['km', 'KM', 'Odometer', 'number']],
  document: [['number', 'Número', 'Number'], ['issuer', 'Emissor', 'Issuer'], ['holder', 'Titular', 'Holder']],
  med: [['dose', 'Dose', 'Dose'], ['frequency', 'Frequência', 'Frequency']],
  appointment: [['doctor', 'Médico', 'Doctor'], ['specialty', 'Especialidade', 'Specialty'], ['location', 'Local', 'Location']],
  bill: [['payee', 'Beneficiário', 'Payee']],
  maintenance: [['workshop', 'Oficina', 'Workshop'], ['km', 'KM', 'Odometer', 'number'], ['nextKm', 'Próx. revisão (km)', 'Next service (km)', 'number']],
  person: [['relationship', 'Relação', 'Relationship'], ['role', 'Papel', 'Role'], ['company', 'Empresa', 'Company'], ['phone', 'Telefone', 'Phone'], ['email', 'E-mail', 'Email'], ['address', 'Endereço', 'Address'], ['birthdate', 'Nascimento', 'Birthdate', 'date']],
  account: [['institution', 'Instituição', 'Institution'], ['balance', 'Saldo atual', 'Current balance', 'number']],
  message: [['sender', 'Remetente', 'Sender']],
  income: [['source', 'Origem', 'Source']],
};

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
function fmtMoney(n, lang) { if (n == null || isNaN(n)) return ''; return new Intl.NumberFormat(loc(lang), { style: 'currency', currency: 'BRL' }).format(n); }
const TYPES = ['task', 'event', 'expense', 'income', 'meal', 'med', 'appointment', 'document', 'vehicle', 'maintenance', 'trip', 'flight', 'shopping', 'bill', 'note', 'person', 'account', 'message', 'gift'];
const DOMAINS = ['personal', 'today', 'health', 'home', 'finance', 'kids', 'docs', 'cars', 'travel', 'work'];
const isMoney = (ty) => ty === 'expense' || ty === 'income' || ty === 'bill' || ty === 'maintenance';
const CATEGORIES = {
  alimentacao: { pt: 'Alimentação', en: 'Food', icon: Utensils, color: '#5FBF8F' },
  transporte: { pt: 'Transporte', en: 'Transport', icon: Car, color: '#6BA6E6' },
  casa: { pt: 'Moradia', en: 'Home', icon: Home, color: '#5FB3B3' },
  saude: { pt: 'Saúde', en: 'Health', icon: Heart, color: '#F0787C' },
  educacao: { pt: 'Educação', en: 'Education', icon: GraduationCap, color: '#9B8CF0' },
  lazer: { pt: 'Lazer', en: 'Leisure', icon: Ticket, color: '#E6B450' },
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
const TUYA_SEED = {
  'ebd25cb250d51d988bfmgd': { show: true, alias: 'Abajur Carol', room: 'Suíte', kind: 'light' },
  'ebce584d586201f762d4ag': { show: true, alias: 'Subwoofer', room: 'Home-office', kind: 'plug' },
  'ebbc591b7da959062dm9im': { show: true, alias: 'TV Suíte', room: 'Suíte', kind: 'tv' },
  'eb35a5d8aab7cb6a92jpzr': { show: true, alias: 'Vivo Suíte', room: 'Suíte', kind: 'stb' },
  'eb8629b8368eb1b1cfnhnm': { show: true, alias: 'Ar Brinquedoteca', room: 'Quarto Maria', kind: 'ac' },
  'ebce4627183df11fbewuyh': { show: true, alias: 'Ar Dudu', room: 'Quarto Dudu', kind: 'ac' },
  '467308739c9c1f859136': { show: true, alias: 'Cervejeira', room: 'Área', kind: 'plug' },
  'eb9d5c2de5306c1e93f0rp': { show: true, alias: 'Receiver', room: 'Sala de TV', kind: 'receiver' },
  'eb1312396be3adad2fklrm': { show: true, alias: 'TV Sala', room: 'Sala de TV', kind: 'tv' },
  'eb2a81eee50d3a40e7hwjo': { show: true, alias: 'Vivo Sala', room: 'Sala de TV', kind: 'stb' },
  'ebd58a13d5c1084fb1faaf': { show: true, alias: 'Ar Sala', room: 'Sala de TV', kind: 'ac' },
};
const APP_VERSION = 'v16 · 31jul';
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
  const res = await fetch('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages }) });
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
async function classifyCapture(raw, lang) {
  const langName = lang === 'pt' ? 'Brazilian Portuguese' : 'US English';
  const system = `You are the capture classifier for a personal life app. Convert the raw note into one or more items, splitting compound notes. Output ONLY a JSON array — no prose, no fences. Each item: {"type": one of [task,event,expense,meal,med,appointment,document,trip,flight,shopping,bill,note], "domain": one of [${DOMAINS.join(',')}], "title": short title in ${langName}, "date":"YYYY-MM-DD" or null, "time":"HH:MM" or null, "amount": number or null, "person": string or null, "priority":1|2|3, "confidence":0..1}. Today is ${todayISO()}. Resolve relative dates. If unsure, type "note", domain "personal".`;
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
  const open = items.filter((i) => i.type === 'task' && i.status !== 'done').slice(0, 30).map((i) => ({ title: i.title, due: i.date, priority: i.priority, area: i.domain }));
  const events = items.filter((i) => i.date && ['event', 'appointment', 'trip', 'flight'].includes(i.type)).slice(0, 25).map((i) => ({ title: i.title, date: i.date, area: i.domain }));
  const exp = items.filter((i) => i.type === 'expense' && i.amount); const month = todayISO().slice(0, 7);
  return { today: todayISO(), openTasks: open, events, monthSpendBRL: exp.filter((i) => (i.date || '').startsWith(month)).reduce((a, b) => a + b.amount, 0) };
}

/* ---------------- primitives ---------------- */
const card = { background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 16, boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset' };
const inputStyle = { width: '100%', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, padding: '10px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box' };
function Btn({ children, onClick, kind = 'primary', style, disabled }) {
  const kinds = { primary: { background: C.accent, color: '#171200', border: 'none', fontWeight: 600 }, ghost: { background: 'transparent', color: C.text2, border: `1px solid ${C.border}` }, soft: { background: C.surface2, color: C.text, border: `1px solid ${C.border}` }, danger: { background: 'transparent', color: C.rose, border: `1px solid ${C.rose}55` } };
  return <button onClick={onClick} disabled={disabled} style={{ padding: '10px 14px', borderRadius: 12, fontSize: 14, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, ...kinds[kind], ...style }}>{children}</button>;
}
function Chip({ children, active, onClick, color }) {
  return <button onClick={onClick} style={{ padding: '6px 11px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap', background: active ? (color ? color + '22' : C.accentSoft) : 'transparent', color: active ? (color || C.accent) : C.text2, border: `1px solid ${active ? (color || C.accent) + '55' : C.border}` }}>{children}</button>;
}
function Field({ label, children }) {
  return <label style={{ display: 'block', marginBottom: 10 }}><div style={{ fontSize: 11.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5, fontWeight: 600 }}>{label}</div>{children}</label>;
}
function Empty({ icon: Icon, text }) {
  return <div style={{ ...card, padding: '26px 18px', textAlign: 'center', color: C.text3 }}>{Icon && <Icon size={22} style={{ opacity: 0.6, marginBottom: 8 }} />}<div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{text}</div></div>;
}
function Modal({ children, onClose }) {
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50 }}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, border: `1px solid ${C.border}`, borderBottom: 'none', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', padding: 18, boxSizing: 'border-box' }}>{children}</div>
  </div>;
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
function MiniStat({ label, value, color, small }) {
  return <div style={{ ...card, padding: '10px 12px', flex: 1, minWidth: 0 }}>
    <div style={{ fontSize: small ? 15 : 19, fontWeight: 700, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    <div style={{ fontSize: 10.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 2, fontWeight: 600 }}>{label}</div>
  </div>;
}
function HintCard({ icon: Icon, text }) {
  return <div style={{ ...card, padding: 12, marginBottom: 10, display: 'flex', gap: 9, alignItems: 'flex-start', background: C.bg2 }}><Icon size={14} style={{ color: C.text3, marginTop: 1, flexShrink: 0 }} /><div style={{ fontSize: 11.5, color: C.text3, lineHeight: 1.5 }}>{text}</div></div>;
}
function typeIcon(type) {
  const m = { task: ListTodo, event: CalIcon, expense: Wallet, income: TrendingUp, meal: Utensils, med: Pill, appointment: Stethoscope, document: FileText, vehicle: Car, maintenance: Wrench, trip: Plane, flight: Plane, shopping: ShoppingCart, bill: Wallet, note: FileText, person: UserRound, account: CreditCard, message: MessageSquare, gift: Gift };
  return m[type] || FileText;
}
function ItemRow({ item, lang, t, onToggle, onOpen }) {
  const overdue = item.type === 'task' && item.status !== 'done' && item.date && item.date < todayISO();
  const Ic = typeIcon(item.type); const mile = item.meta && item.meta.milestone;
  return (
    <div onClick={() => onOpen(item)} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8, cursor: 'pointer' }}>
      {item.type === 'task' ? (
        <button onClick={(e) => { e.stopPropagation(); onToggle(item.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 1, color: item.status === 'done' ? C.green : C.text3 }}>{item.status === 'done' ? <CircleCheck size={20} style={{ animation: 'pop .32s ease' }} /> : <Circle size={20} />}</button>
      ) : <div style={{ marginTop: 2, color: mile ? C.accent : C.text3 }}><Ic size={18} /></div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 500, color: item.status === 'done' ? C.text3 : C.text, textDecoration: item.status === 'done' ? 'line-through' : 'none', lineHeight: 1.35, display: 'flex', gap: 6, alignItems: 'center' }}>{mile && <Star size={12} style={{ color: C.accent, flexShrink: 0 }} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: C.text2, fontWeight: 500 }}>{t('t_' + item.type)}</span>
          {item.date && <span style={{ fontSize: 11.5, color: overdue ? C.rose : C.text2, display: 'inline-flex', alignItems: 'center', gap: 3 }}>{overdue ? <AlertTriangle size={11} /> : <Clock size={11} />}{fmtDate(item.date, lang)}{item.time ? ' · ' + item.time : ''}</span>}
          {item.amount != null && <span style={{ fontSize: 11.5, color: C.green }}>{fmtMoney(item.amount, lang)}</span>}
          {item.person && <span style={{ fontSize: 11.5, color: C.text3 }}>· {item.person}</span>}
          {item.meta && item.meta.attachments && item.meta.attachments.length > 0 && <Paperclip size={11} style={{ color: C.text3 }} />}
          {item.priority === 1 && item.status !== 'done' && <span style={{ fontSize: 10.5, color: C.accent, border: `1px solid ${C.accent}44`, borderRadius: 999, padding: '1px 7px' }}>{t('high')}</span>}
          {item.meta && item.meta.external === 'google' && <span style={{ fontSize: 10, color: C.blue, border: `1px solid ${C.blue}44`, borderRadius: 999, padding: '1px 7px' }}>Google</span>}
        </div>
      </div>
      <ChevronRight size={16} style={{ color: C.text3, marginTop: 2 }} />
    </div>
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
function Attachments({ list, lang, t, onAdd, onRemove }) {
  const ref = useRef(); const [busy, setBusy] = useState(false);
  const pick = async (e) => { const f = e.target.files[0]; if (!f) return; setBusy(true);
    try { const url = await fileToDataUrl(f); const att = await saveAttachment(url, f.name, f.type.startsWith('image/') ? 'image' : 'pdf'); if (att) onAdd(att); } catch (err) {}
    setBusy(false); e.target.value = ''; };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{t('attachments')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {(list || []).map((a) => <AttachThumb key={a.id} att={a} onRemove={onRemove} />)}
        <button onClick={() => ref.current && ref.current.click()} style={{ width: 66, height: 66, borderRadius: 10, border: `1px dashed ${C.border}`, background: 'transparent', color: C.text3, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10 }}>{busy ? <Loader2 size={18} className="spin" /> : <><Paperclip size={16} />{t('addFile')}</>}</button>
        <input ref={ref} type="file" accept="image/*,application/pdf" onChange={pick} style={{ display: 'none' }} />
      </div>
    </div>
  );
}

/* ---------------- photo avatar ---------------- */
function PhotoPicker({ value, t, onChange }) {
  const ref = useRef(); const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const f = e.target.files[0]; if (!f) return; setBusy(true);
    try { const url = await fileToDataUrl(f, 600); const att = await saveAttachment(url, f.name, 'image'); if (att) onChange(att); } catch (err) {}
    setBusy(false); e.target.value = '';
  };
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {value ? <AttachThumb att={value} onRemove={() => onChange(null)} />
        : <button onClick={() => ref.current && ref.current.click()} style={{ width: 66, height: 66, borderRadius: 999, border: `1px dashed ${C.border}`, background: 'transparent', color: C.text3, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10 }}>{busy ? <Loader2 size={16} className="spin" /> : <><Camera size={16} />{t('addPhoto')}</>}</button>}
      <input ref={ref} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
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
function ItemForm({ draft, allowedTypes, lang, t, people = [], accounts = [], onSave, onCancel, onDelete }) {
  const [f, setF] = useState({ priority: 2, status: 'planned', ...draft, meta: { ...(draft.meta || {}) } });
  const [fcode, setFcode] = useState('');
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
  const doResolve = () => { const r = resolveFlight(fcode); if (r) upMeta({ airline: r.airline, flightNumber: r.flightNumber }); };
  return (
    <div>
      {allowedTypes.length > 1 && <Field label={t('type')}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{allowedTypes.map((ty) => <Chip key={ty} active={type === ty} onClick={() => up({ type: ty })}>{t('t_' + ty)}</Chip>)}</div></Field>}
      {type === 'flight' && (
        <div style={{ ...card, padding: 12, marginBottom: 12, background: C.bg2 }}>
          <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{t('flightCode')}</div>
          <div style={{ display: 'flex', gap: 8 }}><input value={fcode} onChange={(e) => setFcode(e.target.value)} placeholder="LA 3414" style={inputStyle} /><Btn kind="soft" onClick={doResolve}>{t('resolve')}</Btn></div>
          <div style={{ fontSize: 11, color: C.text3, marginTop: 7, lineHeight: 1.45 }}>{t('flightHint')}</div>
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
      {['expense', 'income', 'bill'].includes(type) && (
        <>
          {accounts.length > 0 && <Field label={t('accountL')}><select value={f.meta.accountId || ''} onChange={(e) => upMeta({ accountId: e.target.value || null })} style={{ ...inputStyle, colorScheme: 'dark' }}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</select></Field>}
          <Field label={t('categoryL')}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{CAT_KEYS.filter((k) => type === 'income' ? ['salario', 'investimento', 'outros'].includes(k) : k !== 'salario').map((k) => { const cc = CATEGORIES[k]; return <Chip key={k} active={(f.meta.category || deriveCat(f)) === k} onClick={() => upMeta({ category: k })} color={cc.color}>{cc[lang]}</Chip>; })}</div></Field>
        </>
      )}
      <Field label={type === 'person' ? t('name') : type === 'message' ? t('title') : t('title')}><input value={f.title || ''} onChange={(e) => up({ title: e.target.value })} style={inputStyle} placeholder={type === 'flight' ? 'GRU → LIS' : ''} /></Field>
      {!['person', 'account', 'message'].includes(type) && (
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><Field label={t('date')}><input type="date" value={f.date || ''} onChange={(e) => up({ date: e.target.value || null })} style={{ ...inputStyle, colorScheme: 'dark' }} /></Field></div>
          <div style={{ flex: 1 }}><Field label={t('time')}><input type="time" value={f.time || ''} onChange={(e) => up({ time: e.target.value || null })} style={{ ...inputStyle, colorScheme: 'dark' }} /></Field></div>
        </div>
      )}
      {isMoney(type) && <Field label={type === 'maintenance' ? t('cost') : t('amount')}><input type="number" value={f.amount ?? ''} onChange={(e) => up({ amount: e.target.value })} style={inputStyle} placeholder="0,00" /></Field>}
      {metaFields.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {metaFields.map(([k, ptL, enL, it]) => <div key={k} style={{ gridColumn: type === 'message' ? '1 / -1' : 'auto' }}><Field label={lang === 'pt' ? ptL : enL}><input type={it === 'number' ? 'number' : it === 'date' ? 'date' : 'text'} value={f.meta[k] ?? ''} onChange={(e) => upMeta({ [k]: e.target.value })} style={{ ...inputStyle, colorScheme: 'dark' }} /></Field></div>)}
        </div>
      )}
      {(type === 'person' || type === 'vehicle') && (
        <Field label={t('photo')}>
          <PhotoPicker value={f.meta.photo} t={t} onChange={(att) => upMeta({ photo: att })} />
        </Field>
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
          <span style={{ fontSize: 13.5 }}>{t('important')}</span>
        </label>
      )}
      {!['note', 'person', 'account', 'vehicle', 'message'].includes(type) && (
        <Field label={t('person')}>
          <input list="lcc-people" value={f.person || ''} onChange={(e) => up({ person: e.target.value || null })} style={inputStyle} />
          <datalist id="lcc-people">{people.map((p) => <option key={p.id} value={p.title} />)}</datalist>
        </Field>
      )}
      <Field label={type === 'message' ? t('body') : t('notes')}><textarea value={f.notes || ''} onChange={(e) => up({ notes: e.target.value })} rows={type === 'message' ? 3 : 2} style={{ ...inputStyle, resize: 'none' }} /></Field>
      <Attachments list={attList} lang={lang} t={t} onAdd={(a) => upMeta({ attachments: [...attList, a] })} onRemove={(id) => upMeta({ attachments: attList.filter((x) => x.id !== id) })} />
      {onDelete && f.type === 'task' && <Btn kind="soft" onClick={() => up({ status: f.status === 'done' ? 'planned' : 'done' })} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}>{f.status === 'done' ? <><Circle size={15} />{t('markUndone')}</> : <><CircleCheck size={15} />{t('markDone')}</>}</Btn>}
      <div style={{ display: 'flex', gap: 8 }}>
        {onDelete && <Btn kind="danger" onClick={onDelete}><Trash2 size={15} /></Btn>}
        <Btn kind="ghost" onClick={onCancel} style={{ flex: 1 }}>{t('cancel')}</Btn>
        <Btn onClick={doSave} disabled={!canSave} style={{ flex: 1.4 }}>{t('save')}</Btn>
      </div>
    </div>
  );
}
function AddModal({ title, icon, draft, allowedTypes, lang, t, people, accounts = [], onClose, onSave }) {
  return <Modal onClose={onClose}><SheetHead title={title} onClose={onClose} icon={icon} /><ItemForm draft={draft} allowedTypes={allowedTypes} lang={lang} t={t} people={people} accounts={accounts} onCancel={onClose} onSave={onSave} /></Modal>;
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
function QuickCapture({ lang, t, addItems, flash }) {
  const [text, setText] = useState(''); const [loading, setLoading] = useState(false); const [drafts, setDrafts] = useState(null);
  const run = async () => { if (!text.trim()) return; setLoading(true);
    try { setDrafts(await classifyCapture(text.trim(), lang)); } catch (e) { addItems([{ type: 'note', domain: 'personal', title: text.trim(), priority: 3, status: 'inbox' }]); flash(t('couldntParse')); setText(''); }
    setLoading(false); };
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ ...card, padding: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('capturePh')} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} style={{ ...inputStyle, background: 'transparent', border: 'none' }} />
        <Btn onClick={run} disabled={loading || !text.trim()} style={{ padding: '9px 13px' }}>{loading ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}</Btn>
      </div>
      {drafts && <DraftReview drafts={drafts} lang={lang} t={t} onDone={(arr, status) => { if (arr.length) addItems(arr.map((x) => ({ ...x, status }))); flash(arr.length + ' ✓'); setDrafts(null); setText(''); }} onCancel={() => setDrafts(null)} />}
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
  const system = `You are Claude, embedded in ${name}'s personal life app — the brilliant mind behind everything. You see all data the user catalogs. Answer concisely in ${lang === 'pt' ? 'Brazilian Portuguese' : 'US English'}, using the JSON to reason about tasks, events, spending, messages and loose ends; you can also draft messages, texts and suggest next actions. Never give definitive medical or financial advice — add a one-line caution and suggest a professional if asked. Today: ${todayISO()}. Data: ${JSON.stringify(buildContext(items))}`;
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
        {msgs.map((mm, i) => <div key={i} style={{ display: 'flex', justifyContent: mm.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}><div style={{ maxWidth: '82%', padding: '10px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: mm.role === 'user' ? C.accent : C.surface, color: mm.role === 'user' ? '#171200' : C.text, border: mm.role === 'user' ? 'none' : `1px solid ${C.borderSoft}` }}>{mm.content}</div></div>)}
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

function WeatherDetail({ wx, lang, t, onClose }) {
  const d0 = (wx.days && wx.days[0]) || {};
  const rows = [
    [t('rainChance'), d0.rainProb != null ? d0.rainProb + '%' : '—', CloudRain, C.blue],
    [lang === 'pt' ? 'Chuva prevista' : 'Rain', d0.rainMm != null ? String(d0.rainMm).replace('.', ',') + ' mm' : '—', CloudRain, C.sky],
    [t('humidity'), wx.humidity != null ? wx.humidity + '%' : '—', Cloud, C.teal],
    [t('wind'), wx.wind != null ? wx.wind + ' km/h' : '—', Wind, C.text2],
    [t('uvIndex'), d0.uv != null ? String(d0.uv) : '—', Sun, C.accent],
    [t('sunriseL'), d0.sunrise || '—', Sun, C.accent],
    [t('sunsetL'), d0.sunset || '—', CloudSun, C.violet],
  ];
  const hours = wx.hours || [];
  const maxRain = Math.max(10, ...hours.map((h) => h.rain || 0));
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('weatherDetail')} onClose={onClose} icon={CloudSun} />
      <div style={{ ...card, padding: 16, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 34, fontWeight: 800 }}>{wx.temp}°</div>
        <div><div style={{ fontSize: 13.5 }}>{wmo(wx.code, lang).label}</div><div style={{ fontSize: 11.5, color: C.text2, marginTop: 2 }}>↑{d0.hi}° ↓{d0.lo}° · {t('feels')} {wx.feels}°</div></div>
      </div>
      {hours.length > 0 && (
        <>
          <div style={{ fontSize: 11.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.06em', margin: '4px 2px 8px', fontWeight: 600 }}>{t('next12h')}</div>
          <div style={{ ...card, padding: 14, marginBottom: 12, display: 'flex', gap: 4, alignItems: 'flex-end', height: 108, overflowX: 'auto' }}>
            {hours.map((h, i) => (
              <div key={i} style={{ flex: '1 0 26px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 9, color: C.text2 }}>{h.rain != null ? h.rain + '%' : ''}</span>
                <div style={{ width: 12, height: Math.max(3, ((h.rain || 0) / maxRain) * 46), background: C.blue, borderRadius: 3 }} />
                <span style={{ fontSize: 9.5, color: C.text3 }}>{h.temp != null ? h.temp + '°' : ''}</span>
                <span style={{ fontSize: 9, color: C.text3 }}>{h.h}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ ...card, padding: 4 }}>
        {rows.map(([l, v, Ic, col], i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderTop: i ? `1px solid ${C.borderSoft}` : 'none' }}>
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
  const NowIcon = wxIcon(now.kind);
  return (
    <div onClick={() => setOpen(true)} style={{ ...card, padding: 14, marginBottom: 10, cursor: 'pointer' }}>
      {open && <WeatherDetail wx={wx} lang={lang} t={t} onClose={() => setOpen(false)} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <NowIcon size={32} style={{ color: C.accent }} />
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1 }}>{wx.temp}°</div>
            <div style={{ fontSize: 12, color: C.text3, marginTop: 3 }}>{now.label}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11.5, color: C.text3, lineHeight: 1.6 }}>
          {wx.feels != null && <div>{t('feels')} {wx.feels}°</div>}
          <div>↑{wx.hi}° ↓{wx.lo}° <ChevronRight size={11} style={{ verticalAlign: 'middle', color: C.text3 }} /></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {(wx.days || []).slice(1, 6).map((d, i) => {
          const I = wxIcon(wmo(d.code, lang).kind);
          const wd = WD[lang][new Date(d.date + 'T00:00:00').getDay()];
          return (
            <div key={i} style={{ flex: 1, textAlign: 'center', background: C.bg2, borderRadius: 10, padding: '8px 2px' }}>
              <div style={{ fontSize: 10, color: C.text3 }}>{wd}</div>
              <I size={16} style={{ color: C.text2, margin: '5px auto' }} />
              <div style={{ fontSize: 10.5 }}>{d.hi}°<span style={{ color: C.text3 }}> {d.lo}°</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Today ---------------- */
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
function TodayScreen({ items, lang, t, greeting, name, toggleTask, onOpen, addItems, flash, health, setHealth, goModule, openClaude, goNews, ouraOn }) {
  const [logOpen, setLogOpen] = useState(false); const [ask, setAsk] = useState('');
  const [live, setLive] = useState(null); const [liveLoading, setLiveLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = (lat, lon) => {
      const q = lat != null ? `?lat=${lat}&lon=${lon}` : '';
      fetch('/api/live' + q).then((r) => r.json()).then((j) => { if (alive) { setLive(j); setLiveLoading(false); } })
        .catch(() => { if (alive) setLiveLoading(false); });
    };
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => load(p.coords.latitude.toFixed(3), p.coords.longitude.toFixed(3)),
        () => load(null, null),
        { timeout: 4000, maximumAge: 600000 }
      );
    } else load(null, null);
    return () => { alive = false; };
  }, []);
  const today = todayISO(); const hm = nowHM(); const w = health[today] || {};
  const attention = items.filter((i) => i.type === 'task' && i.status !== 'done' && (i.priority === 1 || (i.date && i.date < today)));
  const todayItems = items.filter((i) => i.date === today && i.status !== 'done' && i.type !== 'task').sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  const next5 = todayItems.filter((i) => !i.time || i.time >= hm).slice(0, 5);
  const balances = items.filter((i) => i.type === 'account' && i.meta && i.meta.showOnToday);
  const longTerm = items.filter((i) => i.date && i.date > today && ((i.meta && i.meta.milestone) || i.type === 'trip')).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 300, letterSpacing: '-.02em' }}>{greeting()}, <span style={{ fontWeight: 600 }}>{name}</span>.</div>
          <div style={{ color: C.text3, fontSize: 13.5, marginTop: 2, textTransform: 'capitalize' }}>{fmtLong(today, lang)}</div>
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
      <QuickCapture lang={lang} t={t} addItems={addItems} flash={flash} />
      <div style={{ display: 'flex', gap: 10, margin: '10px 0' }}>
        <ScoreRing label={t('readiness')} value={w.readiness ?? null} color={C.green} locked={ouraOn} onClick={() => setLogOpen(true)} />
        <ScoreRing label={t('sleepScore')} value={w.sleep ?? null} color={C.violet} locked={ouraOn} onClick={() => setLogOpen(true)} />
      </div>
      {ouraOn
        ? <div style={{ fontSize: 11, color: C.text3, textAlign: 'center', margin: '-2px 0 12px', display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'center' }}><Activity size={11} style={{ color: C.green }} />{(w.readiness == null && w.sleep == null) ? t('ouraNoData') : t('ouraSynced')}</div>
        : (w.readiness == null && w.sleep == null) && <div style={{ fontSize: 11.5, color: C.text3, textAlign: 'center', margin: '-2px 0 12px' }}>{t('connectOura')}</div>}
      <WeatherCard lang={lang} t={t} wx={live && live.weather} loading={liveLoading} />
      {balances.length > 0 ? balances.map((b) => <InfoCard key={b.id} icon={CreditCard} title={b.title} sub={t('available')} onClick={() => onOpen(b)} accent right={<span style={{ fontSize: 18, fontWeight: 700, color: C.green }}>{fmtMoney(b.meta.balance, lang)}</span>} />) : <InfoCard icon={CreditCard} title={t('available')} sub={t('addBalance')} onClick={() => goModule('finance')} right={<Plus size={18} style={{ color: C.text3 }} />} />}
      <SectionTitle icon={AlertTriangle} label={t('attention')} color={C.rose} />
      {attention.length === 0 ? <Empty icon={Check} text={t('noAttention')} /> : attention.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      <SectionTitle icon={Clock} label={t('todayPlan')} color={C.accent} />
      {next5.length === 0 ? <Empty icon={Sun} text={t('nothingToday')} /> : next5.map((i) => (
        <div key={i.id} onClick={() => onOpen(i)} style={{ ...card, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.accent, width: 44, flexShrink: 0 }}>{i.time || '—'}</div>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>{i.meta && i.meta.milestone && <Star size={12} style={{ color: C.accent }} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span></div><div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>{t('t_' + i.type)}</div></div>
          <ChevronRight size={16} style={{ color: C.text3 }} />
        </div>
      ))}
      <SectionTitle icon={Star} label={t('longTerm')} color={C.violet} />
      {longTerm.length === 0 ? <Empty icon={Star} text={t('noLongTerm')} /> : longTerm.map((i) => (
        <div key={i.id} onClick={() => onOpen(i)} style={{ ...card, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ textAlign: 'center', width: 44, flexShrink: 0 }}><div style={{ fontSize: 15, fontWeight: 700 }}>{Number(i.date.slice(-2))}</div><div style={{ fontSize: 10, color: C.text3, textTransform: 'uppercase' }}>{new Date(i.date + 'T00:00:00').toLocaleDateString(loc(lang), { month: 'short' })}</div></div>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div><div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>{fmtDate(i.date, lang)}</div></div>
          <ChevronRight size={16} style={{ color: C.text3 }} />
        </div>
      ))}
      <SectionTitle icon={Newspaper} label={t('news')} color={C.blue} />
      <div style={{ ...card, overflow: 'hidden' }}>
        {NEWS.slice(0, 5).map((n, i) => (
          <div key={i} onClick={goNews} style={{ padding: '11px 14px', borderTop: i ? `1px solid ${C.borderSoft}` : 'none', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 10.5, color: C.accent, fontWeight: 600 }}>{n.source} · {n.cat}</div><div style={{ fontSize: 13.5, marginTop: 2, lineHeight: 1.35 }}>{n.title}</div></div>
            <ChevronRight size={15} style={{ color: C.text3, flexShrink: 0 }} />
          </div>
        ))}
      </div>
      <button onClick={goNews} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', fontSize: 12.5, padding: '8px 2px', display: 'flex', alignItems: 'center', gap: 4 }}>{t('seeAll')}<ChevronRight size={14} /></button>
      <div style={{ ...card, padding: 6, display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0 8px', border: `1px solid ${C.accent}33` }}>
        <Sparkles size={16} style={{ color: C.accent, marginLeft: 6 }} />
        <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={t('askClaude')} onKeyDown={(e) => { if (e.key === 'Enter' && ask.trim()) { openClaude(ask.trim()); setAsk(''); } }} style={{ ...inputStyle, background: 'transparent', border: 'none' }} />
        <Btn onClick={() => { if (ask.trim()) { openClaude(ask.trim()); setAsk(''); } }} disabled={!ask.trim()} style={{ padding: '9px 12px' }}><Send size={15} /></Btn>
      </div>
      {logOpen && !ouraOn && <WellnessLog current={w} lang={lang} t={t} onSave={(v) => setHealth((h) => ({ ...h, [today]: v }))} onClose={() => setLogOpen(false)} />}
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
function NewsScreen({ lang, t, back }) {
  return (
    <div>
      <button onClick={back} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 8, padding: '4px 0' }}><ChevronLeft size={16} />{t('home')}</button>
      <ScreenTitle title={t('news')} />
      <HintCard icon={Newspaper} text={t('newsExample')} />
      {NEWS.map((n, i) => (
        <a key={i} href={n.url} target="_blank" rel="noreferrer" style={{ ...card, textDecoration: 'none', color: C.text, padding: 14, marginBottom: 8, display: 'block' }}>
          <div style={{ fontSize: 11.5, color: C.accent, fontWeight: 600, marginBottom: 4 }}>{n.source} · {n.cat}</div>
          <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4 }}>{n.title}</div>
          <div style={{ fontSize: 11.5, color: C.text3, marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>{t('openBrowser')}<ArrowRight size={12} /></div>
        </a>
      ))}
    </div>
  );
}

/* ---------------- Calendar ---------------- */
const CAL_FILTERS = [['all', 'fAll', null], ['work', 'fWork', 'work'], ['personal', 'fPersonal', 'personal'], ['kids', 'fKids', 'kids'], ['house', 'fHouse', 'home'], ['health', 'fHealth', 'health']];
function CalendarScreen({ items, lang, t, toggleTask, onOpen, onRefresh, onMount }) {
  useEffect(() => { if (onMount) onMount(); }, []);
  const [mode, setMode] = useState('week'); const [spin, setSpin] = useState(false); const today = todayISO(); const [sel, setSel] = useState(today); const [vm, setVm] = useState(today.slice(0, 7)); const [filter, setFilter] = useState(null); const [scope, setScope] = useState('all');
  const dated = items.filter((i) => i.date && i.status !== 'done' && i.type !== 'account' && i.type !== 'person' && i.type !== 'message' && (scope === 'all' || ['event', 'appointment', 'flight', 'trip'].includes(i.type)) && (!filter || i.domain === filter));
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
          <span style={{ fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>{mode === 'month' ? monthLabel : `${t('week')} · ${fmtDate(cells[0], lang)}`}</span>
          <button onClick={() => (mode === 'month' ? shiftMonth(1) : shiftWeek(1))} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer' }}><ChevronRight size={20} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3, marginBottom: 4 }}>{WD[lang].map((wd) => <div key={wd} style={{ textAlign: 'center', fontSize: 10.5, color: C.text3, padding: '2px 0' }}>{wd}</div>)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
          {cells.map((iso, idx) => {
            if (!iso) return <div key={idx} />;
            const list = onDay(iso); const n = list.length; const hasMile = list.some((i) => i.meta && i.meta.milestone); const isToday = iso === today, isSel = iso === sel;
            return (
              <button key={idx} onClick={() => setSel(iso)} style={{ aspectRatio: '1', border: isSel ? `1px solid ${C.accent}` : '1px solid transparent', background: isSel ? C.accentSoft : isToday ? C.surface2 : 'transparent', borderRadius: 9, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: 2 }}>
                <span style={{ fontSize: 13, color: isToday ? C.accent : C.text, fontWeight: isToday ? 700 : 400 }}>{Number(iso.slice(-2))}</span>
                {n > 0 && <div style={{ display: 'flex', gap: 2 }}>{Array.from({ length: Math.min(n, 3) }).map((_, k) => <span key={k} style={{ width: 4, height: 4, borderRadius: 999, background: hasMile ? C.accent : C.text2 }} />)}</div>}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, margin: '4px 2px 10px', textTransform: 'capitalize', color: sel === today ? C.accent : C.text }}>{sel === today ? t('home') : fmtLong(sel, lang)}</div>
      {dayItems.length === 0 ? <Empty icon={CalIcon} text={t('noItemsDay')} /> : dayItems.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
    </div>
  );
}

/* ---------------- Dashboard grid + generic module ---------------- */
function DashboardScreen({ items, lang, t, open, gmailCount }) {
  return (
    <div>
      <ScreenTitle title={t('dashboard')} sub={t('yourModules')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {MODULES.map((mo) => { const count = mo.key === 'gmail' ? (gmailCount || 0) : items.filter(mo.filter).length; const Ic = mo.icon; return (
          <button key={mo.key} onClick={() => open(mo)} style={{ ...card, padding: 15, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 92 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: mo.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={18} style={{ color: mo.color }} /></div>
            <div><div style={{ fontSize: 14, fontWeight: 600 }}>{t(mo.key)}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>{count} {t('items')}</div></div>
          </button>
        ); })}
      </div>
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
const TASK_FILTERS = [['fAll', () => true], ['fWork', (i) => i.domain === 'work'], ['fPersonal', (i) => !['work', 'home', 'kids'].includes(i.domain)], ['fHouse', (i) => i.domain === 'home'], ['fKids', (i) => i.domain === 'kids']];
function ModuleScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash }) {
  const [adding, setAdding] = useState(false); const [tf, setTf] = useState(0);
  const base = items.filter(module.filter);
  const list = (module.key === 'tasks' ? base.filter(TASK_FILTERS[tf][1]) : base).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let hi = null;
  if (module.key === 'docs') { const soon = items.filter((i) => i.type === 'document' && i.date && i.date <= addDays(todayISO(), 60)).length; hi = { label: `${t('expiring')} (60d)`, value: String(soon), color: soon ? C.rose : C.text2 }; }
  else if (module.key === 'tasks') hi = { label: t('open'), value: String(items.filter((i) => i.type === 'task' && i.status !== 'done').length), color: C.accent };
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {module.key === 'tasks' && <HintCard icon={RefreshCw} text={t('tickHint')} />}
      {module.key === 'tasks' && <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 4 }}>{TASK_FILTERS.map(([lk], idx) => <Chip key={lk} active={tf === idx} onClick={() => setTf(idx)}>{t(lk)}</Chip>)}</div>}
      {hi && <div style={{ ...card, padding: 16, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: 12.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.05em' }}>{hi.label}</span><span style={{ fontSize: 22, fontWeight: 600, color: hi.color }}>{hi.value}</span></div>}
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('quickAdd')}</Btn>
      {list.length === 0 ? <Empty icon={module.icon} text={t('nothingHere')} /> : list.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      {adding && <AddModal title={`${t('quickAdd')} · ${t(module.key)}`} icon={Plus} draft={{ type: module.types[0], domain: moduleDomain(module.key) }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: moduleDomain(module.key), ...x }); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}

/* ---------------- Documents dashboard ---------------- */
function DocsScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash }) {
  const [adding, setAdding] = useState(false); const [cat, setCat] = useState(null);
  const docs = items.filter((i) => i.type === 'document');
  const withCat = docs.map((d) => ({ d, cat: docCategory(d) }));
  const cats = [...new Set(withCat.map((x) => x.cat))];
  const soon = docs.filter((i) => i.date && i.date <= addDays(todayISO(), 60)).sort((a, b) => a.date.localeCompare(b.date));
  const shown = cat ? withCat.filter((x) => x.cat === cat) : withCat;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {soon.length > 0 && (
        <div style={{ ...card, padding: 14, marginBottom: 12, borderColor: C.rose + '44', background: C.rose + '12', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertTriangle size={17} style={{ color: C.rose, marginTop: 1 }} />
          <div><div style={{ fontSize: 13.5, fontWeight: 600 }}>{soon.length} {t('expiring').toLowerCase()} (60 dias)</div><div style={{ fontSize: 12, color: C.text3, marginTop: 3, lineHeight: 1.5 }}>{soon.slice(0, 3).map((d) => `${d.title} — ${fmtDate(d.date, lang)}`).join(' · ')}</div></div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 4 }}>
        <Chip active={!cat} onClick={() => setCat(null)}>{t('fAll')}</Chip>
        {cats.map((ck) => <Chip key={ck} active={cat === ck} onClick={() => setCat(ck)}>{ck}</Chip>)}
      </div>
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('addDoc')}</Btn>
      {shown.length === 0 ? <Empty icon={FileText} text={t('nothingHere')} /> : (cat
        ? shown.map((x) => <ItemRow key={x.d.id} item={x.d} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)
        : cats.map((ck) => { const g = shown.filter((x) => x.cat === ck); if (!g.length) return null; return <div key={ck}><SectionTitle icon={FileText} label={ck} color={C.blue} />{g.map((x) => <ItemRow key={x.d.id} item={x.d} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</div>; }))}
      {adding && <AddModal title={t('addDoc')} icon={FileText} draft={{ type: 'document', domain: 'docs', meta: {} }} allowedTypes={['document']} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: 'docs', ...x }); flash(t('savedOne')); setAdding(false); }} />}
    </div>
  );
}


/* ---------------- Gmail (cliente simples) ---------------- */
function GmailThread({ m, lang, t, onClose, onAction, onReplied }) {
  const [reply, setReply] = useState(''); const [busy, setBusy] = useState(''); const [done, setDone] = useState('');
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
      <div style={{ ...card, padding: 14, marginBottom: 14, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>{m.body}</div>
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

function GmailCompose({ lang, t, onClose }) {
  const [to, setTo] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
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
      {state.loading
        ? <div style={{ ...card, padding: 26, textAlign: 'center', color: C.text3, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Loader2 size={15} className="spin" />…</div>
        : state.messages.length === 0
          ? <Empty icon={Mail} text={state.connected ? t('gmailEmpty') : t('nothingHere')} />
          : state.messages.map((m) => (
            <div key={m.id} onClick={() => setSel(m.id)} style={{ ...card, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: C.blue + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 13, fontWeight: 700, color: C.blue }}>{initials(m.sender)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.sender}</span>
                  <span style={{ fontSize: 10.5, color: C.text3, flexShrink: 0 }}>{m.date.slice(11, 16)}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</div>
                <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.snippet}</div>
              </div>
            </div>
          ))}
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
function periodFilter(list, period) {
  if (period === 'all') return list;
  if (period === 'month') { const m = todayISO().slice(0, 7); return list.filter((i) => (i.date || '').startsWith(m)); }
  const from = addDays(todayISO(), -30); return list.filter((i) => (i.date || '') >= from);
}
function AccountDetail({ acc, items, people, lang, t, back, onOpen, addItem, flash, goReport }) {
  const [hidden, setHidden] = useState(false); const [period, setPeriod] = useState('month'); const [adding, setAdding] = useState(null);
  const accounts = items.filter((i) => i.type === 'account');
  const all = items.filter(isTx).filter((i) => acc ? (i.meta && i.meta.accountId === acc.id) : true);
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
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>{acc ? amountStr(Number(acc.meta && acc.meta.balance) || 0, lang, hidden) : amountStr(income - outflow, lang, hidden)}</div>
        <div style={{ fontSize: 11.5, color: C.text3, marginTop: 3 }}>{acc ? (acc.meta && acc.meta.institution || t('balance')) : t('statement')}</div>
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
        {goReport && <Btn kind="soft" onClick={goReport} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Activity size={14} />{t('reports')}</Btn>}
      </div>
      <SectionTitle icon={Wallet} label={t('statement')} color={km ? km.color : C.accent} />
      <Extrato tx={tx} accounts={accounts} lang={lang} t={t} onOpen={onOpen} />
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'finance', date: todayISO(), meta: { accountId: acc ? acc.id : null } }} allowedTypes={[adding]} lang={lang} t={t} people={people} accounts={accounts} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'finance', ...x }); flash(t('savedOne')); setAdding(null); }} />}
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
        {msgs.map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}><div style={{ maxWidth: '82%', padding: '10px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: m.role === 'user' ? C.accent : C.surface, color: m.role === 'user' ? '#171200' : C.text, border: m.role === 'user' ? 'none' : `1px solid ${C.borderSoft}` }}>{m.content}</div></div>)}
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
function FinanceScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash }) {
  const [sub, setSub] = useState({ v: 'home' }); const [adding, setAdding] = useState(null); const [hidden, setHidden] = useState(false);
  const accounts = items.filter((i) => i.type === 'account');
  if (sub.v === 'account') { const acc = sub.id ? items.find((i) => i.id === sub.id) : null; return <AccountDetail acc={acc} items={items} people={people} lang={lang} t={t} back={() => setSub({ v: 'home' })} onOpen={onOpen} addItem={addItem} flash={flash} goReport={() => setSub({ v: 'reports' })} />; }
  if (sub.v === 'reports') return <ReportsScreen items={items} people={people} lang={lang} t={t} back={() => setSub({ v: 'home' })} />;
  if (sub.v === 'assistant') return <FinanceAssistant items={items} lang={lang} t={t} back={() => setSub({ v: 'home' })} />;
  const month = todayISO().slice(0, 7);
  const inAccounts = accounts.filter((a) => (a.meta && a.meta.kind) !== 'credit').reduce((s, a) => s + (Number(a.meta && a.meta.balance) || 0), 0);
  const invested = accounts.filter((a) => a.meta && a.meta.kind === 'investment').reduce((s, a) => s + (Number(a.meta.balance) || 0), 0);
  const creditOwed = accounts.filter((a) => a.meta && a.meta.kind === 'credit').reduce((s, a) => s + (Number(a.meta.balance) || 0), 0);
  const monthTx = items.filter(isTx).filter((i) => (i.date || '').startsWith(month));
  const income = monthTx.filter(isCredit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const outflow = monthTx.filter(isDebit).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const byCat = {}; monthTx.filter(isDebit).forEach((i) => { const k = deriveCat(i); byCat[k] = (byCat[k] || 0) + (Number(i.amount) || 0); });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const bills = items.filter((i) => i.type === 'bill' && i.date && i.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const SHORT = [{ k: 'statement', icon: Wallet, on: () => setSub({ v: 'account', id: null }) }, { k: 'reports', icon: Activity, on: () => setSub({ v: 'reports' }) }, { k: 'assistant', icon: Sparkles, on: () => setSub({ v: 'assistant' }) }];
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      <div style={{ ...card, padding: 18, marginBottom: 14, background: `linear-gradient(135deg, ${C.accent}1c, ${C.surface})`, borderColor: C.accent + '33' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: C.text3 }}>{t('totalBalance')}</span>
          <button onClick={() => setHidden((h) => !h)} title={t('hideBalance')} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: 13 }}>{hidden ? '👁' : '••'}</button>
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', marginTop: 4 }}>{amountStr(inAccounts, lang, hidden)}</div>
        <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
          <div><div style={{ fontSize: 10.5, color: C.text3 }}>{t('invested')}</div><div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>{amountStr(invested, lang, hidden)}</div></div>
          <div><div style={{ fontSize: 10.5, color: C.text3 }}>{t('credit')}</div><div style={{ fontSize: 14, fontWeight: 700, color: C.rose }}>{amountStr(creditOwed, lang, hidden)}</div></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {SHORT.map((s) => <button key={s.k} onClick={s.on} style={{ ...card, flex: 1, padding: '12px 4px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}><s.icon size={19} style={{ color: C.accent }} /><span style={{ fontSize: 11 }}>{t(s.k)}</span></button>)}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
        <MiniStat label={`${t('incomeL')} · ${t('thisMonth')}`} value={amountStr(income, lang, hidden)} color={C.green} small />
        <MiniStat label={`${t('outflow')} · ${t('thisMonth')}`} value={amountStr(outflow, lang, hidden)} color={C.rose} small />
      </div>
      {catRows.length > 0 && (
        <>
          <div onClick={() => setSub({ v: 'reports' })} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 2px 10px', cursor: 'pointer' }}>
            <span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}><Activity size={14} style={{ color: C.green }} />{t('consumption')}</span>
            <ChevronRight size={16} style={{ color: C.text3 }} />
          </div>
          <div style={{ ...card, padding: 14 }}>{catRows.slice(0, 4).map(([k, v]) => { const cc = CATEGORIES[k]; return <BarRow key={k} label={cc[lang]} value={v} max={catRows[0][1]} color={cc.color} icon={cc.icon} right={fmtMoney(v, lang)} />; })}</div>
        </>
      )}
      {bills.length > 0 && <><SectionTitle icon={Clock} label={t('upcomingBills')} color={C.accent} />{bills.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      <SectionTitle icon={CreditCard} label={t('accounts')} color={C.green} />
      {accounts.length === 0 ? <Empty icon={CreditCard} text={t('nothingHere')} /> : accounts.map((a) => { const km = KIND_META[(a.meta && a.meta.kind) || 'checking']; return (
        <div key={a.id} onClick={() => setSub({ v: 'account', id: a.id })} style={{ ...card, padding: '13px 14px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: km.color + '1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><km.icon size={17} style={{ color: km.color }} /></div>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div><div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>{ACCOUNT_KINDS.find(([kk]) => kk === (a.meta && a.meta.kind || 'checking'))[lang === 'pt' ? 1 : 2]}</div></div>
          <span style={{ fontSize: 15, fontWeight: 700, color: (a.meta && a.meta.kind) === 'credit' ? C.rose : C.text }}>{amountStr(Number(a.meta && a.meta.balance) || 0, lang, hidden)}</span>
        </div>
      ); })}
      <Btn kind="soft" onClick={() => setAdding('account')} style={{ width: '100%', marginTop: 4, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}><Plus size={15} />{t('addAccount')}</Btn>
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'finance', meta: adding === 'account' ? { kind: 'checking' } : {} }} allowedTypes={[adding]} lang={lang} t={t} people={people} accounts={accounts} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'finance', ...x }); flash(t('savedOne')); setAdding(null); }} />}
    </div>
  );
}

/* ---------------- Health dashboard ---------------- */
function HealthScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash, health, setHealth, profile, setProfile, ouraOn, lastSleep, weights, addWeight }) {
  const [adding, setAdding] = useState(null); const [logOpen, setLogOpen] = useState(false); const [editP, setEditP] = useState(false);
  const today = todayISO(); const w = health[today] || {};
  const hd = items.filter((i) => i.domain === 'health');
  const consultas = hd.filter((i) => i.type === 'appointment' && i.date && i.date >= today).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const treat = hd.filter((i) => i.type === 'med');
  const pharm = hd.filter((i) => i.type === 'expense' && i.amount);
  const pharmTotal = pharm.reduce((a, b) => a + b.amount, 0);
  const hdocs = hd.filter((i) => i.type === 'document');
  const isExam = (i) => /exame|hemograma|raio|ultrass|resson|resultado|laudo|sangue|colesterol|glicose/i.test(i.title);
  const exams = hdocs.filter(isExam); const support = hdocs.filter((i) => !isExam(i));
  const bmi = profile.weight && profile.height ? (Number(profile.weight) / Math.pow(Number(profile.height) / 100, 2)).toFixed(1) : null;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
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
      <HintCard icon={Activity} text={t('appleHealth')} />
      {consultas.length > 0 && <><SectionTitle icon={Stethoscope} label={t('consultations')} color={C.rose} />{consultas.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {treat.length > 0 && <><SectionTitle icon={Pill} label={t('treatments')} color={C.violet} />{treat.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      <SectionTitle icon={Wallet} label={`${t('pharmacy')} · ${fmtMoney(pharmTotal, lang)}`} color={C.green} />
      {pharm.length === 0 ? <Empty icon={Wallet} text={t('nothingHere')} /> : pharm.slice(0, 5).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      <SectionTitle icon={Activity} label={t('exams')} color={C.blue} />
      {exams.length === 0 ? <Empty icon={Activity} text={t('nothingHere')} /> : exams.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      {support.length > 0 && <><SectionTitle icon={FileText} label={t('support')} color={C.text2} />{support.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {logOpen && !ouraOn && <WellnessLog current={w} lang={lang} t={t} onSave={(v) => setHealth((h) => ({ ...h, [today]: v }))} onClose={() => setLogOpen(false)} />}
      {editP && <WeightLog lang={lang} t={t} current={profile.weight} onSave={(kg) => { addWeight(kg); setEditP(false); }} onClose={() => setEditP(false)} />}
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'health', meta: {} }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'health', ...x }); flash(t('savedOne')); setAdding(null); }} />}
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

function TuyaDeviceGrid({ devices, prefs, t, lang, onCmd, onConfig }) {
  // decide quais mostrar: se ha alguma preferencia salva, respeita "show";
  // se nao ha NENHUMA pref ainda, mostra todos (primeiro uso).
  const hasPrefs = prefs && Object.keys(prefs).length > 0;
  const visible = devices.filter((d) => {
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
  const roomNames = Object.keys(groups).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  return (
    <div style={{ marginBottom: 4 }}>
      {roomNames.map((room) => (
        <div key={room || 'sem'} style={{ marginBottom: 12 }}>
          {room ? <div style={{ fontSize: 11.5, color: C.text2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', margin: '2px 2px 8px' }}>{room}</div> : (roomNames.length > 1 ? <div style={{ fontSize: 11.5, color: C.text3, margin: '2px 2px 8px' }}>{lang === 'pt' ? 'Outros' : 'Other'}</div> : null)}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {groups[room].map((d) => <TuyaCard key={d.id} device={d} kind={tuyaKind(d, prefs)} label={tuyaLabel(d, prefs)} t={t} onCmd={onCmd} />)}
          </div>
        </div>
      ))}
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
        {devices.map((d) => {
          const p = get(d.id); const show = p.show !== false;
          return (
            <div key={d.id} style={{ ...card, padding: 12, marginBottom: 8, opacity: show ? 1 : 0.6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={() => patch(d.id, { show: !show })} style={{ width: 40, height: 24, borderRadius: 999, border: 'none', background: show ? C.green : C.surface2, position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
                  <span style={{ position: 'absolute', top: 3, left: show ? 19 : 3, width: 18, height: 18, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.alias || d.name}</div>
                  <div style={{ fontSize: 10, color: C.text3 }}>{d.name} · {d.category}{d.online ? '' : ' · offline'}</div>
                </div>
              </div>
              {show && (
                <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                  <input value={p.alias || ''} onChange={(e) => patch(d.id, { alias: e.target.value })} placeholder={lang === 'pt' ? 'Apelido (ex.: Luz da sala)' : 'Nickname'} style={{ ...inputStyle, padding: '9px 11px', fontSize: 13 }} />
                  <input value={p.room || ''} onChange={(e) => patch(d.id, { room: e.target.value })} placeholder={lang === 'pt' ? 'Cômodo (ex.: Sala, Quarto)' : 'Room'} style={{ ...inputStyle, padding: '9px 11px', fontSize: 13 }} />
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {kinds.map(([k, lab]) => (
                      <button key={k} onClick={() => patch(d.id, { kind: k })} style={{ padding: '5px 10px', borderRadius: 999, border: `1px solid ${(p.kind || 'auto') === k ? C.accent : C.border}`, background: (p.kind || 'auto') === k ? C.accentSoft : 'transparent', color: (p.kind || 'auto') === k ? C.accent : C.text3, fontSize: 11.5, cursor: 'pointer' }}>{lab}</button>
                    ))}
                  </div>
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
  return <button onClick={onClick} style={{ padding: wide ? '12px 10px' : '12px 0', borderRadius: 12, border: `1px solid ${C.border}`, background: accent ? C.accentSoft : C.surface2, color: accent ? C.accent : C.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', minWidth: 0 }}>{children}</button>;
}

// Para controles IR "universais" da Tuya, os comandos vao pelo code padrao.
// Como cada remoto aprendido pode variar, usamos os codes comuns e deixamos claro
// que ajustamos caso algum botao nao responda.
function TuyaRemote({ device, kind, label, t, onCmd, onClose }) {
  const send = (code, value) => onCmd(device.id, code, value === undefined ? true : value);
  const [temp, setTemp] = useState(device.status.temp_set != null ? device.status.temp_set : 23);
  return (
    <Modal onClose={onClose}>
      <SheetHead title={label} onClose={onClose} icon={kind === 'ac' ? Wind : kind === 'receiver' ? Radio : Tv} />

      {kind === 'ac' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ ...card, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 40, fontWeight: 800, color: C.accent }}>{temp}°</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10 }}>
              <IRBtn onClick={() => { const v = Math.max(16, temp - 1); setTemp(v); send('temp', v); }} wide>−</IRBtn>
              <IRBtn onClick={() => { const v = Math.min(30, temp + 1); setTemp(v); send('temp', v); }} wide>＋</IRBtn>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('acMode')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <IRBtn onClick={() => send('mode', 'cold')} accent>❄ {t('cold')}</IRBtn>
              <IRBtn onClick={() => send('mode', 'hot')}>☀ {t('hot')}</IRBtn>
              <IRBtn onClick={() => send('mode', 'wind')}>💨 {t('fan')}</IRBtn>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.text2, marginBottom: 6 }}>{t('fanSpeed')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              <IRBtn onClick={() => send('wind', 'low')}>1</IRBtn>
              <IRBtn onClick={() => send('wind', 'mid')}>2</IRBtn>
              <IRBtn onClick={() => send('wind', 'high')}>3</IRBtn>
              <IRBtn onClick={() => send('wind', 'auto')}>A</IRBtn>
            </div>
          </div>
          <IRBtn onClick={() => send('power', 'off')}>⏻ {t('turnOff')}</IRBtn>
        </div>
      ) : kind === 'receiver' ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <IRBtn onClick={() => send('power')} accent>⏻ {t('power')}</IRBtn>
            <IRBtn onClick={() => send('mute')}>🔇 Mute</IRBtn>
          </div>
          <div style={{ fontSize: 11.5, color: C.text2 }}>{t('volume')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <IRBtn onClick={() => send('volume_down')} wide>🔉 −</IRBtn>
            <IRBtn onClick={() => send('volume_up')} wide>🔊 ＋</IRBtn>
          </div>
          <div style={{ fontSize: 11.5, color: C.text2 }}>{t('input')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <IRBtn onClick={() => send('input')}>↔ {t('changeInput')}</IRBtn>
            <IRBtn onClick={() => send('menu')}>☰ Menu</IRBtn>
          </div>
        </div>
      ) : (
        // TV ou set-top box
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <IRBtn onClick={() => send('power')} accent>⏻ {t('power')}</IRBtn>
            <IRBtn onClick={() => send('mute')}>🔇 Mute</IRBtn>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'center' }}>
            <div />
            <IRBtn onClick={() => send('up')}>▲</IRBtn>
            <div />
            <IRBtn onClick={() => send('left')}>◀</IRBtn>
            <IRBtn onClick={() => send('ok')} accent>OK</IRBtn>
            <IRBtn onClick={() => send('right')}>▶</IRBtn>
            <div />
            <IRBtn onClick={() => send('down')}>▼</IRBtn>
            <div />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <IRBtn onClick={() => send('vol_add')} wide>🔊 Vol +</IRBtn>
            <IRBtn onClick={() => send('vol_sub')} wide>🔉 Vol −</IRBtn>
            <IRBtn onClick={() => send('ch_add')} wide>CH +</IRBtn>
            <IRBtn onClick={() => send('ch_sub')} wide>CH −</IRBtn>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <IRBtn onClick={() => send('back')}>↩ {t('back')}</IRBtn>
            <IRBtn onClick={() => send('menu')}>☰ Menu</IRBtn>
          </div>
        </div>
      )}
      <div style={{ fontSize: 10.5, color: C.text3, marginTop: 14, textAlign: 'center', lineHeight: 1.5 }}>{t('irNote')}</div>
    </Modal>
  );
}

function tuyaSwitchCode(status) {
  const keys = Object.keys(status || {});
  return keys.find((k) => /^switch(_1|_led)?$|^switch$/.test(k)) || keys.find((k) => k.startsWith('switch')) || null;
}
function TuyaCard({ device, t, onCmd, kind, label }) {
  const [remote, setRemote] = useState(false); const [light, setLight] = useState(false);
  const irKind = kind === 'tv' || kind === 'stb' || kind === 'ac' || kind === 'receiver';
  const sw = tuyaSwitchCode(device.status);
  const on = sw ? !!device.status[sw] : null;
  const bright = device.status.bright_value_v2 != null ? device.status.bright_value_v2 : device.status.bright_value;
  const temp = device.status.temp_current != null ? device.status.temp_current : (device.status.va_temperature != null ? device.status.va_temperature / 10 : null);
  const kindIcon = { light: Lightbulb, plug: Power, switch: Power, climate: Wind, ac: Wind, tv: Tv, stb: Tv, receiver: Radio };
  const Ic = kindIcon[kind] || Power;
  const nome = label || device.name;
  if (irKind) {
    return (
      <>
        <button onClick={() => device.online && setRemote(true)} disabled={!device.online} style={{ ...card, padding: 13, textAlign: 'left', cursor: device.online ? 'pointer' : 'not-allowed', opacity: device.online ? 1 : 0.55, border: 'none', width: '100%', color: C.text }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={17} style={{ color: C.accent }} /></div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</div>
          <div style={{ fontSize: 10.5, color: device.online ? C.text3 : C.rose, marginTop: 2 }}>{device.online ? t('openRemote') : t('offline')}</div>
        </button>
        {remote && <TuyaRemote device={device} kind={kind} label={nome} t={t} onCmd={onCmd} onClose={() => setRemote(false)} />}
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
        {kind === 'light' && device.online && on && <button onClick={() => setLight(true)} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', padding: 2 }}><Sparkles size={14} /></button>}
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
          <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 20, height: 20, borderRadius: 999, background: on ? '#171200' : C.text3, transition: 'left .15s' }} />
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
function HouseScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash, devices, setDevices, tuyaPrefs, setTuyaPrefs }) {
  const [adding, setAdding] = useState(false); const [filterAll, setFilterAll] = useState(false);
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
            j.devices.forEach((d) => { if (!next[d.id] && TUYA_SEED[d.id]) { next[d.id] = TUYA_SEED[d.id]; changed = true; } });
            return changed ? next : prev;
          });
        }
      })
      .catch((e) => setTuya({ loading: false, configured: false, connected: false, devices: [], error: String(e) }));
  };
  useEffect(() => { loadTuya(); }, []);
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <SectionTitle icon={Power} label={t('devices')} color={C.accent} />
        {tuya.configured && <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setCfgDev(true)} style={{ ...card, padding: '5px 9px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}><Cog size={11} />{t('choose')}</button>
          <button onClick={loadTuya} style={{ ...card, padding: '5px 9px', color: C.text2, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>{tuya.loading ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}SmartLife</button>
        </div>}
      </div>
      {tuya.error && <HintCard icon={AlertTriangle} text={'SmartLife: ' + tuya.error} />}
      {tuya.loading && !tuya.devices.length ? (
        <div style={{ ...card, padding: 20, marginBottom: 10, textAlign: 'center', color: C.text3, fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Loader2 size={14} className="spin" />SmartLife…</div>
      ) : tuya.connected && tuya.devices.length ? (
        <TuyaDeviceGrid devices={tuya.devices} prefs={tuyaPrefs} t={t} lang={lang} onCmd={sendCmd} onConfig={() => setCfgDev(true)} />
      ) : !tuya.configured ? (
        <><HintCard icon={Power} text={t('deviceHint')} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{devices.map((d) => <DeviceCard key={d.id} device={d} onChange={upd} />)}</div></>
      ) : (
        <HintCard icon={Power} text={lang === 'pt' ? 'Nenhum aparelho SmartLife encontrado.' : 'No SmartLife devices found.'} />
      )}
      <SectionTitle icon={Wallet} label={t('houseCosts')} color={C.green} />
      <div style={{ ...card, padding: 16, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>{fmtMoney(cost, lang)}</div><div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{filterAll ? t('allTime') : t('thisMonth')}</div></div>
        <div style={{ display: 'flex', gap: 6 }}><Chip active={!filterAll} onClick={() => setFilterAll(false)}>{t('thisMonth')}</Chip><Chip active={filterAll} onClick={() => setFilterAll(true)}>{t('allTime')}</Chip></div>
      </div>
      <SectionTitle icon={ListTodo} label={t('houseTasks')} color={C.blue} />
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('quickAdd')}</Btn>
      {tasks.length === 0 ? <Empty icon={Home} text={t('nothingHere')} /> : tasks.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      <SectionTitle icon={Video} label={t('cameras')} color={C.violet} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {['Sala', 'Entrada'].map((cam) => <div key={cam} style={{ ...card, aspectRatio: '4/3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: C.text3, background: C.bg2 }}><Camera size={22} /><span style={{ fontSize: 12 }}>{cam}</span><span style={{ fontSize: 10, textAlign: 'center', padding: '0 10px' }}>{t('camerasHint')}</span></div>)}
      </div>
      <SectionTitle icon={Users} label={t('staff')} color={C.sky} />
      {staffMsgs.length === 0 ? <Empty icon={Users} text={t('nothingHere')} /> : staffMsgs.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      {adding && <AddModal title={`${t('quickAdd')} · ${t('house')}`} icon={Plus} draft={{ type: 'task', domain: 'home' }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(false)} onSave={(x) => { addItem({ domain: 'home', ...x }); flash(t('savedOne')); setAdding(false); }} />}
      {cfgDev && <TuyaConfig devices={tuya.devices} prefs={tuyaPrefs} setPrefs={setTuyaPrefs} lang={lang} t={t} onClose={() => setCfgDev(false)} />}
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
            <MiniStat label={t('open')} value={school.filter((x) => x.type === 'task' && x.status !== 'done').length} color={C.accent} />
            <MiniStat label={t('gifts')} value={giftsL.length} color={C.violet} />
            <MiniStat label={t('documents')} value={docs.length} color={C.blue} />
          </div>
          <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
            <Btn kind="soft" onClick={() => setAdding('task')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><GraduationCap size={14} />{t('school')}</Btn>
            <Btn kind="soft" onClick={() => setAdding('gift')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Gift size={14} />{t('gifts')}</Btn>
            <Btn kind="soft" onClick={() => setAdding('document')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Syringe size={14} />{t('healthDocs')}</Btn>
          </div>
          <Section icon={GraduationCap} label={t('school')} color={C.accent} list={school} />
          <Section icon={Heart} label={t('health')} color={C.rose} list={healthL} />
          <Section icon={Gift} label={t('gifts')} color={C.violet} list={giftsL} />
          <Section icon={FileText} label={t('documents')} color={C.blue} list={docs} />
        </>
      ) : (
        <>
          <SectionTitle icon={UserRound} label={t('contact')} color={C.sky} />
          <div style={{ ...card, overflow: 'hidden' }}>
            {[['phone', Phone, 'tel:', C.green], ['email', Mail, 'mailto:', C.blue], ['company', Building2, null, C.text3], ['address', MapPin, null, C.text3], ['relationship', Heart, null, C.rose]].map(([k, Icn, href, col], idx) => {
              const val = person.meta && person.meta[k]; if (!val) return null;
              const inner = <div style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '11px 13px' }}><Icn size={15} style={{ color: col, flexShrink: 0 }} /><span style={{ fontSize: 13.5 }}>{val}</span></div>;
              return href ? <a key={k} href={href + val} style={{ textDecoration: 'none', color: C.text, display: 'block', borderTop: idx ? `1px solid ${C.borderSoft}` : 'none' }}>{inner}</a> : <div key={k} style={{ borderTop: idx ? `1px solid ${C.borderSoft}` : 'none' }}>{inner}</div>;
            })}
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
  const [adding, setAdding] = useState(false); const [sel, setSel] = useState(null);
  const persons = items.filter((i) => i.type === 'person').sort((a, b) => a.title.localeCompare(b.title));
  const current = sel && items.find((i) => i.id === sel);
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
  const kids = items.filter((i) => i.type === 'person' && isKid(i)).sort((a, b) => a.title.localeCompare(b.title));
  const current = sel && items.find((i) => i.id === sel);
  const linkedOf = (p) => items.filter((i) => i.id !== p.id && ((i.meta && i.meta.personId === p.id) || (i.person && i.person.toLowerCase() === p.title.toLowerCase())));
  let sumOpen = 0, sumEv = 0, sumGift = 0, sumSpent = 0;
  kids.forEach((p) => { const l = linkedOf(p); sumOpen += l.filter((i) => i.type === 'task' && i.status !== 'done').length; sumEv += l.filter((i) => i.date && ['event', 'appointment'].includes(i.type) && i.date >= todayISO()).length; sumGift += l.filter((i) => ['gift', 'shopping'].includes(i.type)).length; sumSpent += l.filter((i) => isMoney(i.type) && i.amount).reduce((a, b) => a + b.amount, 0); });
  if (current) return <PersonDetail person={current} items={items} people={people} lang={lang} t={t} kid back={() => setSel(null)} backLabel={t('kids')} onOpen={onOpen} toggleTask={toggleTask} addItem={addItem} updateItem={updateItem} delItem={delItem} flash={flash} />;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
      {kids.length > 0 && (
        <div style={{ ...card, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: 'flex', gap: 7, alignItems: 'center' }}><Users size={15} style={{ color: C.violet }} />{t('myKids')} · {kids.length}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <MiniStat label={t('open')} value={sumOpen} color={C.accent} />
            <MiniStat label={t('agenda')} value={sumEv} color={C.blue} />
            <MiniStat label={t('gifts')} value={sumGift} color={C.violet} />
            <MiniStat label={t('spent')} value={fmtMoney(sumSpent, lang)} color={C.green} small />
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
        {msg && <div style={{ ...card, marginTop: 12, padding: 10, fontSize: 11, color: C.rose, fontFamily: 'monospace', wordBreak: 'break-word', textAlign: 'left' }}>{msg}</div>}
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() { if (this.state.err) return this.props.fallback || null; return this.props.children; }
}

function FlightMap({ flights, lang, t }) {
  // Versao simples e a prova de falhas: mundo estilizado + rotas.
  // Sem tiles de rede (que podiam falhar/bloquear e derrubar a tela).
  const pts = {}; const routes = [];
  (flights || []).forEach((f) => {
    const a = ((f && f.meta && f.meta.from) || '').toUpperCase();
    const b = ((f && f.meta && f.meta.to) || '').toUpperCase();
    if (AIRPORTS[a] && AIRPORTS[b]) { pts[a] = AIRPORTS[a]; pts[b] = AIRPORTS[b]; routes.push([a, b]); }
  });
  const keys = Object.keys(pts);
  if (routes.length === 0) {
    return <div style={{ ...card, padding: 20, marginBottom: 12, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{t('nothingHere')}</div>;
  }
  // projecao equiretangular simples (lon/lat -> x/y), sem Mercator, sem Infinity possivel
  const W = 340, H = 180, pad = 24;
  const lons = keys.map((k) => pts[k][0]), lats = keys.map((k) => pts[k][1]);
  let minLon = Math.min(...lons), maxLon = Math.max(...lons);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats);
  if (maxLon - minLon < 8) { minLon -= 4; maxLon += 4; }
  if (maxLat - minLat < 8) { minLat -= 4; maxLat += 4; }
  const sx = (W - pad * 2) / ((maxLon - minLon) || 1);
  const sy = (H - pad * 2) / ((maxLat - minLat) || 1);
  const sc = Math.min(sx, sy);
  const cxWorld = (minLon + maxLon) / 2, cyWorld = (minLat + maxLat) / 2;
  const px = (lon) => W / 2 + (lon - cxWorld) * sc;
  const py = (lat) => H / 2 - (lat - cyWorld) * sc;

  return (
    <div style={{ ...card, padding: 10, marginBottom: 10, overflow: 'hidden' }}>
      <div style={{ borderRadius: 10, overflow: 'hidden', background: 'linear-gradient(160deg,#101826,#0b1018)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
          <defs>
            <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M28 0H0V28" fill="none" stroke="#ffffff10" strokeWidth="0.6" />
            </pattern>
          </defs>
          <rect x="0" y="0" width={W} height={H} fill="url(#grid)" />
          {routes.map(([a, b], i) => {
            const x1 = px(pts[a][0]), y1 = py(pts[a][1]), x2 = px(pts[b][0]), y2 = py(pts[b][1]);
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.abs(x2 - x1) * 0.22 - 8;
            return <path key={i} d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`} fill="none" stroke={C.accent} strokeWidth="1.5" opacity="0.85" />;
          })}
          {keys.map((k) => (
            <g key={k}>
              <circle cx={px(pts[k][0])} cy={py(pts[k][1])} r="3.4" fill={C.accent} />
              <text x={px(pts[k][0]) + 5} y={py(pts[k][1]) + 3} fill="#E8E8EE" fontSize="8.5" fontWeight="700">{k}</text>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ fontSize: 9.5, color: C.text3, marginTop: 7, textAlign: 'center' }}>{t('routeMapNote')}</div>
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
function TravelScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, updateItem, delItem, flash }) {
  const [view, setView] = useState('flights'); const [period, setPeriod] = useState('year'); const [adding, setAdding] = useState(null); const [selTrip, setSelTrip] = useState(null);
  const flights = items.filter((i) => i.type === 'flight');
  const trips = items.filter((i) => i.type === 'trip').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today = todayISO();
  const upcoming = trips.filter((tr) => ((tr.meta && tr.meta.endDate) ? tr.meta.endDate : tr.date) >= today).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const nextTrip = upcoming[0];
  const nextDays = (nextTrip && nextTrip.date) ? Math.ceil((new Date(nextTrip.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
  const year = today.slice(0, 4);
  const yf = period === 'year' ? flights.filter((f) => (f.date || '').startsWith(year)) : flights;
  const hours = yf.reduce((a, b) => a + (Number(b.meta && b.meta.durationMin) || 0), 0) / 60;
  const airports = new Set(); yf.forEach((f) => { if (f.meta && f.meta.from) airports.add(f.meta.from.toUpperCase()); if (f.meta && f.meta.to) airports.add(f.meta.to.toUpperCase()); });
  const airlines = new Set(yf.map((f) => f.meta && f.meta.airline).filter(Boolean));
  const flog = [...yf].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const current = selTrip && items.find((i) => i.id === selTrip);
  if (current) return <TripDetail trip={current} items={items} people={people} lang={lang} t={t} back={() => setSelTrip(null)} onOpen={onOpen} toggleTask={toggleTask} addItem={addItem} updateItem={updateItem} delItem={delItem} flash={flash} />;
  return (
    <div>
      <ModuleHeader module={module} t={t} back={back} />
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 10 }}><Chip active={period === 'year'} onClick={() => setPeriod('year')}>{t('thisYear')}</Chip><Chip active={period === 'all'} onClick={() => setPeriod('all')}>{t('allTime')}</Chip></div>
          <ErrorBoundary fallback={<div style={{ ...card, padding: 18, marginBottom: 12, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{t('mapUnavailable')}</div>}><FlightMap flights={yf} lang={lang} t={t} /></ErrorBoundary>
          <HintCard icon={Mail} text={t('travelCrawlNote')} />
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
function ItemView({ item, lang, t, onAct }) {
  const Ic = typeIcon(item.type); const mt = item.meta || {}; const metaFields = META[item.type] || [];
  const rows = metaFields.filter(([k]) => k !== 'attachments' && (mt[k] || mt[k] === 0) && mt[k] !== '').map(([k, ptL, enL]) => [lang === 'pt' ? ptL : enL, String(mt[k])]);
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
      {item.notes && <div style={{ ...card, padding: 14, marginBottom: 12, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{item.notes}</div>}
      {atts.length > 0 && <><div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{t('attachments')}</div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{atts.map((a) => <AttachThumb key={a.id} att={a} />)}</div></>}
    </div>
  );
}
function ItemDetail({ item, lang, t, people, onClose, onSave, onDelete, onAct }) {
  const [editing, setEditing] = useState(false);
  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{t('t_' + item.type)}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!editing && !(item.meta && item.meta.external) && <button onClick={() => setEditing(true)} style={{ ...card, padding: 7, color: C.accent, cursor: 'pointer' }}><Pencil size={15} /></button>}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer' }}><X size={20} /></button>
        </div>
      </div>
      {editing
        ? <ItemForm draft={item} allowedTypes={[item.type]} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { onDelete(item.id); onClose(); }} onSave={(x) => { onSave(item.id, x); setEditing(false); }} />
        : <ItemView item={item} lang={lang} t={t} onAct={onAct} />}
    </Modal>
  );
}

/* ---------------- Settings ---------------- */
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
    <div style={{ marginBottom: 14 }}>
      <Row id="oura" label="Oura Ring" icon={Activity} color={C.green} />
      <Row id="google" label="Gmail + Google Agenda" icon={Mail} color={C.blue} />
    </div>
  );
}

function SettingsSheet({ settings, setSettings, lang, t, items, setItems, onClose }) {
  const [name, setName] = useState(settings.name);
  const dock = settings.dock || DEFAULT_DOCK;
  const toggleDock = (k) => setSettings((s) => { const cur = s.dock || DEFAULT_DOCK; const has = cur.includes(k); if (has) return { ...s, dock: cur.filter((x) => x !== k) }; if (cur.length >= 5) return s; return { ...s, dock: [...cur, k] }; });
  const exportJSON = () => { const blob = new Blob([JSON.stringify({ items, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'life-control-export.json'; a.click(); URL.revokeObjectURL(url); };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('settings')} onClose={onClose} icon={Cog} />
      <Field label={t('name')}><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setSettings((s) => ({ ...s, name }))} style={inputStyle} /></Field>
      <Field label={t('height') + ' (cm)'}><input type="number" value={settings.profile && settings.profile.height || ''} onChange={(e) => setSettings((s) => ({ ...s, profile: { ...(s.profile || {}), height: e.target.value } }))} style={inputStyle} /></Field>
      <Field label={t('language')}><div style={{ display: 'flex', gap: 8 }}><Chip active={lang === 'pt'} onClick={() => setSettings((s) => ({ ...s, lang: 'pt' }))}>Português (BR)</Chip><Chip active={lang === 'en'} onClick={() => setSettings((s) => ({ ...s, lang: 'en' }))}>English (US)</Chip></div></Field>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{t('editDock')}</div>
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8 }}>{t('dockHint')} ({dock.length}/5)</div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
        {DOCKABLE.map((k) => { const on = dock.includes(k); const Ic = navIcon(k); return (
          <button key={k} onClick={() => toggleDock(k)} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '7px 11px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, background: on ? C.accentSoft : 'transparent', color: on ? C.accent : C.text2, border: `1px solid ${on ? C.accent + '55' : C.border}` }}><Ic size={14} />{navLabel(k, t)}</button>
        ); })}
      </div>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', margin: '4px 0 8px' }}>{t('connections')}</div>
      <Connections lang={lang} t={t} />
      <Btn kind="soft" onClick={() => { if (confirm(t('reloadConfirm'))) { setItems(SEED()); setSettings((s) => ({ ...s, ...SEED_SETTINGS })); persistSeeded(); onClose(); } }} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><RefreshCw size={15} />{t('reloadSamples')}</Btn>
      <Btn kind="soft" onClick={exportJSON} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Download size={15} />{t('exportData')}</Btn>
      <Btn kind="soft" onClick={() => document.getElementById('lcc-import').click()} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Paperclip size={15} />{lang === 'pt' ? 'Importar JSON' : 'Import JSON'}</Btn>
      <input id="lcc-import" type="file" accept="application/json" style={{ display: 'none' }} onChange={async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const txt = await f.text(); const n = await importExportedJson(txt); alert((lang === 'pt' ? 'Importados: ' : 'Imported: ') + n); window.location.reload(); }
        catch (err) { alert('Erro: ' + err.message); }
        e.target.value = '';
      }} />
      <Btn kind="ghost" onClick={async () => { await supabase.auth.signOut(); window.location.reload(); }} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>{lang === 'pt' ? 'Sair da conta' : 'Sign out'}</Btn>
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

/* ---------------- App ---------------- */
function App() {
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState({ lang: 'pt', name: 'Bruno', health: {}, profile: {}, dock: DEFAULT_DOCK, devices: DEFAULT_DEVICES });
  const [active, setActive] = useState({ screen: 'home', module: null });
  const [detail, setDetail] = useState(null); const [showCapture, setShowCapture] = useState(false); const [showSettings, setShowSettings] = useState(false);
  const [claudeSeed, setClaudeSeed] = useState(null); const [toast, setToast] = useState(null); const [undo, setUndo] = useState(null); const undoRef = useRef();
  const [ouraByDate, setOuraByDate] = useState({}); const [ouraOn, setOuraOn] = useState(false); const [lastSleep, setLastSleep] = useState(null);
  const [gmail, setGmail] = useState({ loading: true, connected: false, messages: [], error: null });
  const [gEvents, setGEvents] = useState([]); const [gMsgs, setGMsgs] = useState([]);
  const lang = settings.lang; const t = makeT(lang);
  const people = items.filter((i) => i.type === 'person');
  const dock = settings.dock && settings.dock.length ? settings.dock : DEFAULT_DOCK;

  useEffect(() => { (async () => {
    const s = await loadState();
    if (s.items && s.items.length) setItems(s.items);
    else if (!s.seeded) { setItems(SEED()); persistSeeded(); }
    else setItems([]);
    if (s.settings) setSettings((p) => ({ ...p, ...s.settings, health: s.settings.health || {}, profile: s.settings.profile || {}, dock: s.settings.dock || DEFAULT_DOCK, devices: s.settings.devices || DEFAULT_DEVICES }));
    else setSettings((p) => ({ ...p, ...SEED_SETTINGS }));
    setReady(true);
  })(); }, []);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    authFetch('/api/oura').then((r) => r.json()).then((j) => { if (!alive || !j) return; if (j.byDate) setOuraByDate(j.byDate); if (j.lastSleep) setLastSleep(j.lastSleep); setOuraOn(!!j.connected); }).catch(() => {});
    loadGmail();
    authFetch('/api/google').then((r) => r.json()).then((j) => {
      if (!alive || !j) return;
      if (Array.isArray(j.events)) setGEvents(j.events);
      if (Array.isArray(j.messages)) setGMsgs(j.messages);
    }).catch(() => {});
    return () => { alive = false; };
  }, [ready]);

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

  // ---- Pull-to-refresh (puxar pra baixo no topo) ----
  const [pull, setPull] = useState(0); const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef({ y0: 0, active: false });
  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const jobs = [refreshGoogle(), loadGmail()];
      await Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => {})));
      // recarrega Oura tambem
      try { const j = await (await authFetch('/api/oura')).json(); if (j) { if (j.byDate) setOuraByDate(j.byDate); if (j.lastSleep) setLastSleep(j.lastSleep); setOuraOn(!!j.connected); } } catch (e) {}
    } finally { setTimeout(() => setRefreshing(false), 300); }
  };
  const onTouchStart = (e) => {
    const sc = document.scrollingElement || document.documentElement;
    if (sc.scrollTop <= 0 && !refreshing) { pullRef.current = { y0: e.touches[0].clientY, active: true }; }
  };
  const onTouchMove = (e) => {
    if (!pullRef.current.active) return;
    const dy = e.touches[0].clientY - pullRef.current.y0;
    if (dy > 0) { setPull(Math.min(90, dy * 0.5)); }
  };
  const onTouchEnd = () => {
    if (!pullRef.current.active) return;
    pullRef.current.active = false;
    if (pull > 55) doRefresh();
    setPull(0);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const conn = q.get('conn');
    if (!conn) return;
    const okMsg = conn === 'oura' ? 'Oura conectado ✓' : 'Google conectado ✓';
    setToast(q.get('ok') ? okMsg : 'Erro: ' + (q.get('erro') || ''));
    setTimeout(() => setToast(null), 4000);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);
  const persistNow = (next) => { persistItems(next).then(() => { if (typeof window !== 'undefined' && window.__lccSaveError) flash(t('saveError')); }); return next; };
  const addItems = (arr) => setItems((p) => persistNow([...arr.map((x) => ({ id: uid(), createdAt: Date.now(), status: 'planned', currency: 'BRL', meta: {}, ...x })), ...p]));
  const addItem = (x) => addItems([x]);
  const updateItem = (id, patch) => setItems((p) => persistNow(p.map((i) => (i.id === id ? { ...i, ...patch } : i))));
  const toggleTask = (id) => {
    const it = items.find((i) => i.id === id);
    setItems((p) => persistNow(p.map((i) => (i.id === id ? { ...i, status: i.status === 'done' ? 'planned' : 'done' } : i))));
    clearTimeout(undoRef.current);
    if (it && it.status !== 'done') { setUndo(id); undoRef.current = setTimeout(() => setUndo(null), 3200); } else setUndo(null);
  };
  const delItem = (id) => setItems((p) => persistNow(p.filter((i) => i.id !== id)));
  const setHealth = (fn) => setSettings((s) => ({ ...s, health: typeof fn === 'function' ? fn(s.health || {}) : fn }));
  const setProfile = (fn) => setSettings((s) => ({ ...s, profile: typeof fn === 'function' ? fn(s.profile || {}) : fn }));
  const addWeight = (kg) => setSettings((s) => {
    const d = todayISO();
    const list = (s.weights || []).filter((x) => x.date !== d).concat([{ date: d, kg }]);
    return { ...s, weights: list.slice(-120), profile: { ...(s.profile || {}), weight: kg } };
  });
  const setDevices = (fn) => setSettings((s) => ({ ...s, devices: typeof fn === 'function' ? fn(s.devices || DEFAULT_DEVICES) : fn }));
  const setTuyaPrefs = (fn) => setSettings((s) => ({ ...s, tuyaPrefs: typeof fn === 'function' ? fn(s.tuyaPrefs || {}) : fn }));
  const openModuleKey = (key) => setActive({ screen: 'dashboard', module: moduleByKey(key) });
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? t('goodMorning') : h < 18 ? t('goodAfternoon') : t('goodEvening'); };
  const navTo = (k) => { if (SCREEN_ICONS[k]) setActive({ screen: k, module: k === 'dashboard' ? null : null }); else setActive({ screen: 'dashboard', module: moduleByKey(k) }); };

  if (!ready) return <div style={{ background: C.bg, color: C.text3, height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 className="spin" size={22} /></div>;

  const allItems = (gEvents.length || gMsgs.length) ? [...items, ...gEvents, ...gMsgs] : items;
  const mergedHealth = { ...(settings.health || {}), ...ouraByDate };
  const shared = { items: allItems, people, lang, t, toggleTask, onOpen: setDetail, addItem, updateItem, delItem, flash };
  const renderModule = (mo) => {
    const back = () => setActive({ screen: 'dashboard', module: null });
    if (mo.custom === 'travel') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><TravelScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'cars') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><CarsScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'people') return <ErrorBoundary fallback={(msg) => <ModuleErrorCard t={t} back={back} module={mo} msg={msg} />}><PeopleScreen module={mo} {...shared} back={back} /></ErrorBoundary>;
    if (mo.custom === 'finance') return <FinanceScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'health') return <HealthScreen module={mo} {...shared} back={back} health={mergedHealth} setHealth={setHealth} ouraOn={ouraOn} lastSleep={lastSleep} weights={settings.weights || []} addWeight={addWeight} profile={settings.profile || {}} setProfile={setProfile} />;
    if (mo.custom === 'house') return <HouseScreen module={mo} {...shared} back={back} devices={settings.devices || DEFAULT_DEVICES} setDevices={setDevices} tuyaPrefs={settings.tuyaPrefs || {}} setTuyaPrefs={setTuyaPrefs} />;
    if (mo.custom === 'kids') return <KidsScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'docs') return <DocsScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'gmail') return <GmailScreen module={mo} lang={lang} t={t} back={back} state={gmail} setState={setGmail} load={loadGmail} />;
    return <ModuleScreen module={mo} {...shared} back={back} />;
  };

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} style={{ background: C.bg, color: C.text, minHeight: '100vh', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', maxWidth: 480, margin: '0 auto', position: 'relative', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)' }}>
      <div style={{ height: refreshing ? 44 : pull, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: pullRef.current.active ? 'none' : 'height .2s', color: C.text3 }}>
        {(refreshing || pull > 10) && <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12 }}><RefreshCw size={15} className={refreshing ? 'spin' : ''} style={{ transform: refreshing ? 'none' : `rotate(${pull * 4}deg)` }} />{refreshing ? t('refreshing') : (pull > 55 ? t('releaseRefresh') : t('pullRefresh'))}</div>}
      </div>
      <style>{`.spin{animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}@keyframes pop{0%{transform:scale(.5)}55%{transform:scale(1.18)}100%{transform:scale(1)}}@keyframes slideup{from{transform:translate(-50%,14px);opacity:0}to{transform:translate(-50%,0);opacity:1}} *::-webkit-scrollbar{width:0} input,textarea,select{font-family:inherit} select option{background:#16161E}`}</style>
      <div style={{ padding: '16px 18px 8px', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: C.accent }} />Life Control</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setSettings((s) => ({ ...s, lang: s.lang === 'pt' ? 'en' : 'pt' }))} style={{ ...card, padding: '5px 10px', color: C.text2, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}><Globe size={13} />{lang.toUpperCase()}</button>
          <button onClick={() => setShowSettings(true)} style={{ ...card, padding: 7, color: C.text2, cursor: 'pointer' }}><Cog size={15} /></button>
        </div>
      </div>
      <div style={{ padding: '0 16px' }}>
        {active.screen === 'home' && <TodayScreen {...shared} greeting={greeting} name={settings.name} addItems={addItems} health={mergedHealth} setHealth={setHealth} ouraOn={ouraOn} goModule={openModuleKey} openClaude={(q) => setClaudeSeed(q)} goNews={() => setActive({ screen: 'news', module: null })} />}
        {active.screen === 'news' && <NewsScreen lang={lang} t={t} back={() => setActive({ screen: 'home', module: null })} />}
        {active.screen === 'messages' && <MessagesScreen {...shared} setItems={setItems} />}
        {active.screen === 'calendar' && <CalendarScreen {...shared} onRefresh={refreshGoogle} onMount={refreshGoogle} />}
        {active.screen === 'claude' && <ClaudeScreen items={allItems} lang={lang} t={t} name={settings.name} />}
        {active.screen === 'dashboard' && (active.module ? renderModule(active.module) : <DashboardScreen items={allItems} lang={lang} t={t} gmailCount={gmail.messages.length} open={(mo) => setActive({ screen: 'dashboard', module: mo })} />)}
      </div>

      {active.screen !== 'claude' && (
        <div style={{ position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)', left: 0, right: 0, zIndex: 30, pointerEvents: 'none' }}>
          <div style={{ maxWidth: 480, margin: '0 auto', position: 'relative', height: 0 }}>
            <button onClick={() => setShowCapture(true)} style={{ position: 'absolute', right: 18, bottom: 0, pointerEvents: 'auto', background: C.accent, color: '#171200', border: 'none', width: 52, height: 52, borderRadius: 16, cursor: 'pointer', boxShadow: '0 8px 24px rgba(230,180,80,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={24} /></button>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'rgba(11,11,15,.9)', backdropFilter: 'blur(12px)', borderTop: `1px solid ${C.borderSoft}`, zIndex: 20 }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', justifyContent: 'space-around', padding: '9px 4px 12px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
          {dock.map((k) => {
            const Ic = navIcon(k); const isMod = !SCREEN_ICONS[k];
            const activeK = isMod ? (active.module && active.module.key === k) : (active.screen === k && (k !== 'dashboard' || !active.module));
            const badge = k === 'messages' ? allItems.filter((i) => i.type === 'message' && i.meta && i.meta.unread).length + allItems.filter((i) => i.status === 'inbox').length : 0;
            return <button key={k} onClick={() => navTo(k)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: activeK ? C.accent : C.text3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, position: 'relative', padding: '2px 8px' }}>
              <Ic size={21} /><span style={{ fontSize: 10.5 }}>{navLabel(k, t)}</span>
              {badge > 0 && <span style={{ position: 'absolute', top: -3, right: 4, background: C.rose, color: '#fff', fontSize: 9, borderRadius: 999, minWidth: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{badge}</span>}
            </button>;
          })}
        </div>
      </div>

      {showCapture && <CaptureSheet lang={lang} t={t} onClose={() => setShowCapture(false)} addItems={addItems} flash={flash} />}
      {showSettings && <SettingsSheet settings={settings} setSettings={setSettings} lang={lang} t={t} items={items} setItems={setItems} onClose={() => setShowSettings(false)} />}
      {detail && <ItemDetail item={detail} lang={lang} t={t} people={people} onClose={() => setDetail(null)} onSave={updateItem} onDelete={delItem} onAct={(patch) => { updateItem(detail.id, patch); setDetail((d) => ({ ...d, ...patch, meta: { ...(d.meta || {}), ...(patch.meta || {}) } })); }} />}
      {undo && <div style={{ position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)', background: C.surface2, border: `1px solid ${C.border}`, color: C.text, padding: '8px 10px 8px 16px', borderRadius: 999, fontSize: 13, zIndex: 60, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 12, animation: 'slideup .2s ease' }}><span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><CircleCheck size={15} style={{ color: C.green }} />{t('doneLabel')}</span><button onClick={() => toggleTask(undo)} style={{ background: 'none', border: 'none', color: C.accent, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>{t('undo')}</button></div>}
      {claudeSeed && <ClaudeOverlay seed={claudeSeed} onClose={() => setClaudeSeed(null)} items={allItems} lang={lang} t={t} name={settings.name} />}
      {toast && <div style={{ position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)', background: C.surface2, border: `1px solid ${C.border}`, color: C.text, padding: '9px 16px', borderRadius: 999, fontSize: 13, zIndex: 60, whiteSpace: 'nowrap' }}>{toast}</div>}
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
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setBooted(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { kvCache.clear(); setSession(s); });
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!booted) return <div style={{ background: '#0B0B0F', color: '#63636F', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui' }}>…</div>;
  if (!session) return <Login />;
  return <App />;
}
