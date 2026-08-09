import Foundation

enum WidgetAPIError: Error {
    case noSession
    case authFailed
    case badStatus(Int)
    case badURL
}

/// Sessão do Supabase (a mesma que o WebView usa), guardada no App Group pelo
/// plugin nativo SharedAuthPlugin sempre que o app faz login ou renova o token.
/// O widget roda num processo separado e não tem acesso ao localStorage do
/// WKWebView nem ao SDK JS do Supabase — por isso guarda os dois tokens aqui e
/// sabe renovar sozinho batendo direto na API REST do Supabase.
struct SharedSession: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: TimeInterval // epoch seconds
    var supabaseUrl: String
    var supabaseAnonKey: String

    static let storageKey = "lcc_session_v1"

    static func load() -> SharedSession? {
        guard let data = AppGroup.defaults.data(forKey: storageKey) else { return nil }
        return try? JSONDecoder().decode(SharedSession.self, from: data)
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        AppGroup.defaults.set(data, forKey: SharedSession.storageKey)
    }

    static func clear() {
        AppGroup.defaults.removeObject(forKey: storageKey)
    }

    var isExpired: Bool { Date().timeIntervalSince1970 > expiresAt - 60 }

    /// Troca o refresh token por um access token novo, no mesmo endpoint que o
    /// supabase-js usa (o widget não tem o SDK JS disponível).
    func refreshed() async throws -> SharedSession {
        guard let url = URL(string: supabaseUrl.trimmingCharacters(in: .init(charactersIn: "/")) + "/auth/v1/token?grant_type=refresh_token") else {
            throw WidgetAPIError.authFailed
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.httpBody = try JSONEncoder().encode(["refresh_token": refreshToken])

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw WidgetAPIError.authFailed
        }
        struct TokenResponse: Decodable {
            let access_token: String
            let refresh_token: String
            let expires_in: TimeInterval
        }
        let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
        let next = SharedSession(
            accessToken: decoded.access_token,
            refreshToken: decoded.refresh_token,
            expiresAt: Date().timeIntervalSince1970 + decoded.expires_in,
            supabaseUrl: supabaseUrl,
            supabaseAnonKey: supabaseAnonKey
        )
        next.save()
        return next
    }

    /// Devolve um access token válido, renovando antes se preciso.
    static func validAccessToken() async throws -> String {
        guard var session = load() else { throw WidgetAPIError.noSession }
        if session.isExpired { session = try await session.refreshed() }
        return session.accessToken
    }
}
