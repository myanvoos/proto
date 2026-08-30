Inspects media (image/audio/video) via a capable model → compact text analysis. Prefer over `read` for media understanding: images (OCR, UI debugging, scenes), audio (transcription, speakers, music), video (scenes, actions, on-screen text).

`question`: state the target, constraints ("quote visible text verbatim", "only confirmed findings"), and output format (bullets/table/JSON/short answer); ground in observable evidence; request uncertainty for unclear details.

Model lacks the input modality → configure a capable model role before retrying.
