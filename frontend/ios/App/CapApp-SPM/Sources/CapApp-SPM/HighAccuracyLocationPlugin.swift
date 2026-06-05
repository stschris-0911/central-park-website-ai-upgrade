import Capacitor
import CoreLocation
import Foundation

@objc(HighAccuracyLocationPlugin)
public class HighAccuracyLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "HighAccuracyLocationPlugin"
    public let jsName = "HighAccuracyLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise)
    ]

    private lazy var locationManager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        configure(manager)
        return manager
    }()

    private var pendingStartCall: CAPPluginCall?
    private var pendingCurrentPositionCall: CAPPluginCall?
    private var currentPositionTimeout: DispatchWorkItem?
    private var watching = false

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard CLLocationManager.locationServicesEnabled() else {
                call.reject("Location services are disabled on this iPhone.")
                return
            }

            self.configure(self.locationManager)

            switch self.locationManager.authorizationStatus {
            case .notDetermined:
                self.pendingStartCall = call
                self.locationManager.requestWhenInUseAuthorization()
            case .authorizedAlways, .authorizedWhenInUse:
                self.startUpdating()
                call.resolve(self.statusPayload())
            case .denied, .restricted:
                call.reject("Location permission denied. Enable While Using and Precise Location in iOS Settings.")
            @unknown default:
                call.reject("Location permission is unavailable.")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.watching = false
            self.locationManager.stopUpdatingLocation()
            call.resolve(["stopped": true])
        }
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard CLLocationManager.locationServicesEnabled() else {
                call.reject("Location services are disabled on this iPhone.")
                return
            }

            self.configure(self.locationManager)

            switch self.locationManager.authorizationStatus {
            case .notDetermined:
                self.pendingCurrentPositionCall = call
                self.locationManager.requestWhenInUseAuthorization()
            case .authorizedAlways, .authorizedWhenInUse:
                self.requestOneShotLocation(call)
            case .denied, .restricted:
                call.reject("Location permission denied. Enable While Using and Precise Location in iOS Settings.")
            @unknown default:
                call.reject("Location permission is unavailable.")
            }
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            if let call = pendingStartCall {
                pendingStartCall = nil
                startUpdating()
                call.resolve(statusPayload())
            }

            if let call = pendingCurrentPositionCall {
                requestOneShotLocation(call)
            }
        case .denied, .restricted:
            let message = "Location permission denied. Enable While Using and Precise Location in iOS Settings."
            pendingStartCall?.reject(message)
            pendingStartCall = nil
            pendingCurrentPositionCall?.reject(message)
            pendingCurrentPositionCall = nil
        default:
            break
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let payload = locationPayload(location)

        if let call = pendingCurrentPositionCall {
            currentPositionTimeout?.cancel()
            currentPositionTimeout = nil
            pendingCurrentPositionCall = nil
            call.resolve(payload)
        }

        if watching {
            notifyListeners("location", data: payload)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let message = error.localizedDescription

        if let call = pendingCurrentPositionCall {
            currentPositionTimeout?.cancel()
            currentPositionTimeout = nil
            pendingCurrentPositionCall = nil
            call.reject(message)
        }

        if watching {
            notifyListeners("locationError", data: ["message": message])
        }
    }

    private func configure(_ manager: CLLocationManager) {
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = 1.0
        manager.activityType = .fitness
        manager.pausesLocationUpdatesAutomatically = false
    }

    private func startUpdating() {
        watching = true
        configure(locationManager)
        locationManager.startUpdatingLocation()
    }

    private func requestOneShotLocation(_ call: CAPPluginCall) {
        if let existing = pendingCurrentPositionCall, existing !== call {
            existing.reject("A newer location request was started.")
        }

        pendingCurrentPositionCall = call
        currentPositionTimeout?.cancel()

        let timeoutMs = call.getDouble("timeoutMs") ?? 10000
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.pendingCurrentPositionCall === call else { return }
            self.pendingCurrentPositionCall = nil
            call.reject("Location request timed out.")
        }

        currentPositionTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs)), execute: timeout)
        locationManager.requestLocation()
    }

    private func statusPayload() -> [String: Any] {
        return [
            "status": authorizationStatusString(locationManager.authorizationStatus),
            "precise": isPreciseLocationEnabled(),
            "desiredAccuracy": "bestForNavigation",
            "distanceFilterMeters": locationManager.distanceFilter
        ]
    }

    private func locationPayload(_ location: CLLocation) -> [String: Any] {
        var payload: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyMeters": nullable(location.horizontalAccuracy),
            "timestampMs": location.timestamp.timeIntervalSince1970 * 1000,
            "source": "ios-corelocation",
            "precise": isPreciseLocationEnabled(),
            "authorizationStatus": authorizationStatusString(locationManager.authorizationStatus)
        ]

        payload["speedMetersPerSecond"] = nullable(location.speed)
        payload["courseDegrees"] = nullable(location.course)
        payload["altitudeMeters"] = location.verticalAccuracy >= 0 ? location.altitude as Any : NSNull()
        payload["altitudeAccuracyMeters"] = nullable(location.verticalAccuracy)
        return payload
    }

    private func nullable(_ value: CLLocationAccuracy) -> Any {
        if value >= 0 {
            return value
        }
        return NSNull()
    }

    private func isPreciseLocationEnabled() -> Bool {
        if #available(iOS 14.0, *) {
            return locationManager.accuracyAuthorization == .fullAccuracy
        }
        return true
    }

    private func authorizationStatusString(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "notDetermined"
        case .restricted:
            return "restricted"
        case .denied:
            return "denied"
        case .authorizedAlways:
            return "authorizedAlways"
        case .authorizedWhenInUse:
            return "authorizedWhenInUse"
        @unknown default:
            return "unknown"
        }
    }
}
