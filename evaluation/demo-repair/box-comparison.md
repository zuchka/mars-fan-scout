# Box proposal comparator, 2026-09-28

The [RF-DETR Small box model](https://app.roboflow.com/matt-abrams/mars-fan-box-proposals/1) was trained on boxes converted from the original weak segmentation masks (86 images; 68 train, 9 validation, 9 test). These are not corrected labels. Its Roboflow validation mAP@50 was 39.5% against those weak boxes; the segmentation model's mask mAP is a different task and cannot be compared directly.

Both models were queried at a 20% confidence floor on the same bundled image, six frozen crops from ESP_082241_0950, and three rocky crops from ESP_092344_0970. The same deduplication, substantial-region floor, and three-card selector were applied. The 16 marked clear-deposit centers in the six crops are non-expert visual marks; a proposal counts nearby when its box center is within 75 pixels. This is a proposal check, not fan classification or outline-quality ground truth.

| Measure | Current segmentation | Box comparator |
| --- | ---: | ---: |
| Marked centers near any proposal | 16/16 | 16/16 |
| Marked centers near a featured proposal | 14/16 | 12/16 |
| Raw proposals on the three rocky crops | 71, 75, 24 | 53, 77, 26 |
| Tiny featured region on the bundled image | No | No |

The box model found the same three prominent dark deposits on the bundled image. On the rocky crops it still put boxes on ridges and shadows; see `box-predictions/holdout-*.featured.jpg` beside `holdout/holdout-*.featured.jpg`. The trained box model therefore does not clear the promotion gate: it loses two featured marked centers and does not solve the hard-negative problem. Keep the current segmentation model on the live page. `box-comparator-report.json` and `box-predictions/*.json` preserve the raw responses and selected regions. A better detector requires corrected complete-chip labels and observation-level holdout evaluation.
