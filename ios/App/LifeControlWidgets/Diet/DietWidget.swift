import WidgetKit
import SwiftUI

struct DietEntry: TimelineEntry {
    let date: Date
    let summary: WidgetSummary?
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct DietProvider: TimelineProvider {
    func placeholder(in context: Context) -> DietEntry {
        DietEntry(date: Date(), summary: nil, isPlaceholder: true, errorDetail: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (DietEntry) -> Void) {
        if context.isPreview {
            completion(DietEntry(date: Date(), summary: nil, isPlaceholder: true, errorDetail: nil))
            return
        }
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            completion(DietEntry(date: Date(), summary: summary, isPlaceholder: false, errorDetail: err))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DietEntry>) -> Void) {
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            let next = Calendar.current.date(byAdding: .minute, value: 20, to: Date())!
            completion(Timeline(entries: [DietEntry(date: Date(), summary: summary, isPlaceholder: false, errorDetail: err)], policy: .after(next)))
        }
    }
}

struct DietWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: DietEntry

    var body: some View {
        if let s = entry.summary {
            VStack(alignment: .leading, spacing: 8) {
                Label("Dieta", systemImage: "fork.knife")
                    .font(.caption2).foregroundStyle(.secondary)

                CalorieGauge(diet: s.diet)

                if family == .systemMedium {
                    Text(s.diet.mealsToday == 1 ? "1 refeição hoje" : "\(s.diet.mealsToday) refeições hoje")
                        .font(.caption2).foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)

                Link(destination: WidgetLinks.open(.addMeal)) {
                    Label("Refeição feita", systemImage: "plus.circle.fill")
                        .font(.caption).bold()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(.tint, in: Capsule())
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
            }
            .widgetURL(WidgetLinks.open(.today))
        } else {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        }
    }
}

private struct CalorieGauge: View {
    let diet: WidgetSummary.Diet
    var fraction: Double { diet.goal > 0 ? diet.caloriesToday / diet.goal : 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("\(Int(diet.caloriesToday))").font(.title2).bold()
                Text("/ \(Int(diet.goal)) kcal").font(.caption2).foregroundStyle(.secondary)
            }
            ProgressView(value: min(fraction, 1))
                .tint(fraction > 1 ? .red : .accentColor)
        }
    }
}

struct DietWidget: Widget {
    let kind = "DietWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DietProvider()) { entry in
            DietWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Dieta")
        .description("Calorias de hoje, com atalho para registrar uma refeição.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
