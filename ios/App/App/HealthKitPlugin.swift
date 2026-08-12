import Foundation
import Capacitor
import HealthKit

/// Ponte nativa pro HealthKit — usada só pra ler a contagem diária de passos
/// direto do iPhone/Apple Watch (que também recebe os passos gravados pelo
/// anel Oura via o app da Oura). Diferente da Oura, que passa por sincronização
/// na nuvem e pode demorar horas pra refletir o dia atual, o HealthKit já tem
/// o dado local, na hora. Ver app/page.js (syncHealthKitSteps) pro lado JS.
@objc(HealthKitPlugin)
public class HealthKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthKitPlugin"
    public let jsName = "HealthKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailySteps", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()
    // API antiga (quantityType(forIdentifier:)) de propósito: o inicializador HKQuantityType(.stepCount)
    // só existe a partir do iOS 18, e o app suporta iOS 15+ (IPHONEOS_DEPLOYMENT_TARGET).
    private let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount)!

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["granted": false])
            return
        }
        store.requestAuthorization(toShare: nil, read: [stepType]) { success, error in
            if let error = error {
                call.reject("Falha ao pedir autorização do HealthKit: \(error.localizedDescription)")
                return
            }
            // Por privacidade, o HealthKit nunca informa se o usuário negou leitura — "success"
            // aqui só significa que o fluxo de permissão rodou (ou já tinha rodado antes), não
            // que o acesso foi de fato concedido. getDailySteps() simplesmente volta vazio se não.
            call.resolve(["granted": success])
        }
    }

    @objc func getDailySteps(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["byDate": [:]])
            return
        }
        let days = max(1, call.getInt("days") ?? 14)
        let calendar = Calendar.current
        let endDate = Date()
        guard let startDate = calendar.date(byAdding: .day, value: -(days - 1), to: calendar.startOfDay(for: endDate)) else {
            call.resolve(["byDate": [:]])
            return
        }
        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let query = HKStatisticsCollectionQuery(
            quantityType: stepType,
            quantitySamplePredicate: predicate,
            options: .cumulativeSum,
            anchorDate: calendar.startOfDay(for: startDate),
            intervalComponents: DateComponents(day: 1)
        )
        query.initialResultsHandler = { _, results, error in
            if let error = error {
                call.reject("Falha ao ler passos do HealthKit: \(error.localizedDescription)")
                return
            }
            var byDate: [String: Int] = [:]
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.timeZone = calendar.timeZone
            results?.enumerateStatistics(from: startDate, to: endDate) { stats, _ in
                guard let sum = stats.sumQuantity() else { return }
                let key = formatter.string(from: stats.startDate)
                byDate[key] = Int(sum.doubleValue(for: .count()))
            }
            call.resolve(["byDate": byDate])
        }
        store.execute(query)
    }
}
