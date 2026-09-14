Inspects media (image/audio/video) via a capable model → compact text analysis. Prefer audio/video; for images, use when a targeted text answer suffices (vision models get the image inline either way).

`question`: state the target, constraints ("quote visible text verbatim", "only confirmed findings"), and output format (bullets/table/JSON/short answer); ground in observable evidence; request uncertainty for unclear details.

Vision-capable models receive images inline either way; ask a targeted question when text is enough.
Model lacks the input modality → configure a capable model role before retrying.
