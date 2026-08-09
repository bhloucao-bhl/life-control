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
            VStack(alignment: .leading, spacing: 6) {
                Label("Life Control", systemImage: "square.grid.2x2.fill")
                    .font(.caption2).foregroundStyle(.secondary)

                if let r = s.health.readiness { ScoreRow(icon: "bolt.heart.fill", label: "Prontidão", value: "\(r)") }
                if let sc = s.health.sleep { ScoreRow(icon: "moon.fill", label: "Sono", value: "\(sc)") }
                ScoreRow(icon: "checklist", label: "Tarefas", value: "\(s.tasks.count)")

                if family == .systemMedium {
                    Divider()
                    Text("Próximo").font(.caption2).foregroundStyle(.secondary)
                    if let e = s.event {
                        Text(e.title).font(.subheadline).bold().lineLimit(2)
                        if let t = e.time { Text(t).font(.caption).foregroundStyle(.secondary) }
                    } else if let next = s.tasks.next {
                        Text(next.title).font(.subheadline).lineLimit(2)
                    } else {
                        Text("Nada agendado").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(WidgetLinks.open(.today))
        } else {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        }
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

struct DashboardWidget: Widget {
    let kind = "DashboardWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DashboardProvider()) { entry in
            DashboardWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Resumo do dia")
        .description("Prontidão, sono, tarefas e o próximo compromisso.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
