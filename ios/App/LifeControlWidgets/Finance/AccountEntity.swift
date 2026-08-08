import AppIntents

/// Representa uma conta/cartão (item type "account" no app) pro seletor de
/// configuração do widget de Finanças (toque longo → Editar Widget).
struct AccountEntity: AppEntity {
    let id: String
    let title: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Conta"
    static var defaultQuery = AccountQuery()

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}

struct AccountQuery: EntityQuery {
    func entities(for identifiers: [AccountEntity.ID]) async throws -> [AccountEntity] {
        let all = try await allAccounts()
        return all.filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [AccountEntity] {
        try await allAccounts()
    }

    private func allAccounts() async throws -> [AccountEntity] {
        let summary = try await WidgetAPI.fetchSummary()
        return summary.finance.accounts.map { AccountEntity(id: $0.id, title: $0.title) }
    }
}
