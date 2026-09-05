Inspects media (image/audio/video) via a capable model → compact text analysis.

`question`: state the target, constraints ("quote visible text verbatim", "only confirmed findings"), and output format (bullets/table/JSON/short answer); ground in observable evidence; request uncertainty for unclear details.

Active model reads images natively → result carries the image itself; analyze it in-context.
Model lacks the input modality → configure a capable model role before retrying.
