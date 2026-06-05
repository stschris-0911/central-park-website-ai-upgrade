import Accelerate
import Capacitor
import CoreGraphics
import CoreML
import CoreVideo
import Foundation
import UIKit

@objc(LocalVisionPlugin)
public class LocalVisionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalVisionPlugin"
    public let jsName = "LocalVision"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "health", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "analyzeFrame", returnType: CAPPluginReturnPromise)
    ]

    private lazy var engine = LocalVisionEngine()

    public override init() {
        super.init()
    }

    @objc func health(_ call: CAPPluginCall) {
        call.resolve(engine.health())
    }

    @objc func analyzeFrame(_ call: CAPPluginCall) {
        guard let imageBase64 = call.getString("imageBase64") else {
            call.reject("imageBase64 is required.")
            return
        }

        let modeValue = call.getString("mode") ?? "open_path"
        let confidence = Float(call.getDouble("confidence") ?? 0.4)

        do {
            let response = try engine.analyzeFrame(imageBase64: imageBase64, modeValue: modeValue, confidence: confidence)
            call.resolve(response)
        } catch {
            call.reject(error.localizedDescription)
        }
    }
}

private enum LocalVisionError: LocalizedError {
    case invalidImage
    case unsupportedMode(String)
    case modelResourceMissing(String)
    case predictionOutputMissing
    case pixelBufferCreationFailed

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            return "Unable to decode the camera frame."
        case .unsupportedMode(let mode):
            return "Unsupported local vision mode: \(mode)."
        case .modelResourceMissing(let name):
            return "Core ML model resource is missing: \(name)."
        case .predictionOutputMissing:
            return "Core ML prediction output was not in the expected YOLO segmentation format."
        case .pixelBufferCreationFailed:
            return "Unable to create the Core ML input pixel buffer."
        }
    }
}

private enum LocalVisionMode: String {
    case openPath = "open_path"
    case crosswalk

    init(value: String) throws {
        if value == "open_path" {
            self = .openPath
        } else if value == "crosswalk" {
            self = .crosswalk
        } else {
            throw LocalVisionError.unsupportedMode(value)
        }
    }
}

private struct LetterboxInfo {
    let originalWidth: Int
    let originalHeight: Int
    let inputSize: Int
    let scale: CGFloat
    let padX: CGFloat
    let padY: CGFloat

    func mapX(_ x: Float) -> Float {
        let value = (CGFloat(x) - padX) / scale
        return Float(min(max(value, 0), CGFloat(originalWidth)))
    }

    func mapY(_ y: Float) -> Float {
        let value = (CGFloat(y) - padY) / scale
        return Float(min(max(value, 0), CGFloat(originalHeight)))
    }

    func mapMaskY(_ y: Int, maskHeight: Int) -> Int {
        let modelY = CGFloat(y) * CGFloat(inputSize) / CGFloat(maskHeight)
        return Int((modelY - padY) / scale)
    }
}

private struct ModelPair {
    let modelName: String
    let labels: [String]
    let model: MLModel
}

private struct RawDetection {
    let label: String
    let classId: Int
    let confidence: Float
    let x1: Float
    let y1: Float
    let x2: Float
    let y2: Float
    let maskCoefficients: [Float]

    var area: Float {
        max(0, x2 - x1) * max(0, y2 - y1)
    }
}

private struct LocalDetection {
    let raw: RawDetection
    let originalBox: [Float]
    let mask: [Bool]
    let maskAreaRatio: Float
}

private struct LocalCurbWarning {
    let active: Bool
    let curbType: String?
    let fanPosition: String?
    let fanZone: Int?
    let severity: String
    let distanceScore: Float?
    let avoidanceDirection: String?
    let guidance: String?

    func dictionary() -> [String: Any] {
        return [
            "active": active,
            "curb_type": curbType as Any,
            "fan_position": fanPosition as Any,
            "fan_zone": fanZone as Any,
            "severity": severity,
            "distance_score": distanceScore as Any,
            "avoidance_direction": avoidanceDirection as Any,
            "guidance": guidance as Any
        ]
    }
}

private final class LocalVisionEngine {
    private let inputSize = 640
    private let maskSize = 160
    private let maskChannels = 32
    private let maxDetections = 24
    private let iouThreshold: Float = 0.45
    private let maskThreshold: Float = 0.5

