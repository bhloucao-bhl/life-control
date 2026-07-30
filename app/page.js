'use client';
import { useState, useEffect, useRef } from 'react';
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
      if (error) { console.error('storage.set', error); return null; }
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
  MapPin, Building2, Pencil
} from 'lucide-react';

/* ---------------- palette ---------------- */
const C = {
  bg: '#0B0B0F', bg2: '#101017', surface: '#16161E', surface2: '#1D1D27',
  border: '#282833', borderSoft: '#1E1E28',
  text: '#ECECEF', text2: '#9C9CA8', text3: '#63636F',
  accent: '#E6B450', accentSoft: 'rgba(230,180,80,0.13)',
  rose: '#F0787C', green: '#5FBF8F', blue: '#6BA6E6', violet: '#9B8CF0',
  teal: '#5FB3B3', sky: '#7CC0E8',
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
  connectOura: L('Conecte o Oura ou toque para registrar hoje.', 'Connect Oura or tap to log today.'),
  weather: L('Clima', 'Weather'), weatherSoon: L('Tempo real (open-meteo) na versão no celular.', 'Live weather in the phone version.'),
  news: L('Notícias', 'News'), newsSoon: L('5 principais dos seus temas — entra com o deploy.', 'Top 5 — arrives at deploy.'),
  seeAll: L('Ver todas', 'See all'), newsExample: L('Exemplos. No deploy vira feed real dos seus temas e a manchete abre no navegador.', 'Examples. At deploy this becomes a real feed and headlines open in the browser.'),
  openBrowser: L('Abrir no navegador', 'Open in browser'), fxHint: L('Cotação comercial, atualizada automaticamente.', 'Market rate, updated automatically.'),
  reloadSamples: L('Recarregar dados de exemplo', 'Reload sample data'), reloadConfirm: L('Substituir tudo pelos dados de exemplo?', 'Replace everything with sample data?'),
  weatherLive: L('Tempo real', 'Live'), feels: L('Sensação', 'Feels'),
  weatherOff: L('Clima indisponível agora.', 'Weather unavailable right now.'), fxOff: L('Cotação indisponível.', 'Rates unavailable.'),
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
  { key: 'docs', icon: FileText, color: C.blue, filter: (i) => i.type === 'document' || i.domain === 'docs', types: ['document'], custom: 'docs' },
  { key: 'cars', icon: Car, color: C.teal, filter: (i) => i.domain === 'cars' || i.type === 'vehicle', types: ['vehicle', 'maintenance', 'expense', 'document', 'note'], custom: 'cars' },
  { key: 'travel', icon: Plane, color: C.violet, filter: (i) => i.domain === 'travel' || i.type === 'trip' || i.type === 'flight', types: ['trip', 'flight', 'note'], custom: 'travel' },
];
const moduleByKey = (k) => MODULES.find((m) => m.key === k);
const moduleDomain = (k) => (k === 'house' ? 'home' : k === 'tasks' || k === 'people' ? 'personal' : k);

const SCREEN_ICONS = { home: Sun, messages: MessageSquare, calendar: CalIcon, dashboard: LayoutGrid, claude: Sparkles };
const DOCKABLE = ['home', 'messages', 'calendar', 'dashboard', 'claude', 'tasks', 'finance', 'health', 'house', 'travel', 'cars', 'kids', 'people', 'docs'];
const DEFAULT_DOCK = ['home', 'messages', 'calendar', 'dashboard', 'claude'];
function navIcon(k) { return SCREEN_ICONS[k] || (moduleByKey(k) ? moduleByKey(k).icon : Circle); }
function navLabel(k, t) { return k === 'dashboard' ? t('dashShort') : t(k); }
const DEFAULT_DEVICES = [
  { id: 'd1', name: 'Ar — Quarto', type: 'ac', on: false, temp: 22, fan: 2 },
  { id: 'd2', name: 'Luz — Sala', type: 'light', on: false },
  { id: 'd3', name: 'Ventilador — Escritório', type: 'fan', on: false, fan: 1 },
];

