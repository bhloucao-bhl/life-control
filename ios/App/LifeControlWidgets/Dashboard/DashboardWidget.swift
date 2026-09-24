import WidgetKit
import SwiftUI

struct DashboardEntry: TimelineEntry {
    let date: Date
    let summary: WidgetSummary?
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct DashboardProvider: TimelineProvider {
    func placeholder(in context: Context) -> DashboardEntry {
        DashboardEntry(date: Date(), summary: nil, isPlaceholder: true, errorDetail: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (DashboardEntry) -> Void) {
        if context.isPreview {
            completion(DashboardEntry(date: Date(), summary: nil, isPlaceholder: true, errorDetail: nil))
            return
        }
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            completion(DashboardEntry(date: Date(), summary: summary, isPlaceholder: false, errorDetail: err))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DashboardEntry>) -> Void) {
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            let entry = DashboardEntry(date: Date(), summary: summary, isPlaceholder: false, errorDetail: err)
            // Os dados (Oura, tarefas, agenda) não mudam segundo a segundo — 30 min
            // fica bem dentro do orçamento de refresh que o WidgetKit dá por widget.
            let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())!
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

struct DashboardWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: DashboardEntry

    var body: some View {
        if let s = entry.summary {
            Group {
                if family == .systemMedium {
                    HStack(alignment: .top, spacing: 12) {
                        indicators(s)
                        Divider()
                        nextUp(s)
                    }
                } else {
                    indicators(s)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(WidgetLinks.open(.today))
        } else {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        }
    }

    /// Coluna principal (é o widget pequeno inteiro): prontidão/sono/tarefas + cotação.
    private func indicators(_ s: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Label("Life Control", systemImage: "square.grid.2x2.fill")
                    .font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                captureButton
            }

            if let r = s.health.readiness { ScoreRow(icon: "bolt.heart.fill", label: "Prontidão", value: "\(r)") }
            if let sc = s.health.sleep { ScoreRow(icon: "moon.fill", label: "Sono", value: "\(sc)") }
            ScoreRow(icon: "checklist", label: "Tarefas", value: "\(s.tasks.count)")

            if let fx = s.fx, !fx.isEmpty {
                Divider()
                ForEach(fx) { FXRow(fx: $0) }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func nextUp(_ s: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Próximo").font(.caption2).foregroundStyle(.secondary)
            if let e = s.event {
                Text(e.title).font(.subheadline).bold().lineLimit(3)
                if let t = e.time { Text(t).font(.caption).foregroundStyle(.secondary) }
            } else if let next = s.tasks.next {
                Text(next.title).font(.subheadline).lineLimit(3)
            } else {
                Text("Nada agendado").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// O "+" da tela do app, só que já por voz: abre a Captura ouvindo o microfone e o
    /// Claude interpreta o que foi dito. É um Button(intent:) e não um Link porque no
    /// widget pequeno o único alvo de URL é o widgetURL (que abre a Hoje).
    private var captureButton: some View {
        Button(intent: OpenVoiceCaptureIntent()) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Capturar por voz")
    }
}

private struct ScoreRow: View {
    let icon: String
    let label: String
    let value: String
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.caption2)
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption).bold()
        }
    }
}

/// Mesmo formato do cartão de cotação da Hoje: código, valor com 2 casas (pt-BR) e a
/// variação do dia com ▲/▼ em verde/vermelho.
private struct FXRow: View {
    let fx: WidgetSummary.FX

    private static let valueFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    var body: some View {
        HStack(spacing: 5) {
            Text(fx.code).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            Spacer(minLength: 2)
            Text(Self.valueFormatter.string(from: NSNumber(value: fx.value)) ?? "—")
                .font(.caption).bold().monospacedDigit()
            if let pct = fx.pct {
                Text((pct < 0 ? "▼" : "▲") + (Self.valueFormatter.string(from: NSNumber(value: abs(pct))) ?? "") + "%")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(pct < 0 ? Color.red : Color.green)
                    .monospacedDigit()
            }
        }
        .lineLimit(1)
    }
}

struct DashboardWidget: Widget {
    let kind = "DashboardWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DashboardProvider()) { entry in
            DashboardWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Resumo do dia")
        .description("Prontidão, sono, tarefas, cotação do dólar/euro e captura rápida por voz.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
