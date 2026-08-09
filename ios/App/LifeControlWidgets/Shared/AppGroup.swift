import Foundation

enum AppGroup {
    /// Precisa bater com o App Group criado no Apple Developer Portal e habilitado
    /// em Signing & Capabilities nos dois targets (App e LifeControlWidgets).
    static let id = "group.com.bhloucao.lifecontrol"

    static var defaults: UserDefaults { UserDefaults(suiteName: id) ?? .standard }

    /// Mesma URL de capacitor.config.json (server.url) — onde vive a API do app.
    static let apiBaseURL = URL(string: "https://life-control-phi.vercel.app")!
}
