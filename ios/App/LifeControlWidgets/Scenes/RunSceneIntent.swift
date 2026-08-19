import AppIntents
import WidgetKit

/// Botão de "tocar uma cena" — usado tanto no widget de Tela de Início quanto
/// no do Lock Screen. Não pede nada digitado (não existe "desligar uma cena",
/// só disparar de novo), então é seguro rodar direto do toque, sem abrir o app.
struct RunSceneIntent: AppIntent {
    static var title: LocalizedStringResource = "Tocar cena"

    @Parameter(title: "ID da cena")
    var sceneId: String

    @Parameter(title: "Nome da cena")
    var sceneName: String?

    init() {}
    init(sceneId: String, sceneName: String? = nil) {
        self.sceneId = sceneId
        self.sceneName = sceneName
    }

    func perform() async throws -> some IntentResult {
        try? await WidgetAPI.runScene(id: sceneId)
        WidgetCenter.shared.reloadTimelines(ofKind: "ScenesWidget")
        WidgetCenter.shared.reloadTimelines(ofKind: "SceneLockWidget")
        return .result()
    }
}
