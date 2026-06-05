# Mobile Vision Deployment Notes

These notes summarize the current implementation against the latest meeting
direction: move model inference into Xcode for offline iPhone testing, while
keeping a future path open for cross-platform mobile deployment.

## Current iOS Decision

The iOS app uses Core ML for offline local inference.

Included model sources:

```text
backend/app/models/vision/best.pt
backend/app/models/vision/crosswalk.pt
```

Converted iOS model packages:

```text
backend/app/models/vision/best.mlpackage
backend/app/models/vision/crosswalk.mlpackage
frontend/public/vision_coreml/best.mlpackage
frontend/public/vision_coreml/crosswalk.mlpackage
frontend/ios/App/App/public/vision_coreml/best.mlpackage
frontend/ios/App/App/public/vision_coreml/crosswalk.mlpackage
```

Native iOS bridge:

```text
frontend/ios/App/CapApp-SPM/Sources/CapApp-SPM/LocalVisionPlugin.swift
frontend/ios/App/App/MainViewController.swift
frontend/src/lib/localVision.ts
```

The Vision Test panel supports:

```text
Auto          -> try iPhone Core ML first, then backend fallback
Local Core ML -> force offline iPhone inference
Backend       -> use the FastAPI backend
```

For real offline iPhone testing, choose `Local Core ML`.

## Why Core ML First

Core ML is Apple's native model format and runtime. It can run on CPU, GPU, and
Neural Engine where supported. This is the right first target for iPhone-only
offline testing because it integrates directly with Xcode and does not require
the Mac backend, Render, or network access.

## ONNX Runtime Direction

The meeting also discussed ONNX Runtime for a shared iOS/Android route.

That remains a good next step for cross-platform work:

```text
iOS     -> ONNX Runtime with Core ML Execution Provider
Android -> ONNX Runtime with NNAPI Execution Provider
```

The current iOS app does not use ONNX Runtime yet. It uses Core ML directly.
This keeps the iPhone prototype simpler and easier to run in Xcode. ONNX export
is still useful for Android planning and future shared model validation.

## Model Export Script

Use:

```bash
scripts/export_mobile_vision_models.sh
```

The script exports:

```text
best.pt      -> Core ML + ONNX
crosswalk.pt -> Core ML + ONNX
```

Then it copies the Core ML packages into the frontend public assets so
`npx cap sync ios` can place them inside the Xcode app bundle.

## Quantization

Quantization can reduce model size and improve mobile speed, but it may change
segmentation quality. This project currently keeps the default floating-point
Core ML export to preserve behavior during integration testing.

Recommended order:

1. Verify offline Core ML inference on a real iPhone.
2. Record baseline accuracy and latency.
3. Try quantized export.
4. Compare masks, boxes, direction output, and heat/latency.

## Future Pedestrian Signal Model

The current local models cover:

```text
curb_down
curb_up
road
sidewalk
crosswalk
```

A pedestrian signal model should be added as a separate model or a clearly
versioned replacement model. It should distinguish pedestrian crossing signals
from vehicle traffic lights and only report actionable pedestrian signal states,
such as:

```text
walk
do_not_walk
countdown
unknown
```

The local iOS bridge can be extended with another model entry after the model
labels and output shape are confirmed.
