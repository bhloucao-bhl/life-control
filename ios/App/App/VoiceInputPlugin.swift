import Foundation
import Capacitor
import Speech
import AVFoundation

/// Ditado por voz nativo, via Speech framework — existe porque o WKWebView do
/// app não implementa a Web Speech API (window.webkitSpeechRecognition fica
/// undefined mesmo com o app instalado), então o botão de microfone da lista
/// de compras (e qualquer outro ditado futuro) precisa vir daqui, não do JS.
/// Emite eventos em vez de resolver a promise de start() só no final, porque
/// o app quer mostrar o texto sendo reconhecido em tempo real: "partialResult"
/// a cada atualização, "result" quando o reconhecimento termina sozinho (pausa
/// na fala) e "error" se algo falhar no meio do caminho. Ver app/page.js
/// (startDictation) pro lado JS.
@objc(VoiceInputPlugin)
public class VoiceInputPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceInputPlugin"
    public let jsName = "VoiceInput"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    // cancelar a task (stop() manual, ou start() de uma nova dictada por cima da anterior)
    // sempre dispara o completion handler de novo com um erro de "cancelado" — sem essa
    // flag isso vazava pro JS como um evento "error" mesmo quando foi o próprio usuário
    // que parou o ditado de propósito.
    private var isStopping = false

    @objc func isAvailable(_ call: CAPPluginCall) {
        let locale = Locale(identifier: call.getString("language") ?? "pt-BR")
        let available = SFSpeechRecognizer(locale: locale)?.isAvailable ?? false
        call.resolve(["available": available])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                DispatchQueue.main.async { call.resolve(["granted": false]) }
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
                DispatchQueue.main.async { call.resolve(["granted": micGranted]) }
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        stopInternal()
        isStopping = false
        let language = call.getString("language") ?? "pt-BR"
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            call.reject("Reconhecimento de voz indisponível para \(language).")
            return
        }
        self.recognizer = recognizer

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            call.reject("Falha ao preparar o áudio: \(error.localizedDescription)")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // item de lista de compras é curto: prioriza rodar on-device (mais rápido,
        // funciona sem internet) quando o aparelho suporta.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        self.request = request

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            call.reject("Falha ao iniciar o microfone: \(error.localizedDescription)")
            return
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self, !self.isStopping else { return }
            if let result = result {
                self.notifyListeners(result.isFinal ? "result" : "partialResult", data: ["text": result.bestTranscription.formattedString])
                if result.isFinal { self.stopInternal() }
            }
            if let error = error {
                self.notifyListeners("error", data: ["message": error.localizedDescription])
                self.stopInternal()
            }
        }

        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopInternal()
        call.resolve()
    }

    private func stopInternal() {
        isStopping = true
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
