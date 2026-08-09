import Foundation
import Capacitor

/// Ponte nativa mínima entre o WebView (onde vive a sessão do Supabase, via
/// supabase-js) e o App Group (onde os widgets de WidgetKit leem essa mesma
/// sessão). Sem isso os widgets não têm como se autenticar: eles rodam num
/// processo separado, sem acesso ao localStorage/IndexedDB do WKWebView.
///
/// Chamado do JS (app/page.js) toda vez que a sessão muda — login, refresh
/// automático do token, logout. Ver Shared/SharedSession.swift (definido em
/// LifeControlWidgets/Shared e também incluído neste target) pro formato
/// salvo e a lógica de renovação usada pelo widget.
@objc(SharedAuthPlugin)
public class SharedAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedAuthPlugin"
    public let jsName = "SharedAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
    ]

    @objc func saveSession(_ call: CAPPluginCall) {
        guard
            let accessToken = call.getString("accessToken"),
            let refreshToken = call.getString("refreshToken"),
            let expiresAt = call.getDouble("expiresAt"),
            let supabaseUrl = call.getString("supabaseUrl"),
            let supabaseAnonKey = call.getString("supabaseAnonKey")
        else {
            call.reject("Faltam parâmetros (accessToken/refreshToken/expiresAt/supabaseUrl/supabaseAnonKey).")
            return
        }
        let session = SharedSession(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: expiresAt,
            supabaseUrl: supabaseUrl,
            supabaseAnonKey: supabaseAnonKey
        )
        session.save()
        call.resolve()
    }

    @objc func clearSession(_ call: CAPPluginCall) {
        SharedSession.clear()
        call.resolve()
    }
}