    private let openPathLabels = ["curb_down", "curb_up", "road", "sidewalk"]
    private let crosswalkLabels = ["crosswalk", "curb_down", "curb_up", "road", "sidewalk"]

    private var openPathModel: ModelPair?
    private var crosswalkModel: ModelPair?
    private let modelLock = NSLock()

    func health() -> [String: Any] {
        return [
            "status": "ok",
            "engine": "coreml",
            "available": true,
            "models": [
                "open_path": modelStatus(name: "best", labels: openPathLabels),
                "crosswalk": modelStatus(name: "crosswalk", labels: crosswalkLabels)
            ]
        ]
    }

    func analyzeFrame(imageBase64: String, modeValue: String, confidence: Float) throws -> [String: Any] {
        let mode = try LocalVisionMode(value: modeValue)
        let imageData = try decodeBase64Image(imageBase64)
        guard let image = UIImage(data: imageData), let cgImage = image.normalizedCgImage() else {
            throw LocalVisionError.invalidImage
        }

        let letterbox = try makePixelBuffer(from: cgImage)
        let modelPair = try model(for: mode)
        let provider = try MLDictionaryFeatureProvider(dictionary: [
            "image": MLFeatureValue(pixelBuffer: letterbox.pixelBuffer)
        ])
        let prediction = try modelPair.model.prediction(from: provider)
        let outputs = try parseOutputs(prediction)

        let rawDetections = parseDetections(
            outputs.detections,
            labels: modelPair.labels,
            confidence: confidence
        )
        let keptDetections = nonMaximumSuppression(rawDetections)
        let localDetections = keptDetections.map { raw in
            makeLocalDetection(raw: raw, proto: outputs.proto, letterbox: letterbox.info)
        }

        let classMasks = unionMasks(localDetections)
        switch mode {
        case .openPath:
            return analyzeOpenPath(
                detections: localDetections,
                classMasks: classMasks,
                letterbox: letterbox.info,
                labels: modelPair.labels
            )
        case .crosswalk:
            return analyzeCrosswalk(
                detections: localDetections,
                classMasks: classMasks,
                letterbox: letterbox.info,
                labels: modelPair.labels
            )
        }
    }

    private func modelStatus(name: String, labels: [String]) -> [String: Any] {
        let exists = modelResourceURL(name: name) != nil
        return [
            "path": "public/vision_coreml/\(name).mlpackage",
            "exists": exists,
            "classes": labels,
            "loaded": isLoaded(name: name)
        ]
    }

    private func isLoaded(name: String) -> Bool {
        modelLock.lock()
        defer { modelLock.unlock() }
        if name == "best" {
            return openPathModel != nil
        }
        if name == "crosswalk" {
            return crosswalkModel != nil
        }
        return false
    }

    private func model(for mode: LocalVisionMode) throws -> ModelPair {
        modelLock.lock()
        defer { modelLock.unlock() }

        switch mode {
        case .openPath:
            if let openPathModel {
                return openPathModel
            }
            let loaded = try loadModel(name: "best", labels: openPathLabels)
            openPathModel = loaded
            return loaded
        case .crosswalk:
            if let crosswalkModel {
                return crosswalkModel
            }
            let loaded = try loadModel(name: "crosswalk", labels: crosswalkLabels)
            crosswalkModel = loaded
            return loaded
        }
    }

    private func loadModel(name: String, labels: [String]) throws -> ModelPair {
        guard let resourceURL = modelResourceURL(name: name) else {
            throw LocalVisionError.modelResourceMissing(name)
        }

        let modelURL: URL
        if resourceURL.pathExtension == "mlmodelc" {
            modelURL = resourceURL
        } else {
            modelURL = try MLModel.compileModel(at: resourceURL)
        }

        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        let model = try MLModel(contentsOf: modelURL, configuration: configuration)
        return ModelPair(modelName: name, labels: labels, model: model)
    }

    private func modelResourceURL(name: String) -> URL? {
        let bundle = Bundle.main
        let subdirectory = "public/vision_coreml"
        if let url = bundle.url(forResource: name, withExtension: "mlmodelc") {
            return url
        }
        if let url = bundle.url(forResource: name, withExtension: "mlpackage", subdirectory: subdirectory) {
            return url
        }
        if let url = bundle.resourceURL?.appendingPathComponent("\(subdirectory)/\(name).mlpackage"),
           FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return nil
    }

