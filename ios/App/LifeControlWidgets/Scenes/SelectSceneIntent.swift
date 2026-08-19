import WidgetKit
import AppIntents

struct SelectSceneIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Escolher cena"
    static var description = IntentDescription("Escolha qual cena este widget toca.")

    @Parameter(title: "Cena")
    var scene: SceneEntity?
}
