import WidgetKit
import SwiftUI

struct PurchasesEntry: TimelineEntry {
    let date: Date
    let purchases: [WidgetSummary.Purchase]
    let loaded: Bool
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct PurchasesProvider: TimelineProvider {
    func placeholder(in context: Context) -> PurchasesEntry {
        PurchasesEntry(date: Date(), purchases: [], loaded: true, isPlaceholder: true, errorDetail: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (PurchasesEntry) -> Void) {
        if context.isPreview {
            completion(PurchasesEntry(date: Date(), purchases: [], loaded: true, isPlaceholder: true, errorDetail: nil))
            return
        }
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            completion(PurchasesEntry(date: Date(), purchases: summary?.purchases ?? [], loaded: summary != nil, isPlaceholder: false, errorDetail: err))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PurchasesEntry>) -> Void) {
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            let next = Calendar.current.date(byAdding: .minute, value: 45, to: Date())!
            let entry = PurchasesEntry(date: Date(), purchases: summary?.purchases ?? [], loaded: summary != nil, isPlaceholder: false, errorDetail: err)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

struct PurchasesWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: PurchasesEntry

    var visibleCount: Int { family == .systemLarge ? 5 : 3 }

    var body: some View {
        if !entry.loaded {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        } else if entry.purchases.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "shippingbox").font(.title3).foregroundStyle(.secondary)
                Text("Nada a caminho").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(WidgetLinks.open(.purchases))
        } else {
            VStack(alignment: .leading, spacing: 7) {
                Label("Compras a caminho", systemImage: "shippingbox.fill")
                    .font(.caption2).foregroundStyle(.secondary)
                let shown = Array(entry.purchases.prefix(visibleCount).enumerated())
                ForEach(shown, id: \.element.id) { idx, p in
                    PurchaseRow(purchase: p, showReceiveButton: idx == 0)
                    if idx < shown.count - 1 { Divider() }
                }
                Spacer(minLength: 0)
            }
            .widgetURL(WidgetLinks.open(.purchases))
        }
    }
}

private struct PurchaseRow: View {
    let purchase: WidgetSummary.Purchase
    let showReceiveButton: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: purchase.stage == "shipped" ? "shippingbox.fill" : "creditcard.fill")
                .font(.caption).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(purchase.title).font(.caption).bold().lineLimit(1)
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if showReceiveButton {
                Button(intent: MarkPurchaseReceivedIntent(purchaseId: purchase.id)) {
                    Image(systemName: "checkmark.circle.fill")
                }
                .buttonStyle(.plain)
                .font(.title3)
                .tint(.green)
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let store = purchase.store { parts.append(store) }
        if let eta = purchase.etaDate { parts.append((purchase.stage == "shipped" ? "chega " : "prev. ") + formattedDate(eta)) }
        return parts.isEmpty ? (purchase.stage == "shipped" ? "A caminho" : "Pago") : parts.joined(separator: " · ")
    }

    private func formattedDate(_ iso: String) -> String {
        let inFmt = DateFormatter()
        inFmt.locale = Locale(identifier: "en_US_POSIX")
        inFmt.timeZone = TimeZone(identifier: "UTC")
        inFmt.dateFormat = "yyyy-MM-dd"
        guard let d = inFmt.date(from: iso) else { return iso }
        let outFmt = DateFormatter()
        outFmt.locale = Locale(identifier: "pt_BR")
        outFmt.timeZone = TimeZone(identifier: "UTC")
        outFmt.dateFormat = "dd/MM"
        return outFmt.string(from: d)
    }
}

struct PurchasesWidget: Widget {
    let kind = "PurchasesWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: PurchasesProvider()) { entry in
            PurchasesWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Compras a caminho")
        .description("Pedidos pagos ou enviados, com a data prevista de chegada.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
