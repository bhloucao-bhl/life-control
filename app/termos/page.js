export const metadata = { title: 'Termos de Uso — Life Control' };

const box = { background: '#0B0B0F', color: '#ECECEF', minHeight: '100vh', padding: '40px 22px', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
const wrap = { maxWidth: 680, margin: '0 auto', lineHeight: 1.65, fontSize: 15 };
const h = { fontSize: 22, fontWeight: 700, marginTop: 30, marginBottom: 8 };
const dim = { color: '#9C9CA8' };

export default function Termos() {
  return (
    <div style={box}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>Termos de Uso</h1>
        <p style={dim}>Life Control — aplicativo de uso pessoal e privado.</p>

        <h2 style={h}>Objeto</h2>
        <p>Aplicativo de organização pessoal, de uso exclusivo do seu titular. Não é oferecido
        ao público, não possui cadastro aberto e não constitui serviço prestado a terceiros.</p>

        <h2 style={h}>Conexões com serviços externos</h2>
        <p>O titular pode, por sua própria escolha, autorizar conexões com Oura e Google.
        Essas conexões usam autorização padrão (OAuth) e podem ser revogadas a qualquer
        momento, tanto no aplicativo quanto nos painéis dos respectivos serviços.
        O aplicativo solicita apenas permissões de leitura.</p>

        <h2 style={h}>Assistente de inteligência artificial</h2>
        <p>As respostas geradas pelo assistente têm caráter informativo e podem conter erros.
        Não constituem aconselhamento médico, jurídico, contábil ou de investimentos.
        Decisões relevantes devem ser tomadas com apoio de profissional qualificado.</p>

        <h2 style={h}>Ausência de garantias</h2>
        <p>O aplicativo é fornecido no estado em que se encontra, sem garantia de
        disponibilidade contínua ou de ausência de falhas. O titular é responsável por manter
        cópias dos dados que considerar importantes (Ajustes → Exportar dados).</p>

        <h2 style={h}>Alterações</h2>
        <p style={dim}>Estes termos podem ser atualizados a qualquer momento pelo titular do aplicativo.</p>
      </div>
    </div>
  );
}
