import WidgetKit
import SwiftUI

struct ScenesEntry: TimelineEntry {
    let date: Date
    let scenes: [WidgetSummary.Scene]
    let lastSceneId: String?
    let loaded: Bool
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct ScenesProvider: TimelineProvider {
    func placeholder(in context: Context) -> ScenesEntry {
        ScenesEntry(date: Date(), scenes: [], lastSceneId: nil, loaded: true, isPlaceholder: true, errorDetail: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ScenesEntry) -> Void) {
        if context.isPreview {
            completion(ScenesEntry(date: Date(), scenes: [], lastSceneId: nil, loaded: true, isPlaceholder: true, errorDetail: nil))
            return
        }
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            completion(ScenesEntry(date: Date(), scenes: summary?.scenes ?? [], lastSceneId: summary?.lastScene?.id, loaded: summary != nil, isPlaceholder: false, errorDetail: err))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ScenesEntry>) -> Void) {
        Task {
            let (summary, err) = await WidgetAPI.fetchSummaryResult()
            // Cenas quase não mudam sozinhas (só quando editadas no app) — 40 min é de sobra;
            // o toque no botão já recarrega na hora via RunSceneIntent.
            let next = Calendar.current.date(byAdding: .minute, value: 40, to: Date())!
            let entry = ScenesEntry(date: Date(), scenes: summary?.scenes ?? [], lastSceneId: summary?.lastScene?.id, loaded: summary != nil, isPlaceholder: false, errorDetail: err)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

struct ScenesWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: ScenesEntry

    var visibleCount: Int { family == .systemLarge ? 8 : 4 }

    var body: some View {
        if !entry.loaded {
            WidgetUnavailableView(placeholder: entry.isPlaceholder, detail: entry.errorDetail)
        } else if entry.scenes.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "sparkles").font(.title3).foregroundStyle(.secondary)
                Text("Nenhuma cena criada").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(WidgetLinks.open(.today))
        } else if family == .systemSmall {
            // Só cabe um botão de verdade num widget pequeno: a própria cena escolhida
            // (a última tocada, senão a primeira) — o toque na área inteira já a dispara.
            let sc = entry.scenes.first(where: { $0.id == entry.lastSceneId }) ?? entry.scenes[0]
            Button(intent: RunSceneIntent(sceneId: sc.id, sceneName: sc.name)) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Cena", systemImage: "sparkles").font(.caption2).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Text(sc.name).font(.headline).lineLimit(2)
                    Text(sc.id == entry.lastSceneId ? "Última tocada" : "Tocar").font(.caption2).foregroundStyle(sc.id == entry.lastSceneId ? .green : .secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        } else {
            VStack(alignment: .leading, spacing: 7) {
                Label("Cenas", systemImage: "sparkles").font(.caption2).foregroundStyle(.secondary)
                let shown = Array(entry.scenes.prefix(visibleCount).enumerated())
                ForEach(shown, id: \.element.id) { idx, sc in
                    SceneRow(scene: sc, isLast: sc.id == entry.lastSceneId)
                    if idx < shown.count - 1 { Divider() }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct SceneRow: View {
    let scene: WidgetSummary.Scene
    let isLast: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isLast ? "checkmark.circle.fill" : "sparkles")
                .font(.caption)
                .foregroundStyle(isLast ? .green : .secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(scene.name).font(.caption).bold().lineLimit(1)
                Text(scene.steps == 1 ? "1 passo" : "\(scene.steps) passos").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button(intent: RunSceneIntent(sceneId: scene.id, sceneName: scene.name)) {
                Image(systemName: "play.circle.fill")
            }
            .buttonStyle(.plain)
            .font(.title3)
            .tint(.accentColor)
        }
    }
}

struct ScenesWidget: Widget {
    let kind = "ScenesWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ScenesProvider()) { entry in
            ScenesWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Cenas")
        .description("Toque numa cena de casa pra disparar todos os passos dela.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
