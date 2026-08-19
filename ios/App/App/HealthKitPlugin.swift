import Foundation
import Capacitor
import HealthKit

/// Ponte nativa pro HealthKit. Começou só lendo passos (mais rápido que a
/// sincronização em nuvem da Oura); agora também lê sono, frequência cardíaca
/// de repouso, HRV, calorias ativas, peso e treinos — tudo pra dar ao
/// Dr. Claude uma visão mais completa da saúde da pessoa, não só o que a
/// Oura sincroniza. A única coisa que este plugin GRAVA de volta no
/// HealthKit é peso (saveWeight) — quando a pessoa registra o peso no app,
/// ele também aparece no Apple Health, sem precisar manter os dois em sincronia
/// na mão. Ver app/page.js (syncHealthKitSteps/syncHealthKitExtras/addWeight)
/// pro lado JS e app/api/healthkit-metrics/route.js pro lado servidor.
@objc(HealthKitPlugin)
public class HealthKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthKitPlugin"
    public let jsName = "HealthKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailySteps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailyMetrics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailyWorkouts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveWeight", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()
    // API antiga (quantityType(forIdentifier:)) de propósito: o inicializador HKQuantityType(.stepCount)
    // só existe a partir do iOS 18, e o app suporta iOS 15+ (IPHONEOS_DEPLOYMENT_TARGET).
    private let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount)!
    private let restingHRType = HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!
    private let hrvType = HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!
    private let activeEnergyType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
    private let weightType = HKQuantityType.quantityType(forIdentifier: .bodyMass)!
    private let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
    private let workoutType = HKObjectType.workoutType()

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["granted": false])
            return
        }
        let readTypes: Set<HKObjectType> = [stepType, restingHRType, hrvType, activeEnergyType, weightType, sleepType, workoutType]
        // só peso é gravado de volta (via saveWeight) — tudo o mais é só leitura.
        let shareTypes: Set<HKSampleType> = [weightType]
        store.requestAuthorization(toShare: shareTypes, read: readTypes) { success, error in
            if let error = error {
                call.reject("Falha ao pedir autorização do HealthKit: \(error.localizedDescription)")
                return
            }
            // Por privacidade, o HealthKit nunca informa se o usuário negou leitura/escrita de um
            // tipo específico — "success" aqui só significa que o fluxo de permissão rodou (ou já
            // tinha rodado antes), não que cada tipo foi de fato concedido. Cada query/gravação
            // simplesmente falha ou volta vazia pros tipos negados.
            call.resolve(["granted": success])
        }
    }

    @objc func saveWeight(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("HealthKit não disponível.")
            return
        }
        guard let kg = call.getDouble("kg"), kg > 0 else {
            call.reject("kg obrigatório.")
            return
        }
        let now = Date()
        let quantity = HKQuantity(unit: HKUnit.gramUnit(with: .kilo), doubleValue: kg)
        let sample = HKQuantitySample(type: weightType, quantity: quantity, start: now, end: now)
        store.save(sample) { success, error in
            if let error = error {
                call.reject("Falha ao gravar peso no HealthKit: \(error.localizedDescription)")
                return
            }
            call.resolve(["saved": success])
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

    // ---- passos além: sono, frequência cardíaca, HRV, calorias ativas, peso, treinos ----

    private func dayKey(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: date)
    }

    private func dateRange(days: Int, calendar: Calendar) -> (start: Date, end: Date)? {
        let endDate = Date()
        guard let startDate = calendar.date(byAdding: .day, value: -(max(1, days) - 1), to: calendar.startOfDay(for: endDate)) else { return nil }
        return (startDate, endDate)
    }

    /// Estatística diária genérica (soma ou média) pra um HKQuantityType — usada pra frequência
    /// cardíaca de repouso, HRV, calorias ativas e peso. Mesmo padrão do getDailySteps, só
    /// parametrizado por tipo/opção/unidade pra não repetir a query quatro vezes.
    private func queryDailyStatistics(type: HKQuantityType, options: HKStatisticsOptions, unit: HKUnit, days: Int, roundToOneDecimal: Bool, completion: @escaping ([String: Double]) -> Void) {
        let calendar = Calendar.current
        guard let range = dateRange(days: days, calendar: calendar) else { completion([:]); return }
        let predicate = HKQuery.predicateForSamples(withStart: range.start, end: range.end, options: .strictStartDate)
        let query = HKStatisticsCollectionQuery(
            quantityType: type,
            quantitySamplePredicate: predicate,
            options: options,
            anchorDate: calendar.startOfDay(for: range.start),
            intervalComponents: DateComponents(day: 1)
        )
        query.initialResultsHandler = { [weak self] _, results, _ in
            guard let self = self else { completion([:]); return }
            var byDate: [String: Double] = [:]
            results?.enumerateStatistics(from: range.start, to: range.end) { stats, _ in
                let value: Double? = options.contains(.cumulativeSum)
                    ? stats.sumQuantity()?.doubleValue(for: unit)
                    : stats.averageQuantity()?.doubleValue(for: unit)
                guard let v = value else { return }
                let key = self.dayKey(stats.startDate, calendar: calendar)
                byDate[key] = roundToOneDecimal ? (v * 10).rounded() / 10 : v.rounded()
            }
            completion(byDate)
        }
        store.execute(query)
    }

    /// Minutos dormindo por dia (exclui "na cama acordado"), agrupados pelo dia em que a amostra
    /// COMEÇOU — mesmo critério que a Oura usa pro campo "day" do sono. Compatível com iOS 15+:
    /// só compara com .inBed/.awake (estáveis desde o iOS 8), então qualquer outro valor (o antigo
    /// "asleep" genérico ou os estágios core/deep/rem do iOS 16+) já conta como dormindo sem
    /// precisar referenciar símbolos que não existem no deployment target do app.
    private func querySleepMinutes(days: Int, completion: @escaping ([String: Double]) -> Void) {
        let calendar = Calendar.current
        guard let range = dateRange(days: days, calendar: calendar) else { completion([:]); return }
        let predicate = HKQuery.predicateForSamples(withStart: range.start, end: range.end, options: .strictStartDate)
        let query = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { [weak self] _, samples, _ in
            guard let self = self else { completion([:]); return }
            var byDate: [String: Double] = [:]
            for sample in (samples as? [HKCategorySample] ?? []) {
                if sample.value == HKCategoryValueSleepAnalysis.inBed.rawValue || sample.value == HKCategoryValueSleepAnalysis.awake.rawValue { continue }
                let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
                let key = self.dayKey(sample.startDate, calendar: calendar)
                byDate[key] = (byDate[key] ?? 0) + minutes
            }
            completion(byDate.mapValues { $0.rounded() })
        }
        store.execute(query)
    }

    @objc func getDailyMetrics(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["restingHR": [:], "hrv": [:], "activeEnergy": [:], "weightKg": [:], "sleepMinutes": [:]])
            return
        }
        let days = max(1, call.getInt("days") ?? 14)
        let group = DispatchGroup()
        var restingHR: [String: Double] = [:]
        var hrv: [String: Double] = [:]
        var activeEnergy: [String: Double] = [:]
        var weightKg: [String: Double] = [:]
        var sleepMinutes: [String: Double] = [:]

        group.enter()
        queryDailyStatistics(type: restingHRType, options: .discreteAverage, unit: HKUnit.count().unitDivided(by: HKUnit.minute()), days: days, roundToOneDecimal: false) { r in restingHR = r; group.leave() }
        group.enter()
        queryDailyStatistics(type: hrvType, options: .discreteAverage, unit: HKUnit.secondUnit(with: .milli), days: days, roundToOneDecimal: false) { r in hrv = r; group.leave() }
        group.enter()
        queryDailyStatistics(type: activeEnergyType, options: .cumulativeSum, unit: .kilocalorie(), days: days, roundToOneDecimal: false) { r in activeEnergy = r; group.leave() }
        group.enter()
        queryDailyStatistics(type: weightType, options: .discreteAverage, unit: HKUnit.gramUnit(with: .kilo), days: days, roundToOneDecimal: true) { r in weightKg = r; group.leave() }
        group.enter()
        querySleepMinutes(days: days) { r in sleepMinutes = r; group.leave() }

        group.notify(queue: .main) {
            call.resolve([
                "restingHR": restingHR,
                "hrv": hrv,
                "activeEnergy": activeEnergy,
                "weightKg": weightKg,
                "sleepMinutes": sleepMinutes,
            ])
        }
    }

    private func workoutActivityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "running"
        case .walking: return "walking"
        case .cycling: return "cycling"
        case .swimming: return "swimming"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "strength"
        case .yoga: return "yoga"
        case .highIntensityIntervalTraining: return "hiit"
        case .soccer: return "soccer"
        case .basketball: return "basketball"
        case .tennis: return "tennis"
        case .hiking: return "hiking"
        case .elliptical: return "elliptical"
        case .rowing: return "rowing"
        case .coreTraining: return "core"
        case .dance: return "dance"
        case .pilates: return "pilates"
        default: return "other"
        }
    }

    @objc func getDailyWorkouts(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["byDate": [:]])
            return
        }
        let days = max(1, call.getInt("days") ?? 14)
        let calendar = Calendar.current
        guard let range = dateRange(days: days, calendar: calendar) else {
            call.resolve(["byDate": [:]])
            return
        }
        let predicate = HKQuery.predicateForSamples(withStart: range.start, end: range.end, options: .strictStartDate)
        let query = HKSampleQuery(sampleType: workoutType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { [weak self] _, samples, error in
            if let error = error {
                call.reject("Falha ao ler treinos do HealthKit: \(error.localizedDescription)")
                return
            }
            guard let self = self else { call.resolve(["byDate": [:]]); return }
            var byDate: [String: (minutes: Double, count: Int, types: Set<String>)] = [:]
            for workout in (samples as? [HKWorkout] ?? []) {
                let key = self.dayKey(workout.startDate, calendar: calendar)
                let minutes = workout.duration / 60
                let name = self.workoutActivityName(workout.workoutActivityType)
                var entry = byDate[key] ?? (minutes: 0, count: 0, types: [])
                entry.minutes += minutes
                entry.count += 1
                entry.types.insert(name)
                byDate[key] = entry
            }
            var result: [String: [String: Any]] = [:]
            byDate.forEach { key, entry in
                result[key] = ["minutes": Int(entry.minutes.rounded()), "count": entry.count, "types": Array(entry.types)]
            }
            call.resolve(["byDate": result])
        }
        store.execute(query)
    }
}
