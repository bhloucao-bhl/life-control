import SwiftUI

/// Estado mostrado enquanto não há sessão compartilhada ainda (app nunca foi
/// aberto/logado no dispositivo) ou a chamada à API falhou. Toque abre o app.
struct WidgetUnavailableView: View {
    let placeholder: Bool

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: placeholder ? "square.grid.2x2" : "person.crop.circle.badge.exclamationmark")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(placeholder ? "Life Control" : "Abra o app para conectar")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .widgetURL(WidgetLinks.open(.today))
    }
}
