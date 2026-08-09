import WidgetKit
import AppIntents

struct SelectAccountIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Escolher conta"
    static var description = IntentDescription("Escolha qual conta este widget mostra.")

    @Parameter(title: "Conta")
    var account: AccountEntity?
}
