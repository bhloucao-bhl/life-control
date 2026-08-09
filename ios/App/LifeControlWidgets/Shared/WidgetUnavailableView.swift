import SwiftUI

/// Estado mostrado enquanto não há sessão compartilhada ainda (app nunca foi
/// aberto/logado no dispositivo) ou a chamada à API falhou. Toque abre o app.
///
/// `detail` mostra a causa exata (sem sessão / falha de rede / resposta
/// inesperada do servidor) — sem isso, qualquer problema aparece igual
/// ("Abra o app para conectar"), o que torna impossível saber, só olhando
/// pro widget, se é falta de login ou um bug em outro lugar da cadeia.
struct WidgetUnavailableView: View {
    let placeholder: Bool
    var detail: String? = nil

    var body: some View {
        VStack(spacing: 5) {
            Image(systemName: placeholder ? "square.grid.2x2" : "person.crop.circle.badge.exclamationmark")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(placeholder ? "Life Control" : "Abra o app para conectar")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if !placeholder, let detail {
                Text(detail)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .widgetURL(WidgetLinks.open(.today))
    }
}
