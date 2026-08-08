import Foundation

/// Espelha o JSON de GET /api/widget/summary (app/api/widget/summary/route.js).
/// Mantenha os dois em sincronia se o formato mudar de um lado.
struct WidgetSummary: Codable {
    struct Health: Codable { let connected: Bool; let readiness: Int?; let sleep: Int?; let date: String? }
    struct TaskInfo: Codable { let id: String; let title: String; let date: String? }
    struct Tasks: Codable { let count: Int; let next: TaskInfo? }
    struct EventInfo: Codable { let id: String; let title: String; let date: String; let time: String? }
    struct Diet: Codable { let caloriesToday: Double; let goal: Double; let mealsToday: Int }
    struct Account: Codable, Identifiable { let id: String; let title: String; let institution: String?; let balance: Double }
    struct Finance: Codable { let accounts: [Account] }
    struct Purchase: Codable, Identifiable { let id: String; let title: String; let store: String?; let etaDate: String?; let stage: String; let tracking: String? }

    let today: String
    let health: Health
    let tasks: Tasks
    let event: EventInfo?
    let diet: Diet
    let finance: Finance
    let purchases: [Purchase]
}

enum WidgetAPI {
    private static func request(path: String) async throws -> URLRequest {
        let token = try await SharedSession.validAccessToken()
        guard let url = URL(string: AppGroup.apiBaseURL.absoluteString + path) else { throw WidgetAPIError.badResponse }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }

    static func fetchSummary() async throws -> WidgetSummary {
        let req = try await request(path: "/api/widget/summary")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw WidgetAPIError.badResponse }
        return try JSONDecoder().decode(WidgetSummary.self, from: data)
    }

    /// Única ação que o widget dispara sem abrir o app: marcar uma compra como
    /// recebida (não pede nenhuma entrada do usuário, então é segura de fazer
    /// direto do botão interativo). Adicionar gasto/refeição/compra sempre
    /// abre o app numa tela pré-preenchida — ver WidgetLinks.
    static func markPurchaseReceived(id: String) async throws {
        var req = try await request(path: "/api/widget/action")
        req.httpMethod = "POST"
        req.httpBody = try JSONEncoder().encode(["action": "markPurchaseReceived", "id": id])
        let (_, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw WidgetAPIError.badResponse }
    }
}
