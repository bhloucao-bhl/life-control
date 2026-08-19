import WidgetKit
import SwiftUI

@main
struct LifeControlWidgetsBundle: WidgetBundle {
    var body: some Widget {
        DashboardWidget()
        DietWidget()
        FinanceWidget()
        PurchasesWidget()
        ScenesWidget()
        SceneLockWidget()
    }
}
