import Foundation
import Capacitor
import WidgetKit

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
        CAPPluginMethod(name: "getSession", returnType: CAPPluginReturnPromise),
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
        // Confere se o que acabou de ser gravado realmente volta na leitura — se o App Group
        // não estiver de fato compartilhado (entitlement ausente na assinatura, por exemplo),
        // UserDefaults(suiteName:) não lança erro nenhum, só silenciosamente não persiste. Sem
        // essa checagem, saveSession() "funciona" do ponto de vista do app mesmo quando o widget
        // nunca vai conseguir ler nada.
        guard SharedSession.load()?.accessToken == accessToken else {
            call.reject("A sessão não foi lida de volta do App Group — provavelmente o entitlement de App Groups não está na assinatura deste build.")
            return
        }
        // Sem isso, um widget que já tentou buscar dados sem sessão (ex.: logo depois de
        // instalado, antes do primeiro login) fica preso na tela "Abra o app para conectar"
        // até o próximo reload agendado por ele mesmo — até 45 min depois, pela política de
        // timeline de cada widget. Avisar o WidgetKit aqui faz ele tentar de novo na hora.
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func clearSession(_ call: CAPPluginCall) {
        SharedSession.clear()
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    /// Lê a sessão do App Group de volta pro WebView. Existe porque o widget roda em
    /// processo separado e, quando o access token expira enquanto o app está em segundo
    /// plano, ele renova sozinho batendo direto na API do Supabase (ver
    /// SharedSession.refreshed()) — e como o refresh token é de uso único (rotacionado a
    /// cada troca), isso invalida o refresh token que o supabase-js do WebView ainda tem
    /// guardado. Sem reler daqui no retorno ao app, a primeira tentativa de auto-refresh
    /// do WebView usa um refresh token já queimado e desloga a pessoa — mesmo ela tendo
    /// acabado de usar o app normalmente.
    @objc func getSession(_ call: CAPPluginCall) {
        guard let session = SharedSession.load() else {
            call.resolve([:])
            return
        }
        call.resolve([
            "accessToken": session.accessToken,
            "refreshToken": session.refreshToken,
            "expiresAt": session.expiresAt,
        ])
    }
}
