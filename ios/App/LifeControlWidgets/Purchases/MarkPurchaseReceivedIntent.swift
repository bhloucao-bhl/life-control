import AppIntents
import WidgetKit

/// Único botão do widget de Compras que age sem abrir o app: marcar como
/// recebida não pede nenhuma entrada do usuário, então é seguro de disparar
/// direto do toque (ao contrário de "+ Gasto"/"+ Compra", que sempre precisam
/// de um valor/nome e por isso abrem o app — ver WidgetLinks).
struct MarkPurchaseReceivedIntent: AppIntent {
    static var title: LocalizedStringResource = "Marcar compra como recebida"

    @Parameter(title: "ID da compra")
    var purchaseId: String

    init() {}
    init(purchaseId: String) { self.purchaseId = purchaseId }

    func perform() async throws -> some IntentResult {
        try? await WidgetAPI.markPurchaseReceived(id: purchaseId)
        WidgetCenter.shared.reloadTimelines(ofKind: "PurchasesWidget")
        return .result()
    }
}
