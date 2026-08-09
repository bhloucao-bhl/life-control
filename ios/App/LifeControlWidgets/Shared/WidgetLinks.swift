import Foundation

/// Ações que um toque no widget pode pedir pro app abrir já na tela certa.
/// O app registra o esquema "lifecontrol://" (Info.plist) e o Capacitor
/// entrega isso como o evento JS "appUrlOpen" — ver o listener em app/page.js.
enum WidgetAction: String {
    case today
    case addMeal
    case addExpense
    case addPurchase
    case purchases
}

enum WidgetLinks {
    static func open(_ action: WidgetAction, params: [String: String] = [:]) -> URL {
        var comps = URLComponents()
        comps.scheme = "lifecontrol"
        comps.host = "open"
        comps.queryItems = [URLQueryItem(name: "action", value: action.rawValue)] + params.map { URLQueryItem(name: $0.key, value: $0.value) }
        return comps.url!
    }
}
