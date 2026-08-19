import WidgetKit
import SwiftUI
import AppIntents

struct SceneLockEntry: TimelineEntry {
    let date: Date
    let scene: WidgetSummary.Scene?
    let hasAnyScene: Bool
    let isPlaceholder: Bool
    let errorDetail: String?
}

struct SceneLockProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> SceneLockEntry {
        SceneLockEntry(date: Date(), scene: nil, hasAnyScene: true, isPlaceholder: true, errorDetail: nil)
    }

    func snapshot(for configuration: SelectSceneIntent, in context: Context) async -> SceneLockEntry {
        if context.isPreview { return SceneLockEntry(date: Date(), scene: nil, hasAnyScene: true, isPlaceholder: true, errorDetail: nil) }
        return await makeEntry(configuration: configuration)
    }

    func timeline(for configuration: SelectSceneIntent, in context: Context) async -> Timeline<SceneLockEntry> {
        let entry = await makeEntry(configuration: configuration)
        let next = Calendar.current.date(byAdding: .minute, value: 40, to: Date())!
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func makeEntry(configuration: SelectSceneIntent) async -> SceneLockEntry {
        let (summary, err) = await WidgetAPI.fetchSummaryResult()
        guard let summary else {
            return SceneLockEntry(date: Date(), scene: nil, hasAnyScene: true, isPlaceholder: false, errorDetail: err)
        }
        let scenes = summary.scenes
        // usa a cena escolhida em "Editar Widget" se ainda existir; senão cai pra primeira disponível
        let picked = configuration.scene.flatMap { sel in scenes.first { $0.id == sel.id } } ?? scenes.first
        return SceneLockEntry(date: Date(), scene: picked, hasAnyScene: !scenes.isEmpty, isPlaceholder: false, errorDetail: nil)
    }
}

struct SceneLockWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: SceneLockEntry

    var body: some View {
        if let sc = entry.scene {
            Button(intent: RunSceneIntent(sceneId: sc.id, sceneName: sc.name)) {
                switch family {
                case .accessoryCircular:
                    VStack(spacing: 2) {
                        Image(systemName: "sparkles")
                        Text(sc.name).font(.system(size: 11)).lineLimit(1)
                    }
                case .accessoryInline:
                    Label(sc.name, systemImage: "sparkles")
                default: // accessoryRectangular
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                        VStack(alignment: .leading, spacing: 1) {
                            Text(sc.name).font(.headline).lineLimit(1)
                            Text(sc.steps == 1 ? "1 passo · toque pra tocar" : "\(sc.steps) passos · toque pra tocar")
                                .font(.caption2)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
        } else if entry.hasAnyScene {
            Label(entry.isPlaceholder ? "Cena" : (entry.errorDetail ?? "Abra o app"), systemImage: "sparkles")
        } else {
            Label("Crie uma cena no app", systemImage: "sparkles")
        }
    }
}

struct SceneLockWidget: Widget {
    let kind = "SceneLockWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectSceneIntent.self, provider: SceneLockProvider()) { entry in
            SceneLockWidgetView(entry: entry)
        }
        .configurationDisplayName("Cena (Lock Screen)")
        .description("Toque pra disparar uma cena de casa direto da tela bloqueada.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