    private func decodeBase64Image(_ value: String) throws -> Data {
        let base64: String
        if let commaIndex = value.firstIndex(of: ",") {
            base64 = String(value[value.index(after: commaIndex)...])
        } else {
            base64 = value
        }
        guard let data = Data(base64Encoded: base64) else {
            throw LocalVisionError.invalidImage
        }
        return data
    }

    private func makePixelBuffer(from cgImage: CGImage) throws -> (pixelBuffer: CVPixelBuffer, info: LetterboxInfo) {
        let originalWidth = cgImage.width
        let originalHeight = cgImage.height
        let scale = min(CGFloat(inputSize) / CGFloat(originalWidth), CGFloat(inputSize) / CGFloat(originalHeight))
        let scaledWidth = CGFloat(originalWidth) * scale
        let scaledHeight = CGFloat(originalHeight) * scale
        let padX = (CGFloat(inputSize) - scaledWidth) / 2
        let padY = (CGFloat(inputSize) - scaledHeight) / 2

        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            inputSize,
            inputSize,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw LocalVisionError.pixelBufferCreationFailed
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw LocalVisionError.pixelBufferCreationFailed
        }

        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: baseAddress,
            width: inputSize,
            height: inputSize,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw LocalVisionError.pixelBufferCreationFailed
        }

        context.setFillColor(red: 114 / 255, green: 114 / 255, blue: 114 / 255, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: inputSize, height: inputSize))
        context.translateBy(x: 0, y: CGFloat(inputSize))
        context.scaleBy(x: 1, y: -1)
        context.draw(cgImage, in: CGRect(x: padX, y: padY, width: scaledWidth, height: scaledHeight))

        let info = LetterboxInfo(
            originalWidth: originalWidth,
            originalHeight: originalHeight,
            inputSize: inputSize,
            scale: scale,
            padX: padX,
            padY: padY
        )
        return (pixelBuffer, info)
    }

    private func parseOutputs(_ prediction: MLFeatureProvider) throws -> (detections: MLMultiArray, proto: MLMultiArray) {
        var detectionOutput: MLMultiArray?
        var protoOutput: MLMultiArray?

        for name in prediction.featureNames {
            guard let array = prediction.featureValue(for: name)?.multiArrayValue else { continue }
            let shape = array.shape.map { $0.intValue }
            if shape.count == 3 && shape.last == 8400 {
                detectionOutput = array
            } else if shape.count == 4 && shape.contains(maskChannels) && shape.contains(maskSize) {
                protoOutput = array
            }
        }

        guard let detectionOutput, let protoOutput else {
            throw LocalVisionError.predictionOutputMissing
        }
        return (detectionOutput, protoOutput)
    }

    private func parseDetections(
        _ output: MLMultiArray,
        labels: [String],
        confidence: Float
    ) -> [RawDetection] {
        let shape = output.shape.map { $0.intValue }
        guard shape.count == 3 else { return [] }

        let attributes = shape[1]
        let anchors = shape[2]
        let classCount = labels.count
        let coefficientStart = 4 + classCount
        let coefficientCount = max(0, attributes - coefficientStart)

        var candidates: [RawDetection] = []
        candidates.reserveCapacity(maxDetections * 2)

        for anchor in 0..<anchors {
            var bestClass = 0
            var bestScore: Float = 0
            for classIndex in 0..<classCount {
                let score = normalizedScore(multiArrayValue(output, 0, 4 + classIndex, anchor))
                if score > bestScore {
                    bestScore = score
                    bestClass = classIndex
                }
            }
            if bestScore < confidence { continue }

            let cx = multiArrayValue(output, 0, 0, anchor)
            let cy = multiArrayValue(output, 0, 1, anchor)
            let width = max(0, multiArrayValue(output, 0, 2, anchor))
            let height = max(0, multiArrayValue(output, 0, 3, anchor))
            let x1 = min(max(cx - width / 2, 0), Float(inputSize))
            let y1 = min(max(cy - height / 2, 0), Float(inputSize))
            let x2 = min(max(cx + width / 2, 0), Float(inputSize))
            let y2 = min(max(cy + height / 2, 0), Float(inputSize))
            if x2 <= x1 || y2 <= y1 { continue }

            var coefficients: [Float] = []
            coefficients.reserveCapacity(coefficientCount)
            for index in 0..<coefficientCount {
                coefficients.append(multiArrayValue(output, 0, coefficientStart + index, anchor))
            }

            candidates.append(
                RawDetection(
                    label: labels[bestClass],
                    classId: bestClass,
                    confidence: bestScore,
                    x1: x1,
                    y1: y1,
                    x2: x2,
                    y2: y2,
                    maskCoefficients: coefficients
                )
            )
        }

        return Array(candidates.sorted { $0.confidence > $1.confidence }.prefix(maxDetections * 3))
    }

    private func nonMaximumSuppression(_ detections: [RawDetection]) -> [RawDetection] {
        var selected: [RawDetection] = []
        let grouped = Dictionary(grouping: detections) { $0.classId }
        for (_, group) in grouped {
            let sorted = group.sorted { $0.confidence > $1.confidence }
            var keptForClass: [RawDetection] = []
            for detection in sorted {
                let overlaps = keptForClass.contains { iou(detection, $0) > iouThreshold }
                if !overlaps {
                    keptForClass.append(detection)
                }
                if selected.count + keptForClass.count >= maxDetections {
                    break
                }
            }
            selected.append(contentsOf: keptForClass)
            if selected.count >= maxDetections {
                break
            }
        }
        return Array(selected.sorted { $0.confidence > $1.confidence }.prefix(maxDetections))
    }

    private func makeLocalDetection(
        raw: RawDetection,
        proto: MLMultiArray,
        letterbox: LetterboxInfo
    ) -> LocalDetection {
        let mask = buildMask(for: raw, proto: proto)
        let area = Float(mask.filter { $0 }.count) / Float(mask.count)
        let originalBox = [
            letterbox.mapX(raw.x1),
            letterbox.mapY(raw.y1),
            letterbox.mapX(raw.x2),
            letterbox.mapY(raw.y2)
        ]
        return LocalDetection(raw: raw, originalBox: originalBox, mask: mask, maskAreaRatio: area)
    }

    private func buildMask(for detection: RawDetection, proto: MLMultiArray) -> [Bool] {
        var mask = Array(repeating: false, count: maskSize * maskSize)
        guard detection.maskCoefficients.count >= maskChannels else { return mask }

        let x1 = max(0, Int(floor(detection.x1 / Float(inputSize) * Float(maskSize))))
        let y1 = max(0, Int(floor(detection.y1 / Float(inputSize) * Float(maskSize))))
        let x2 = min(maskSize - 1, Int(ceil(detection.x2 / Float(inputSize) * Float(maskSize))))
        let y2 = min(maskSize - 1, Int(ceil(detection.y2 / Float(inputSize) * Float(maskSize))))
        if x2 <= x1 || y2 <= y1 { return mask }

        for y in y1...y2 {
            for x in x1...x2 {
                var value: Float = 0
                for channel in 0..<maskChannels {
                    value += detection.maskCoefficients[channel] * multiArrayValue(proto, 0, channel, y, x)
                }
                if sigmoid(value) >= maskThreshold {
                    mask[y * maskSize + x] = true
                }
            }
        }
        return mask
    }

    private func unionMasks(_ detections: [LocalDetection]) -> [String: [Bool]] {
        var masks: [String: [Bool]] = [:]
        for detection in detections {
            var union = masks[detection.raw.label] ?? Array(repeating: false, count: maskSize * maskSize)
            for index in detection.mask.indices where detection.mask[index] {
                union[index] = true
            }
            masks[detection.raw.label] = union
        }
        return masks
    }

    private func analyzeOpenPath(
        detections: [LocalDetection],
        classMasks: [String: [Bool]],
        letterbox: LetterboxInfo,
        labels: [String]
    ) -> [String: Any] {
        let traversable = analyzeTraversableSpace(classMasks: classMasks, letterbox: letterbox)
        let curbWarning = analyzeCurb(classMasks: classMasks)
        let direction = curbWarning.active ? (curbWarning.avoidanceDirection ?? "stop") : traversable.direction
        let confidence = detections.first?.raw.confidence ?? 0
        let guidance = guidanceText(direction: direction, curbWarning: curbWarning, mode: .openPath)

        return commonResponse(
            mode: .openPath,
            detections: detections,
            classMasks: classMasks,
            letterbox: letterbox,
            labels: labels,
            direction: direction,
            confidence: confidence,
            guidance: guidance,
            openPath: [
                "direction": traversable.direction as Any,
                "best_column": traversable.bestColumn as Any,
                "vibration_intensity": vibrationIntensity(for: direction),
                "sidewalk_top_y": traversable.scanBand["top_y"] as Any,
                "raw_scores": traversable.rawScores,
                "adjusted_scores": traversable.adjustedScores,
                "traversable_source": traversable.source as Any
            ],
            traversable: traversable.dictionary,
            curbWarning: curbWarning.dictionary(),
            crosswalk: nil
        )
    }

    private func analyzeCrosswalk(
        detections: [LocalDetection],
        classMasks: [String: [Bool]],
        letterbox: LetterboxInfo,
        labels: [String]
    ) -> [String: Any] {
        let crosswalk = analyzeCrosswalkMask(classMasks["crosswalk"])
        let direction = (crosswalk["direction"] as? String) ?? "stop"
        let confidence = detections.first(where: { $0.raw.label == "crosswalk" })?.raw.confidence ?? 0
        let guidance = guidanceText(direction: direction, curbWarning: nil, mode: .crosswalk)

        return commonResponse(
            mode: .crosswalk,
            detections: detections,
            classMasks: classMasks,
            letterbox: letterbox,
            labels: labels,
            direction: direction,
            confidence: confidence,
            guidance: guidance,
            openPath: nil,
            traversable: nil,
            curbWarning: analyzeCurb(classMasks: classMasks).dictionary(),
            crosswalk: crosswalk
        )
    }

    private func commonResponse(
        mode: LocalVisionMode,
        detections: [LocalDetection],
        classMasks: [String: [Bool]],
        letterbox: LetterboxInfo,
        labels: [String],
        direction: String,
        confidence: Float,
        guidance: String,
        openPath: [String: Any]?,
        traversable: [String: Any]?,
        curbWarning: [String: Any]?,
        crosswalk: [String: Any]?
    ) -> [String: Any] {
        let detectedClasses = Array(Set(detections.map { $0.raw.label })).sorted()
        return [
            "engine": "coreml",
            "mode": mode.rawValue,
            "image": [
                "width": letterbox.originalWidth,
                "height": letterbox.originalHeight
            ],
            "detected_classes": detectedClasses,
            "detections": detections.map { detectionDictionary($0, letterbox: letterbox) },
            "areas": areaRatios(classMasks),
            "open_path": openPath as Any,
            "traversable": traversable as Any,
            "curb_warning": curbWarning as Any,
            "crosswalk": crosswalk as Any,
            "direction": direction,
            "confidence": confidence,
            "guidance_text": guidance
        ]
    }

    private func detectionDictionary(_ detection: LocalDetection, letterbox: LetterboxInfo) -> [String: Any] {
        let box = detection.originalBox
        let contour: [[Float]] = [
            [box[0], box[1]],
            [box[2], box[1]],
            [box[2], box[3]],
            [box[0], box[3]]
        ]
        return [
            "label": detection.raw.label,
            "class_id": detection.raw.classId,
            "confidence": detection.raw.confidence,
            "bbox": box,
            "area_ratio": detection.maskAreaRatio,
            "mask_shape": [maskSize, maskSize],
            "contour": contour
        ]
    }

    private func areaRatios(_ classMasks: [String: [Bool]]) -> [String: Float] {
        var values: [String: Float] = [:]
        for (label, mask) in classMasks {
            values[label] = Float(mask.filter { $0 }.count) / Float(mask.count)
        }
        return values
    }

    private func analyzeTraversableSpace(
        classMasks: [String: [Bool]],
        letterbox: LetterboxInfo
    ) -> (
        direction: String,
        bestColumn: Int?,
        source: String?,
        rawScores: [[Float]],
        adjustedScores: [[Float]],
        dictionary: [String: Any],
        scanBand: [String: Any]
    ) {
        let pathLabels = ["sidewalk", "path", "walkway", "trail", "crosswalk"]
        var source: String?
        var mask: [Bool]?
        for label in pathLabels {
            if let candidate = classMasks[label], candidate.contains(true) {
                mask = candidate
                source = label
                break
            }
        }
        if mask == nil, let road = classMasks["road"], road.contains(true) {
            mask = road
            source = "road"
        }

        let selectedMask = mask ?? Array(repeating: false, count: maskSize * maskSize)
        let curbMask = mergeMasks(["curb_down", "curb_up"], classMasks: classMasks)
        let pathTop = firstTrueRow(selectedMask) ?? Int(Float(maskSize) * 0.55)
        let topY = max(Int(Float(maskSize) * 0.45), min(pathTop, Int(Float(maskSize) * 0.70)))
        let bottomY = maskSize - 1
        let rows = 3
        let columns = 7

        var rawScores = Array(repeating: Array(repeating: Float(0), count: columns), count: rows)
        var adjustedScores = rawScores
        var columnScores = Array(repeating: Float(0), count: columns)
        var curbPenalties = Array(repeating: Float(0), count: columns)

        for row in 0..<rows {
            for column in 0..<columns {
                rawScores[row][column] = cellScore(
                    mask: selectedMask,
                    row: row,
                    column: column,
                    rows: rows,
                    columns: columns,
                    topY: topY,
                    bottomY: bottomY
                )
                let curbScore = cellScore(
                    mask: curbMask,
                    row: row,
                    column: column,
                    rows: rows,
                    columns: columns,
                    topY: topY,
                    bottomY: bottomY
                )
                adjustedScores[row][column] = max(0, rawScores[row][column] - curbScore * 0.45)
            }
        }

        let rowWeights: [Float] = [0.2, 0.3, 0.5]
        for column in 0..<columns {
            var score: Float = 0
            var penalty: Float = 0
            for row in 0..<rows {
                score += adjustedScores[row][column] * rowWeights[row]
                penalty += cellScore(
                    mask: curbMask,
                    row: row,
                    column: column,
                    rows: rows,
                    columns: columns,
                    topY: topY,
                    bottomY: bottomY
                ) * rowWeights[row]
            }
            let centerBoost = max(0, 0.04 - Float(abs(column - 3)) * 0.012)
            columnScores[column] = score + centerBoost
            curbPenalties[column] = penalty
        }

        let traversableArea = Float(selectedMask.filter { $0 }.count) / Float(selectedMask.count)
        let bestColumn = columnScores.enumerated().max(by: { $0.element < $1.element })?.offset
        let bestScore = bestColumn.map { columnScores[$0] } ?? 0
        let direction: String
        if traversableArea < 0.015 || bestScore < 0.07 {
            direction = "stop"
        } else {
            direction = directionForColumn(bestColumn ?? 3)
        }

        let originalTop = max(0, min(letterbox.originalHeight, letterbox.mapMaskY(topY, maskHeight: maskSize)))
        let originalBottom = max(0, min(letterbox.originalHeight, letterbox.mapMaskY(bottomY, maskHeight: maskSize)))
        let scanBand: [String: Any] = [
            "top_y": originalTop,
            "bottom_y": originalBottom,
            "height": max(0, originalBottom - originalTop),
            "grid_rows": rows,
            "grid_cols": columns,
            "estimated_path_top_y": originalTop,
            "source": source as Any
        ]

        let dictionary: [String: Any] = [
            "best_direction": direction,
            "best_column": bestColumn as Any,
            "best_score": bestScore,
            "best_region": bestColumn.map {
                [
                    "start_column": $0,
                    "end_column": $0,
                    "center_column": $0,
                    "width_columns": 1,
                    "score": bestScore
                ]
            } as Any,
            "raw_scores": rawScores,
            "adjusted_scores": adjustedScores,
            "column_scores": columnScores,
            "penalized_scores": columnScores,
            "curb_penalties": curbPenalties,
            "center_preference_applied": true,
            "scan_band": scanBand,
            "traversable_area_ratio": traversableArea,
            "non_traversable_area_ratio": 1 - traversableArea,
            "source_area_ratios": areaRatios(classMasks),
            "curb_area_ratio": Float(curbMask.filter { $0 }.count) / Float(curbMask.count),
            "traversable_source": source as Any,
            "stop_reason": direction == "stop" ? "low_traversable_score" : NSNull()
        ]

        return (direction, bestColumn, source, rawScores, adjustedScores, dictionary, scanBand)
    }

    private func analyzeCurb(classMasks: [String: [Bool]]) -> LocalCurbWarning {
        let curbMask = mergeMasks(["curb_down", "curb_up"], classMasks: classMasks)
        let activePixels = curbMask.enumerated().filter { $0.element }
        if activePixels.isEmpty {
            return LocalCurbWarning(active: false, curbType: nil, fanPosition: nil, fanZone: nil, severity: "none", distanceScore: nil, avoidanceDirection: nil, guidance: nil)
        }

        let lowerPixels = activePixels.filter { index, _ in
            let y = index / maskSize
            return y >= Int(Float(maskSize) * 0.52)
        }
        if lowerPixels.isEmpty {
            return LocalCurbWarning(active: false, curbType: nil, fanPosition: nil, fanZone: nil, severity: "none", distanceScore: nil, avoidanceDirection: nil, guidance: nil)
        }

        let avgX = Float(lowerPixels.reduce(0) { $0 + ($1.offset % maskSize) }) / Float(lowerPixels.count)
        let avgY = Float(lowerPixels.reduce(0) { $0 + ($1.offset / maskSize) }) / Float(lowerPixels.count)
        let xRatio = avgX / Float(maskSize)
        let yRatio = avgY / Float(maskSize)
        let position: String
        let zone: Int
        let avoidance: String
        if xRatio < 0.38 {
            position = yRatio > 0.72 ? "left near" : "left far"
            zone = yRatio > 0.72 ? 4 : 1
            avoidance = "right"
        } else if xRatio > 0.62 {
            position = yRatio > 0.72 ? "right near" : "right far"
            zone = yRatio > 0.72 ? 6 : 3
            avoidance = "left"
        } else {
            position = yRatio > 0.72 ? "front near" : "front far"
            zone = yRatio > 0.72 ? 5 : 2
            avoidance = "stop"
        }

        let area = Float(activePixels.count) / Float(curbMask.count)
        let active = yRatio > 0.60 && area > 0.004
        let severity = yRatio > 0.72 ? "high" : "medium"
        let guidance = active ? "Curb \(position). \(avoidance == "stop" ? "Stop" : "Move \(avoidance)")" : nil
        return LocalCurbWarning(
            active: active,
            curbType: "curb",
            fanPosition: position,
            fanZone: zone,
            severity: active ? severity : "none",
            distanceScore: yRatio,
            avoidanceDirection: avoidance,
            guidance: guidance
        )
    }

    private func analyzeCrosswalkMask(_ mask: [Bool]?) -> [String: Any] {
        guard let mask, mask.contains(true) else {
            return [
                "activated": false,
                "offset_ratio": 0,
                "direction": "stop",
                "intensity": "none",
                "valid_row_count": 0,
                "row_centers": []
            ]
        }

        var rowCenters: [[String: Float]] = []
        for y in Int(Float(maskSize) * 0.45)..<Int(Float(maskSize) * 0.92) {
            let xs = (0..<maskSize).filter { mask[y * maskSize + $0] }
            if xs.count < 3 { continue }
            let center = Float((xs.first ?? 0) + (xs.last ?? 0)) / 2
            rowCenters.append(["y": Float(y), "center_x": center, "width": Float(xs.count)])
        }

        if rowCenters.isEmpty {
            return [
                "activated": false,
                "offset_ratio": 0,
                "direction": "stop",
                "intensity": "none",
                "valid_row_count": 0,
                "row_centers": []
            ]
        }

        var weightedSum: Float = 0
        var totalWeight: Float = 0
        for row in rowCenters {
            let weight = max(1, row["width"] ?? 1)
            weightedSum += (row["center_x"] ?? Float(maskSize) / 2) * weight
            totalWeight += weight
        }

        let center = weightedSum / max(1, totalWeight)
        let offsetRatio = (center - Float(maskSize) / 2) / (Float(maskSize) / 2)
        let direction: String
        let intensity: String
        if offsetRatio < -0.16 {
            direction = "left"
            intensity = abs(offsetRatio) > 0.35 ? "high" : "medium"
        } else if offsetRatio > 0.16 {
            direction = "right"
            intensity = abs(offsetRatio) > 0.35 ? "high" : "medium"
        } else {
            direction = "center"
            intensity = "low"
        }

        return [
            "activated": true,
            "offset_ratio": offsetRatio,
            "direction": direction,
            "intensity": intensity,
            "crosswalk_center_x": center,
            "valid_row_count": rowCenters.count,
            "row_centers": rowCenters
        ]
    }

    private func mergeMasks(_ labels: [String], classMasks: [String: [Bool]]) -> [Bool] {
        var mask = Array(repeating: false, count: maskSize * maskSize)
        for label in labels {
            guard let source = classMasks[label] else { continue }
            for index in source.indices where source[index] {
                mask[index] = true
            }
        }
        return mask
    }

    private func firstTrueRow(_ mask: [Bool]) -> Int? {
        for y in 0..<maskSize {
            for x in 0..<maskSize where mask[y * maskSize + x] {
                return y
            }
        }
        return nil
    }

    private func cellScore(
        mask: [Bool],
        row: Int,
        column: Int,
        rows: Int,
        columns: Int,
        topY: Int,
        bottomY: Int
    ) -> Float {
        let scanHeight = max(1, bottomY - topY + 1)
        let y0 = topY + row * scanHeight / rows
        let y1 = topY + (row + 1) * scanHeight / rows
        let x0 = column * maskSize / columns
        let x1 = (column + 1) * maskSize / columns
        var active = 0
        var total = 0

        for y in y0..<min(maskSize, y1) {
            for x in x0..<min(maskSize, x1) {
                total += 1
                if mask[y * maskSize + x] {
                    active += 1
                }
            }
        }
        return total == 0 ? 0 : Float(active) / Float(total)
    }

    private func directionForColumn(_ column: Int) -> String {
        if column <= 1 { return "left" }
        if column == 2 { return "slight_left" }
        if column == 3 { return "center" }
        if column == 4 { return "slight_right" }
        return "right"
    }

    private func vibrationIntensity(for direction: String) -> String {
        if direction == "stop" { return "high" }
        if direction == "center" || direction == "continue" { return "low" }
        return "medium"
    }

    private func guidanceText(direction: String, curbWarning: LocalCurbWarning?, mode: LocalVisionMode) -> String {
        if let curbWarning, curbWarning.active, let guidance = curbWarning.guidance {
            return guidance
        }

        if mode == .crosswalk {
            switch direction {
            case "left":
                return "Crosswalk left"
            case "right":
                return "Crosswalk right"
            case "center":
                return "Crosswalk centered"
            default:
                return "Crosswalk not found"
            }
        }

        switch direction {
        case "left":
            return "Move left"
        case "slight_left":
            return "Slight left"
        case "center", "continue":
            return "Continue straight"
        case "slight_right":
            return "Slight right"
        case "right":
            return "Move right"
        default:
            return "Stop"
        }
    }

    private func normalizedScore(_ value: Float) -> Float {
        if value >= 0 && value <= 1 {
            return value
        }
        return sigmoid(value)
    }

    private func sigmoid(_ value: Float) -> Float {
        return 1 / (1 + exp(-value))
    }

    private func iou(_ lhs: RawDetection, _ rhs: RawDetection) -> Float {
        let x1 = max(lhs.x1, rhs.x1)
        let y1 = max(lhs.y1, rhs.y1)
        let x2 = min(lhs.x2, rhs.x2)
        let y2 = min(lhs.y2, rhs.y2)
        let intersection = max(0, x2 - x1) * max(0, y2 - y1)
        let union = lhs.area + rhs.area - intersection
        return union <= 0 ? 0 : intersection / union
    }

    private func multiArrayValue(_ array: MLMultiArray, _ i0: Int, _ i1: Int, _ i2: Int) -> Float {
        let strides = array.strides.map { $0.intValue }
        let offset = i0 * strides[0] + i1 * strides[1] + i2 * strides[2]
        return array.floatValue(at: offset)
    }

    private func multiArrayValue(_ array: MLMultiArray, _ i0: Int, _ i1: Int, _ i2: Int, _ i3: Int) -> Float {
        let strides = array.strides.map { $0.intValue }
        let offset = i0 * strides[0] + i1 * strides[1] + i2 * strides[2] + i3 * strides[3]
        return array.floatValue(at: offset)
    }
}

private extension MLMultiArray {
    func floatValue(at offset: Int) -> Float {
        switch dataType {
        case .float32:
            return dataPointer.bindMemory(to: Float32.self, capacity: count)[offset]
        case .float16:
            let raw = dataPointer.bindMemory(to: UInt16.self, capacity: count)[offset]
            return Float(Float16(bitPattern: raw))
        case .double:
            return Float(dataPointer.bindMemory(to: Double.self, capacity: count)[offset])
        default:
            return Float(truncating: self[offset])
        }
    }
}

private extension UIImage {
    func normalizedCgImage() -> CGImage? {
        if imageOrientation == .up, let cgImage {
            return cgImage
        }

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let normalized = renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
        return normalized.cgImage
    }
}
