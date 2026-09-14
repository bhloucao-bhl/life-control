import WidgetKit
import SwiftUI

struct GroceryEntry: TimelineEntry {
    let date: Date
    let groceryList: [WidgetSummary.GroceryItem]
    let loaded: Bool
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct GroceryProvider: TimelineProvider {
    func placeholder(in context: Context) -> GroceryEntry {
        GroceryEntry(date: Date(), groceryList: [], loaded: true, isPlaceholder: true, errorDetail: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (GroceryEntry) -> Void) {
        if context.isPreview {
            completion(GroceryEntry(date: Date(), groceryList: [], loaded: true, isPlaceholder: true, errorDetail: nil))
            return
        }
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            completion(GroceryEntry(date: Date(), groceryList: summary?.groceryList ?? [], loaded: summary != nil, isPlaceholder: false, errorDetail: err))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GroceryEntry>) -> Void) {
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())!
            let entry = GroceryEntry(date: Date(), groceryList: summary?.groceryList ?? [], loaded: summary != nil, isPlaceholder: false, errorDetail: err)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

struct GroceryWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: GroceryEntry

    var visibleCount: Int { family == .systemLarge ? 8 : 4 }

    var body: some View {
        if !entry.loaded {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        } else if entry.groceryList.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "cart").font(.title3).foregroundStyle(.secondary)
                Text("Lista vazia").font(.caption).foregroundStyle(.secondary)
                addRow
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(WidgetLinks.open(.groceryList))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Label("Compra da semana", systemImage: "cart.fill")
                    .font(.caption2).foregroundStyle(.secondary)
                let shown = Array(entry.groceryList.prefix(visibleCount).enumerated())
                ForEach(shown, id: \.element.id) { idx, item in
                    GroceryRow(item: item)
                    if idx < shown.count - 1 { Divider() }
                }
                Spacer(minLength: 0)
                Divider()
                addRow
            }
            .widgetURL(WidgetLinks.open(.groceryList))
        }
    }

    // "Adicionar item" é o principal (é assim que a maioria vai adicionar — abre o app já com
    // o campo de texto pronto); o microfone é só um atalho secundário menor ao lado, pra quem
    // quiser ditar em vez de digitar.
    private var addRow: some View {
        HStack(spacing: 14) {
            Link(destination: WidgetLinks.open(.addGroceryItem)) {
                HStack(spacing: 5) {
                    Image(systemName: "plus.circle.fill")
                    Text("Adicionar item")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tint)
            }
            Spacer(minLength: 0)
            Link(destination: WidgetLinks.open(.addGroceryItemVoice)) {
                Image(systemName: "mic.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct GroceryRow: View {
    let item: WidgetSummary.GroceryItem

    var body: some View {
        HStack(spacing: 8) {
            Button(intent: ToggleGroceryItemIntent(itemId: item.id)) {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
            }
            .buttonStyle(.plain)
            .font(.callout)
            .tint(item.checked ? .green : .secondary)
            Text(item.text)
                .font(.caption)
                .lineLimit(1)
                .strikethrough(item.checked)
                .foregroundStyle(item.checked ? .secondary : .primary)
            Spacer(minLength: 0)
        }
    }
}

struct GroceryWidget: Widget {
    let kind = "GroceryWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GroceryProvider()) { entry in
            GroceryWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Compra da semana")
        .description("Sua lista de compras — toque no círculo pra marcar como comprado.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
