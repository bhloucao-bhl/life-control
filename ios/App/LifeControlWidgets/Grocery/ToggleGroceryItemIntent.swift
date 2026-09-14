import AppIntents
import WidgetKit

/// Único botão do widget de Lista de compras que age sem abrir o app: marcar um
/// item como comprado não pede nenhuma entrada do usuário, então é seguro de
/// disparar direto do toque — mesmo raciocínio de MarkPurchaseReceivedIntent.
/// Adicionar/editar/remover um item sempre abre o app (ver WidgetLinks), porque
/// isso pede texto (ou ditado, que também só roda dentro do app).
struct ToggleGroceryItemIntent: AppIntent {
    static var title: LocalizedStringResource = "Marcar item da lista de compras"

    @Parameter(title: "ID do item")
    var itemId: String

    init() {}
    init(itemId: String) { self.itemId = itemId }

    func perform() async throws -> some IntentResult {
        try? await WidgetAPI.toggleGroceryItem(id: itemId)
        WidgetCenter.shared.reloadTimelines(ofKind: "GroceryWidget")
        return .result()
    }
}
