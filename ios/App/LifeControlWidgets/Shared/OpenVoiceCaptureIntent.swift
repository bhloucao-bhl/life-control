import AppIntents
import Foundation

/// Ação que um botão de widget pediu pro app executar ao abrir. Existe porque o
/// widget pequeno (systemSmall) só tem um alvo de toque via URL (widgetURL, que
/// no Resumo do dia já abre a Hoje) — o "+" dele precisa ser um Button(intent:),
/// e um intent não entrega URL pro app: ele deixa o pedido aqui no App Group e o
/// app lê (SharedAuthPlugin.consumeWidgetAction) assim que volta pro primeiro plano.
enum PendingWidgetAction {
    static let storageKey = "lcc_pending_widget_action_v1"
    static let notification = Notification.Name("LCCPendingWidgetAction")
    /// Pedido mais velho que isso é descartado — evita o app abrir o microfone
    /// sozinho horas depois, se por algum motivo o pedido não foi lido na hora.
    private static let maxAge: TimeInterval = 120

    static func set(_ action: String) {
        AppGroup.defaults.set(["action": action, "at": Date().timeIntervalSince1970], forKey: storageKey)
    }

    /// Lê e apaga o pedido pendente (só entrega uma vez).
    static func consume() -> String? {
        guard let dict = AppGroup.defaults.dictionary(forKey: storageKey) else { return nil }
        AppGroup.defaults.removeObject(forKey: storageKey)
        guard let action = dict["action"] as? String, let at = dict["at"] as? TimeInterval,
              Date().timeIntervalSince1970 - at <= maxAge else { return nil }
        return action
    }
}

/// "+" do widget Resumo do dia: abre o app direto na Captura (o mesmo "+" da tela)
/// já ouvindo o microfone — o texto ditado vai pro Claude interpretar e sugerir o
/// que fazer. Incluído nos dois targets (App e LifeControlWidgets): com
/// openAppWhenRun o sistema abre o app e roda perform() no processo dele.
@available(iOS 16.0, *)
struct OpenVoiceCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Capturar por voz"
    static var openAppWhenRun: Bool = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        PendingWidgetAction.set("quickCaptureVoice")
        // App já rodando (em segundo plano): avisa o plugin na hora, sem esperar o próximo
        // appStateChange do JS — ver SharedAuthPlugin.load().
        NotificationCenter.default.post(name: PendingWidgetAction.notification, object: nil)
        return .result()
    }
}