/* ---------------- storage ---------------- */
const STORE_KEY = 'lcc_items_v1', SETTINGS_KEY = 'lcc_settings_v1';
const hasStore = typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function';
const memAtt = {};
async function loadState() {
  let items = [], settings = null;
  if (hasStore) {
    try { const r = await window.storage.get(STORE_KEY); if (r && r.value) items = JSON.parse(r.value); } catch (e) {}
    try { const r = await window.storage.get(SETTINGS_KEY); if (r && r.value) settings = JSON.parse(r.value); } catch (e) {}
  }
  return { items, settings };
}
async function persistItems(x) { if (hasStore) { try { await window.storage.set(STORE_KEY, JSON.stringify(x)); } catch (e) {} } }
async function persistSettings(x) { if (hasStore) { try { await window.storage.set(SETTINGS_KEY, JSON.stringify(x)); } catch (e) {} } }
async function saveAttachment(dataUrl, name, kind) {
  const id = 'att_' + uid();
  if (hasStore) { try { await window.storage.set('lcc_' + id, JSON.stringify({ dataUrl, name, kind })); } catch (e) { memAtt[id] = { dataUrl, name, kind }; } } else memAtt[id] = { dataUrl, name, kind };
  return { id, name, kind };
}
async function loadAttachment(id) {
  if (memAtt[id]) return memAtt[id];
  if (hasStore) { try { const r = await window.storage.get('lcc_' + id); if (r && r.value) return JSON.parse(r.value); } catch (e) {} }
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
const card = { background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 16 };
const inputStyle = { width: '100%', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, padding: '10px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box' };
function Btn({ children, onClick, kind = 'primary', style, disabled }) {
  const kinds = { primary: { background: C.accent, color: '#171200', border: 'none', fontWeight: 600 }, ghost: { background: 'transparent', color: C.text2, border: `1px solid ${C.border}` }, soft: { background: C.surface2, color: C.text, border: `1px solid ${C.border}` }, danger: { background: 'transparent', color: C.rose, border: `1px solid ${C.rose}55` } };
  return <button onClick={onClick} disabled={disabled} style={{ padding: '10px 14px', borderRadius: 12, fontSize: 14, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, ...kinds[kind], ...style }}>{children}</button>;
}
function Chip({ children, active, onClick, color }) {
  return <button onClick={onClick} style={{ padding: '6px 11px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap', background: active ? (color ? color + '22' : C.accentSoft) : 'transparent', color: active ? (color || C.accent) : C.text2, border: `1px solid ${active ? (color || C.accent) + '55' : C.border}` }}>{children}</button>;
}
function Field({ label, children }) {
  return <label style={{ display: 'block', marginBottom: 10 }}><div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>{label}</div>{children}</label>;
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
  return <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '18px 2px 10px' }}><Icon size={14} style={{ color: color || C.text2 }} /><span style={{ fontSize: 12.5, color: C.text2, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>{label}</span></div>;
}
function ScreenTitle({ title, sub }) {
  return <div style={{ margin: '4px 2px 16px' }}><div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.01em' }}>{title}</div>{sub && <div style={{ fontSize: 13, color: C.text3, marginTop: 3 }}>{sub}</div>}</div>;
}
function MiniStat({ label, value, color, small }) {
  return <div style={{ ...card, padding: '10px 12px', flex: 1, minWidth: 0 }}>
    <div style={{ fontSize: small ? 15 : 19, fontWeight: 700, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    <div style={{ fontSize: 10.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 2 }}>{label}</div>
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
        <div style={{ fontSize: 14.5, color: item.status === 'done' ? C.text3 : C.text, textDecoration: item.status === 'done' ? 'line-through' : 'none', lineHeight: 1.35, display: 'flex', gap: 6, alignItems: 'center' }}>{mile && <Star size={12} style={{ color: C.accent, flexShrink: 0 }} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: C.text3 }}>{t('t_' + item.type)}</span>
          {item.date && <span style={{ fontSize: 11.5, color: overdue ? C.rose : C.text2, display: 'inline-flex', alignItems: 'center', gap: 3 }}>{overdue ? <AlertTriangle size={11} /> : <Clock size={11} />}{fmtDate(item.date, lang)}{item.time ? ' · ' + item.time : ''}</span>}
          {item.amount != null && <span style={{ fontSize: 11.5, color: C.green }}>{fmtMoney(item.amount, lang)}</span>}
          {item.person && <span style={{ fontSize: 11.5, color: C.text3 }}>· {item.person}</span>}
          {item.meta && item.meta.attachments && item.meta.attachments.length > 0 && <Paperclip size={11} style={{ color: C.text3 }} />}
          {item.priority === 1 && item.status !== 'done' && <span style={{ fontSize: 10.5, color: C.accent, border: `1px solid ${C.accent}44`, borderRadius: 999, padding: '1px 7px' }}>{t('high')}</span>}
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

function WeatherCard({ lang, t, wx, loading }) {
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
    <div style={{ ...card, padding: 14, marginBottom: 10 }}>
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
          <div>↑{wx.hi}° ↓{wx.lo}°</div>
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
function ScoreRing({ label, value, color, onClick }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <button onClick={onClick} style={{ ...card, flex: 1, padding: 12, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
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
function TodayScreen({ items, lang, t, greeting, name, toggleTask, onOpen, addItems, flash, health, setHealth, goModule, openClaude, goNews }) {
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
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{fmtMoney(fx.value, lang)}</span>
              <span style={{ fontSize: 8.5, color: fx.pct < 0 ? C.rose : C.green }}>{fx.pct < 0 ? '▼' : '▲'}{Math.abs(fx.pct).toFixed(2)}%</span>
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
        <ScoreRing label={t('readiness')} value={w.readiness ?? null} color={C.green} onClick={() => setLogOpen(true)} />
        <ScoreRing label={t('sleepScore')} value={w.sleep ?? null} color={C.violet} onClick={() => setLogOpen(true)} />
      </div>
      {w.readiness == null && w.sleep == null && <div style={{ fontSize: 11.5, color: C.text3, textAlign: 'center', margin: '-2px 0 12px' }}>{t('connectOura')}</div>}
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
      {logOpen && <WellnessLog current={w} lang={lang} t={t} onSave={(v) => setHealth((h) => ({ ...h, [today]: v }))} onClose={() => setLogOpen(false)} />}
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
  const msgs = items.filter((i) => i.type === 'message').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const triage = items.filter((i) => i.status === 'inbox');
  const unread = msgs.filter((m) => m.meta && m.meta.unread).length;
  const accept = (id) => setItems((p) => p.map((i) => (i.id === id ? { ...i, status: 'planned' } : i)));
  return (
    <div>
      <ScreenTitle title={t('messages')} sub={`${unread} ${t('unread')}`} />
      <Btn kind="soft" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 14, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center' }}><Plus size={16} />{t('t_message')}</Btn>
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
function CalendarScreen({ items, lang, t, toggleTask, onOpen }) {
  const [mode, setMode] = useState('week'); const today = todayISO(); const [sel, setSel] = useState(today); const [vm, setVm] = useState(today.slice(0, 7)); const [filter, setFilter] = useState(null); const [scope, setScope] = useState('all');
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
        <div style={{ display: 'flex', gap: 6 }}><Chip active={mode === 'week'} onClick={() => setMode('week')}>{t('week')}</Chip><Chip active={mode === 'month'} onClick={() => setMode('month')}>{t('month')}</Chip></div>
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
function DashboardScreen({ items, lang, t, open }) {
  return (
    <div>
      <ScreenTitle title={t('dashboard')} sub={t('yourModules')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {MODULES.map((mo) => { const count = items.filter(mo.filter).length; const Ic = mo.icon; return (
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
function HealthScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash, health, setHealth, profile, setProfile }) {
  const [adding, setAdding] = useState(null); const [logOpen, setLogOpen] = useState(false); const [editP, setEditP] = useState(false);
  const today = todayISO(); const w = health[today] || {};
  const hd = items.filter((i) => i.domain === 'health');
  const consultas = hd.filter((i) => i.type === 'appointment' && i.date && i.date >= today).sort((a, b) => a.date.localeCompare(b.date));
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
        <ScoreRing label={t('readiness')} value={w.readiness ?? null} color={C.green} onClick={() => setLogOpen(true)} />
        <ScoreRing label={t('sleepScore')} value={w.sleep ?? null} color={C.violet} onClick={() => setLogOpen(true)} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <MiniStat label={t('weight')} value={profile.weight ? profile.weight + ' kg' : '—'} color={C.rose} small />
        <MiniStat label={t('height')} value={profile.height ? profile.height + ' cm' : '—'} color={C.blue} small />
        <MiniStat label={t('bmi')} value={bmi || '—'} color={C.accent} small />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <Btn kind="soft" onClick={() => setEditP(true)} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Scale size={14} />{t('editProfile')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('appointment')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><Stethoscope size={14} />{t('consultations')}</Btn>
        <Btn kind="soft" onClick={() => setAdding('document')} style={{ flex: 1, fontSize: 12.5, display: 'flex', justifyContent: 'center', gap: 5, alignItems: 'center' }}><FileText size={14} />{t('addDoc')}</Btn>
      </div>
      <HintCard icon={Activity} text={t('appleHealth')} />
      {consultas.length > 0 && <><SectionTitle icon={Stethoscope} label={t('consultations')} color={C.rose} />{consultas.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {treat.length > 0 && <><SectionTitle icon={Pill} label={t('treatments')} color={C.violet} />{treat.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      <SectionTitle icon={Wallet} label={`${t('pharmacy')} · ${fmtMoney(pharmTotal, lang)}`} color={C.green} />
      {pharm.length === 0 ? <Empty icon={Wallet} text={t('nothingHere')} /> : pharm.slice(0, 5).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      <SectionTitle icon={Activity} label={t('exams')} color={C.blue} />
      {exams.length === 0 ? <Empty icon={Activity} text={t('nothingHere')} /> : exams.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}
      {support.length > 0 && <><SectionTitle icon={FileText} label={t('support')} color={C.text2} />{support.map((i) => <ItemRow key={i.id} item={i} lang={lang} t={t} onToggle={toggleTask} onOpen={onOpen} />)}</>}
      {logOpen && <WellnessLog current={w} lang={lang} t={t} onSave={(v) => setHealth((h) => ({ ...h, [today]: v }))} onClose={() => setLogOpen(false)} />}
      {editP && <Modal onClose={() => setEditP(false)}><SheetHead title={t('editProfile')} onClose={() => setEditP(false)} icon={Scale} /><Field label={t('weight') + ' (kg)'}><input type="number" defaultValue={profile.weight || ''} onBlur={(e) => setProfile((p) => ({ ...p, weight: e.target.value }))} style={inputStyle} /></Field><Field label={t('height') + ' (cm)'}><input type="number" defaultValue={profile.height || ''} onBlur={(e) => setProfile((p) => ({ ...p, height: e.target.value }))} style={inputStyle} /></Field><Btn onClick={() => setEditP(false)} style={{ width: '100%' }}>{t('save')}</Btn></Modal>}
      {adding && <AddModal title={t('t_' + adding)} icon={typeIcon(adding)} draft={{ type: adding, domain: 'health', meta: {} }} allowedTypes={module.types} lang={lang} t={t} people={people} onClose={() => setAdding(null)} onSave={(x) => { addItem({ domain: 'health', ...x }); flash(t('savedOne')); setAdding(null); }} />}
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
function HouseScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, flash, devices, setDevices }) {
  const [adding, setAdding] = useState(false); const [filterAll, setFilterAll] = useState(false);
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
      <SectionTitle icon={Power} label={t('devices')} color={C.accent} />
      <HintCard icon={Power} text={t('deviceHint')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{devices.map((d) => <DeviceCard key={d.id} device={d} onChange={upd} />)}</div>
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
        <div style={{ width: 56, height: 56, borderRadius: 999, background: (kid ? C.violet : C.sky) + '22', color: kid ? C.violet : C.sky, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700 }}>{initials(person.title)}</div>
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
      {editing && <Modal onClose={() => setEditing(false)}><SheetHead title={person.title} onClose={() => setEditing(false)} icon={UserRound} /><ItemForm draft={person} allowedTypes={['person']} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { delItem(person.id); setEditing(false); back(); }} onSave={(x) => { updateItem(person.id, x); setEditing(false); }} /></Modal>}
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
          <div style={{ width: 42, height: 42, borderRadius: 999, background: C.sky + '22', color: C.sky, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{initials(p.title)}</div>
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
            <div style={{ width: 48, height: 48, borderRadius: 999, background: C.violet + '22', color: C.violet, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, flexShrink: 0 }}>{initials(p.title)}</div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 600 }}>{p.title}</div><div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>{linked.length} {t('items')}{open ? ` · ${open} ${t('open').toLowerCase()}` : ''}</div></div>
            <ChevronRight size={16} style={{ color: C.text3 }} />
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Travel ---------------- */
function FlightMap({ flights, lang, t }) {
  const pts = {}; const routes = [];
  flights.forEach((f) => { const a = ((f.meta && f.meta.from) || '').toUpperCase(), b = ((f.meta && f.meta.to) || '').toUpperCase(); if (AIRPORTS[a] && AIRPORTS[b]) { pts[a] = AIRPORTS[a]; pts[b] = AIRPORTS[b]; routes.push([a, b]); } });
  const keys = Object.keys(pts); const proj = ([lon, lat]) => [lon + 180, 90 - lat];
  if (routes.length === 0) return <div style={{ ...card, padding: 20, marginBottom: 12, textAlign: 'center', color: C.text3, fontSize: 12.5 }}>{t('nothingHere')}</div>;
  return (
    <div style={{ ...card, padding: 10, marginBottom: 10, overflow: 'hidden' }}>
      <svg viewBox="0 0 360 180" style={{ width: '100%', display: 'block', background: '#0d1420', borderRadius: 10 }}>
        {[30, 60, 90, 120, 150, 210, 240, 270, 300, 330].map((x) => <line key={'v' + x} x1={x} y1={0} x2={x} y2={180} stroke="#1b2636" strokeWidth="0.4" />)}
        {[30, 60, 120, 150].map((y) => <line key={'h' + y} x1={0} y1={y} x2={360} y2={y} stroke="#1b2636" strokeWidth="0.4" />)}
        <line x1="0" y1="90" x2="360" y2="90" stroke="#223348" strokeWidth="0.6" />
        {routes.map(([a, b], i) => { const [x1, y1] = proj(pts[a]), [x2, y2] = proj(pts[b]); const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.abs(x2 - x1) * 0.14 - 5; return <path key={i} d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`} fill="none" stroke={C.accent} strokeWidth="0.9" opacity="0.75" />; })}
        {keys.map((k) => { const [x, y] = proj(pts[k]); return <g key={k}><circle cx={x} cy={y} r="1.9" fill={C.accent} /><text x={x + 3} y={y + 1.5} fill="#cfd6e0" fontSize="5">{k}</text></g>; })}
      </svg>
      <div style={{ fontSize: 10.5, color: C.text3, marginTop: 8, textAlign: 'center' }}>{t('routeMapNote')}</div>
    </div>
  );
}
function FlightRow({ f, lang, t, onOpen }) {
  const mt = f.meta || {};
  return (
    <div onClick={() => onOpen(f)} style={{ ...card, padding: '13px 14px', marginBottom: 8, cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ fontSize: 16, fontWeight: 700 }}>{(mt.from || '???').toUpperCase()}</span><ArrowRight size={15} style={{ color: C.text3 }} /><span style={{ fontSize: 16, fontWeight: 700 }}>{(mt.to || '???').toUpperCase()}</span></div>
        {(mt.attachments && mt.attachments.length > 0) && <Ticket size={15} style={{ color: C.accent }} />}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap', fontSize: 11.5, color: C.text3 }}>
        {mt.airline && <span>{mt.airline}{mt.flightNumber ? ' ' + mt.flightNumber : ''}</span>}
        {f.date && <span>· {fmtDate(f.date, lang)}{f.time ? ' ' + f.time : ''}</span>}
        {mt.seat && <span>· {lang === 'pt' ? 'Assento' : 'Seat'} {mt.seat}</span>}
        {mt.durationMin && <span>· {(mt.durationMin / 60).toFixed(1)}h</span>}
      </div>
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
  const days = Math.ceil((new Date(trip.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  const cd = days > 1 ? `${days} ${t('daysWord')}` : days === 1 ? (lang === 'pt' ? 'amanhã' : 'tomorrow') : days === 0 ? (lang === 'pt' ? 'hoje' : 'today') : (mt.endDate && mt.endDate >= today ? t('ongoing') : t('doneLabel'));
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
      {editing && <Modal onClose={() => setEditing(false)}><SheetHead title={mt.destination || trip.title} onClose={() => setEditing(false)} icon={Plane} /><ItemForm draft={trip} allowedTypes={['trip']} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { delItem(trip.id); setEditing(false); back(); }} onSave={(x) => { updateItem(trip.id, x); setEditing(false); }} /></Modal>}
    </div>
  );
}
function TravelScreen({ module, items, people, lang, t, back, toggleTask, onOpen, addItem, updateItem, delItem, flash }) {
  const [view, setView] = useState('flights'); const [period, setPeriod] = useState('year'); const [adding, setAdding] = useState(null); const [selTrip, setSelTrip] = useState(null);
  const flights = items.filter((i) => i.type === 'flight');
  const trips = items.filter((i) => i.type === 'trip').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today = todayISO();
  const upcoming = trips.filter((tr) => ((tr.meta && tr.meta.endDate) ? tr.meta.endDate : tr.date) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextTrip = upcoming[0];
  const nextDays = nextTrip ? Math.ceil((new Date(nextTrip.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
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
          <FlightMap flights={yf} lang={lang} t={t} />
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
            <div style={{ width: 54, height: 54, borderRadius: 12, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Car size={28} style={{ color: mt.color || C.text3 }} /></div>
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
          <div style={{ width: 64, height: 64, borderRadius: 14, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Car size={34} style={{ color: mt.color || C.text3 }} /></div>
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
      {editing && <Modal onClose={() => setEditing(false)}><SheetHead title={vehicle.title} onClose={() => setEditing(false)} icon={Car} /><ItemForm draft={vehicle} allowedTypes={['vehicle']} lang={lang} t={t} people={people} onCancel={() => setEditing(false)} onDelete={() => { delItem(vehicle.id); setEditing(false); back(); }} onSave={(x) => { updateItem(vehicle.id, x); setEditing(false); }} /></Modal>}
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
          {!editing && <button onClick={() => setEditing(true)} style={{ ...card, padding: 7, color: C.accent, cursor: 'pointer' }}><Pencil size={15} /></button>}
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
function SettingsSheet({ settings, setSettings, lang, t, items, setItems, onClose }) {
  const [name, setName] = useState(settings.name);
  const dock = settings.dock || DEFAULT_DOCK;
  const toggleDock = (k) => setSettings((s) => { const cur = s.dock || DEFAULT_DOCK; const has = cur.includes(k); if (has) return { ...s, dock: cur.filter((x) => x !== k) }; if (cur.length >= 5) return s; return { ...s, dock: [...cur, k] }; });
  const exportJSON = () => { const blob = new Blob([JSON.stringify({ items, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'life-control-export.json'; a.click(); URL.revokeObjectURL(url); };
  return (
    <Modal onClose={onClose}>
      <SheetHead title={t('settings')} onClose={onClose} icon={Cog} />
      <Field label={t('name')}><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setSettings((s) => ({ ...s, name }))} style={inputStyle} /></Field>
      <Field label={t('language')}><div style={{ display: 'flex', gap: 8 }}><Chip active={lang === 'pt'} onClick={() => setSettings((s) => ({ ...s, lang: 'pt' }))}>Português (BR)</Chip><Chip active={lang === 'en'} onClick={() => setSettings((s) => ({ ...s, lang: 'en' }))}>English (US)</Chip></div></Field>
      <div style={{ fontSize: 11.5, color: C.text3, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{t('editDock')}</div>
      <div style={{ fontSize: 11.5, color: C.text3, marginBottom: 8 }}>{t('dockHint')} ({dock.length}/5)</div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
        {DOCKABLE.map((k) => { const on = dock.includes(k); const Ic = navIcon(k); return (
          <button key={k} onClick={() => toggleDock(k)} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '7px 11px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, background: on ? C.accentSoft : 'transparent', color: on ? C.accent : C.text2, border: `1px solid ${on ? C.accent + '55' : C.border}` }}><Ic size={14} />{navLabel(k, t)}</button>
        ); })}
      </div>
      <Btn kind="soft" onClick={() => { if (confirm(t('reloadConfirm'))) { setItems(SEED()); setSettings((s) => ({ ...s, ...SEED_SETTINGS })); onClose(); } }} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><RefreshCw size={15} />{t('reloadSamples')}</Btn>
      <Btn kind="soft" onClick={exportJSON} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Download size={15} />{t('exportData')}</Btn>
      <Btn kind="soft" onClick={() => document.getElementById('lcc-import').click()} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Paperclip size={15} />{lang === 'pt' ? 'Importar JSON' : 'Import JSON'}</Btn>
      <input id="lcc-import" type="file" accept="application/json" style={{ display: 'none' }} onChange={async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const txt = await f.text(); const n = await importExportedJson(txt); alert((lang === 'pt' ? 'Importados: ' : 'Imported: ') + n); window.location.reload(); }
        catch (err) { alert('Erro: ' + err.message); }
        e.target.value = '';
      }} />
      <Btn kind="ghost" onClick={async () => { await supabase.auth.signOut(); window.location.reload(); }} style={{ width: '100%', marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>{lang === 'pt' ? 'Sair da conta' : 'Sign out'}</Btn>
      <Btn kind="danger" onClick={() => { if (confirm(t('clearConfirm'))) { setItems([]); onClose(); } }} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}><Trash2 size={15} />{t('clearData')}</Btn>
      {!hasStore && <div style={{ fontSize: 11.5, color: C.text3, marginTop: 14, textAlign: 'center' }}>{t('noPersist')}</div>}
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
  const lang = settings.lang; const t = makeT(lang);
  const people = items.filter((i) => i.type === 'person');
  const dock = settings.dock && settings.dock.length ? settings.dock : DEFAULT_DOCK;

  useEffect(() => { (async () => { const s = await loadState(); if (s.items && s.items.length) setItems(s.items); else setItems(SEED()); if (s.settings) setSettings((p) => ({ ...p, ...s.settings, health: s.settings.health || {}, profile: s.settings.profile || {}, dock: s.settings.dock || DEFAULT_DOCK, devices: s.settings.devices || DEFAULT_DEVICES })); else setSettings((p) => ({ ...p, ...SEED_SETTINGS })); setReady(true); })(); }, []);
  useEffect(() => { if (ready) persistItems(items); }, [items, ready]);
  useEffect(() => { if (ready) persistSettings(settings); }, [settings, ready]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 2000); };
  const addItems = (arr) => setItems((p) => [...arr.map((x) => ({ id: uid(), createdAt: Date.now(), status: 'planned', currency: 'BRL', meta: {}, ...x })), ...p]);
  const addItem = (x) => addItems([x]);
  const updateItem = (id, patch) => setItems((p) => p.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const toggleTask = (id) => {
    const it = items.find((i) => i.id === id);
    setItems((p) => p.map((i) => (i.id === id ? { ...i, status: i.status === 'done' ? 'planned' : 'done' } : i)));
    clearTimeout(undoRef.current);
    if (it && it.status !== 'done') { setUndo(id); undoRef.current = setTimeout(() => setUndo(null), 3200); } else setUndo(null);
  };
  const delItem = (id) => setItems((p) => p.filter((i) => i.id !== id));
  const setHealth = (fn) => setSettings((s) => ({ ...s, health: typeof fn === 'function' ? fn(s.health || {}) : fn }));
  const setProfile = (fn) => setSettings((s) => ({ ...s, profile: typeof fn === 'function' ? fn(s.profile || {}) : fn }));
  const setDevices = (fn) => setSettings((s) => ({ ...s, devices: typeof fn === 'function' ? fn(s.devices || DEFAULT_DEVICES) : fn }));
  const openModuleKey = (key) => setActive({ screen: 'dashboard', module: moduleByKey(key) });
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? t('goodMorning') : h < 18 ? t('goodAfternoon') : t('goodEvening'); };
  const navTo = (k) => { if (SCREEN_ICONS[k]) setActive({ screen: k, module: k === 'dashboard' ? null : null }); else setActive({ screen: 'dashboard', module: moduleByKey(k) }); };

  if (!ready) return <div style={{ background: C.bg, color: C.text3, height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 className="spin" size={22} /></div>;

  const shared = { items, people, lang, t, toggleTask, onOpen: setDetail, addItem, updateItem, delItem, flash };
  const renderModule = (mo) => {
    const back = () => setActive({ screen: 'dashboard', module: null });
    if (mo.custom === 'travel') return <TravelScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'cars') return <CarsScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'people') return <PeopleScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'finance') return <FinanceScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'health') return <HealthScreen module={mo} {...shared} back={back} health={settings.health || {}} setHealth={setHealth} profile={settings.profile || {}} setProfile={setProfile} />;
    if (mo.custom === 'house') return <HouseScreen module={mo} {...shared} back={back} devices={settings.devices || DEFAULT_DEVICES} setDevices={setDevices} />;
    if (mo.custom === 'kids') return <KidsScreen module={mo} {...shared} back={back} />;
    if (mo.custom === 'docs') return <DocsScreen module={mo} {...shared} back={back} />;
    return <ModuleScreen module={mo} {...shared} back={back} />;
  };

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: '100vh', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', maxWidth: 480, margin: '0 auto', position: 'relative', paddingBottom: 78 }}>
      <style>{`.spin{animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}@keyframes pop{0%{transform:scale(.5)}55%{transform:scale(1.18)}100%{transform:scale(1)}}@keyframes slideup{from{transform:translate(-50%,14px);opacity:0}to{transform:translate(-50%,0);opacity:1}} *::-webkit-scrollbar{width:0} input,textarea,select{font-family:inherit} select option{background:#16161E}`}</style>
      <div style={{ padding: '16px 18px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: C.accent }} />Life Control</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setSettings((s) => ({ ...s, lang: s.lang === 'pt' ? 'en' : 'pt' }))} style={{ ...card, padding: '5px 10px', color: C.text2, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}><Globe size={13} />{lang.toUpperCase()}</button>
          <button onClick={() => setShowSettings(true)} style={{ ...card, padding: 7, color: C.text2, cursor: 'pointer' }}><Cog size={15} /></button>
        </div>
      </div>
      <div style={{ padding: '0 16px' }}>
        {active.screen === 'home' && <TodayScreen {...shared} greeting={greeting} name={settings.name} addItems={addItems} health={settings.health || {}} setHealth={setHealth} goModule={openModuleKey} openClaude={(q) => setClaudeSeed(q)} goNews={() => setActive({ screen: 'news', module: null })} />}
        {active.screen === 'news' && <NewsScreen lang={lang} t={t} back={() => setActive({ screen: 'home', module: null })} />}
        {active.screen === 'messages' && <MessagesScreen {...shared} setItems={setItems} />}
        {active.screen === 'calendar' && <CalendarScreen {...shared} />}
        {active.screen === 'claude' && <ClaudeScreen items={items} lang={lang} t={t} name={settings.name} />}
        {active.screen === 'dashboard' && (active.module ? renderModule(active.module) : <DashboardScreen items={items} lang={lang} t={t} open={(mo) => setActive({ screen: 'dashboard', module: mo })} />)}
      </div>

      {active.screen !== 'claude' && (
        <div style={{ position: 'fixed', bottom: 90, left: 0, right: 0, zIndex: 30, pointerEvents: 'none' }}>
          <div style={{ maxWidth: 480, margin: '0 auto', position: 'relative', height: 0 }}>
            <button onClick={() => setShowCapture(true)} style={{ position: 'absolute', right: 18, bottom: 0, pointerEvents: 'auto', background: C.accent, color: '#171200', border: 'none', width: 52, height: 52, borderRadius: 16, cursor: 'pointer', boxShadow: '0 8px 24px rgba(230,180,80,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={24} /></button>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'rgba(11,11,15,.9)', backdropFilter: 'blur(12px)', borderTop: `1px solid ${C.borderSoft}`, zIndex: 20 }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', justifyContent: 'space-around', padding: '9px 4px 12px' }}>
          {dock.map((k) => {
            const Ic = navIcon(k); const isMod = !SCREEN_ICONS[k];
            const activeK = isMod ? (active.module && active.module.key === k) : (active.screen === k && (k !== 'dashboard' || !active.module));
            const badge = k === 'messages' ? items.filter((i) => i.type === 'message' && i.meta && i.meta.unread).length + items.filter((i) => i.status === 'inbox').length : 0;
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
      {claudeSeed && <ClaudeOverlay seed={claudeSeed} onClose={() => setClaudeSeed(null)} items={items} lang={lang} t={t} name={settings.name} />}
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
