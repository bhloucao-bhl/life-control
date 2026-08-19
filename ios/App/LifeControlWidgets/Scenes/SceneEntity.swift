import AppIntents

/// Representa uma cena de casa (item "scenes" nos settings do app) pro
/// seletor de configuração do widget de Lock Screen (toque longo → Editar).
struct SceneEntity: AppEntity {
    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Cena"
    static var defaultQuery = SceneQuery()

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct SceneQuery: EntityQuery {
    func entities(for identifiers: [SceneEntity.ID]) async throws -> [SceneEntity] {
        let all = try await allScenes()
        return all.filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [SceneEntity] {
        try await allScenes()
    }

    private func allScenes() async throws -> [SceneEntity] {
        let summary = try await WidgetAPI.fetchSummary()
        return summary.scenes.map { SceneEntity(id: $0.id, name: $0.name) }
    }
}
