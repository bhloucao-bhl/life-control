import WidgetKit
import SwiftUI
import AppIntents

struct FinanceEntry: TimelineEntry {
    let date: Date
    let account: WidgetSummary.Account?
    let hasAnyAccount: Bool
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct FinanceProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> FinanceEntry {
        FinanceEntry(date: Date(), account: nil, hasAnyAccount: true, isPlaceholder: true, errorDetail: nil)
    }

    func snapshot(for configuration: SelectAccountIntent, in context: Context) async -> FinanceEntry {
        if context.isPreview { return FinanceEntry(date: Date(), account: nil, hasAnyAccount: true, isPlaceholder: true, errorDetail: nil) }
        return await makeEntry(configuration: configuration)
    }

    func timeline(for configuration: SelectAccountIntent, in context: Context) async -> Timeline<FinanceEntry> {
        let entry = await makeEntry(configuration: configuration)
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())!
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func makeEntry(configuration: SelectAccountIntent) async -> FinanceEntry {
        let (summary, err) = await WidgetAPI.fetchSummaryResult()
        guard let summary else {
            return FinanceEntry(date: Date(), account: nil, hasAnyAccount: true, isPlaceholder: false, errorDetail: err)
        }
        let accounts = summary.finance.accounts
        // usa a conta escolhida em "Editar Widget" se ainda existir; senão cai pra primeira disponível
        let picked = configuration.account.flatMap { sel in accounts.first { $0.id == sel.id } } ?? accounts.first
        return FinanceEntry(date: Date(), account: picked, hasAnyAccount: !accounts.isEmpty, isPlaceholder: false, errorDetail: nil)
    }
}

struct FinanceWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: FinanceEntry

    var body: some View {
        if let acc = entry.account {
            VStack(alignment: .leading, spacing: 8) {
                Label(acc.title, systemImage: "creditcard.fill")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)

                Text(formattedBRL(acc.balance))
                    .font(.title2).bold()
                    .foregroundStyle(acc.balance < 0 ? .red : .primary)

                Spacer(minLength: 0)

                if family == .systemMedium {
                    HStack(spacing: 8) {
                        FinanceActionButton(title: "Gasto", icon: "minus.circle.fill", url: WidgetLinks.open(.addExpense, params: ["accountId": acc.id]))
                        FinanceActionButton(title: "Compra", icon: "bag.fill", url: WidgetLinks.open(.addPurchase, params: ["accountId": acc.id]))
                    }
                } else {
                    FinanceActionButton(title: "Gasto", icon: "minus.circle.fill", url: WidgetLinks.open(.addExpense, params: ["accountId": acc.id]))
                }
            }
            .widgetURL(WidgetLinks.open(.today))
        } else if entry.hasAnyAccount {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        } else {
            VStack(spacing: 6) {
                Image(systemName: "creditcard").font(.title3).foregroundStyle(.secondary)
                Text("Cadastre uma conta no app").font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(WidgetLinks.open(.today))
        }
    }

    private func formattedBRL(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = Locale(identifier: "pt_BR")
        return f.string(from: NSNumber(value: v)) ?? String(format: "R$ %.2f", v)
    }
}

private struct FinanceActionButton: View {
    let title: String
    let icon: String
    let url: URL

    var body: some View {
        Link(destination: url) {
            Label(title, systemImage: icon)
                .font(.caption).bold()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(.tint.opacity(0.15), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct FinanceWidget: Widget {
    let kind = "FinanceWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectAccountIntent.self, provider: FinanceProvider()) { entry in
            FinanceWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Conta")
        .description("Saldo de uma conta escolhida, com atalhos para lançar gasto ou compra.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
