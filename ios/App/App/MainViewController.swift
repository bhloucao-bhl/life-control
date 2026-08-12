import Capacitor

/// Subclasse do bridge do Capacitor só pra garantir que o SharedAuthPlugin
/// (nosso plugin local, não instalado via npm) fica registrado. Em teoria o
/// Capacitor já descobre esse tipo de plugin sozinho via runtime do
/// Objective-C, mas "sem sessão salva" aparecendo sempre no widget — mesmo
/// com login e conexões feitas — é exatamente o sintoma de saveSession()
/// nunca ter sido chamado de verdade do lado nativo. Registrar explícito
/// aqui remove essa dúvida.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedAuthPlugin())
        bridge?.registerPluginInstance(HealthKitPlugin())
    }
}
