export const metadata = { title: 'Privacidade — Life Control' };

const box = { background: '#0B0B0F', color: '#ECECEF', minHeight: '100vh', padding: '40px 22px', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
const wrap = { maxWidth: 680, margin: '0 auto', lineHeight: 1.65, fontSize: 15 };
const h = { fontSize: 22, fontWeight: 700, marginTop: 30, marginBottom: 8 };
const dim = { color: '#9C9CA8' };

export default function Privacidade() {
  return (
    <div style={box}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>Política de Privacidade</h1>
        <p style={dim}>Life Control — aplicativo de uso pessoal e privado.</p>

        <h2 style={h}>Quem opera este aplicativo</h2>
        <p>Este é um aplicativo pessoal, operado por seu próprio titular, sem finalidade comercial
        e sem oferta a terceiros. Não há outros usuários além do proprietário da conta.</p>

        <h2 style={h}>Quais dados são tratados</h2>
        <p>Informações inseridas manualmente pelo titular (tarefas, compromissos, despesas,
        documentos, contatos e anexos) e, quando o titular autoriza expressamente a conexão,
        dados obtidos de serviços externos:</p>
        <ul>
          <li><b>Oura Ring:</b> pontuações diárias de prontidão e sono.</li>
          <li><b>Google Agenda:</b> eventos do calendário principal (somente leitura).</li>
          <li><b>Gmail:</b> remetente, assunto e prévia de mensagens não lidas (somente leitura).</li>
        </ul>

        <h2 style={h}>Como os dados são armazenados</h2>
        <p>Os dados ficam em banco de dados privado (Supabase), com regras de segurança em nível
        de linha que restringem o acesso exclusivamente à conta autenticada do titular.
        Os tokens de acesso das conexões externas ficam inacessíveis ao navegador e são usados
        apenas pelo servidor do aplicativo.</p>

        <h2 style={h}>Compartilhamento</h2>
        <p>Os dados não são vendidos, cedidos, publicados nem compartilhados com terceiros.
        Trechos do conteúdo podem ser enviados à API da Anthropic (Claude) quando o titular
        solicita uma resposta do assistente, exclusivamente para gerar aquela resposta.</p>

        <h2 style={h}>Retenção e exclusão</h2>
        <p>O titular pode apagar todos os dados a qualquer momento dentro do aplicativo
        (Ajustes → Apagar tudo) e revogar as conexões externas em Ajustes → Conexões,
        bem como diretamente nos painéis do Oura e da Conta Google.</p>

        <h2 style={h}>Contato</h2>
        <p style={dim}>Pelo e-mail cadastrado como contato do aplicativo.</p>
      </div>
    </div>
  );
}
