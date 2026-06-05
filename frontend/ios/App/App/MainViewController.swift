import CapApp_SPM
import Capacitor
import UIKit

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(LocalVisionPlugin())
        bridge?.registerPluginInstance(HighAccuracyLocationPlugin())
    }
}
