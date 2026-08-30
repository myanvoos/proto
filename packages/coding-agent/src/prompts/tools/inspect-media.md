Inspects media files (image, audio, or video) via a capable model; returns compact text analysis.

<instruction>
- Use for media understanding: images (OCR, UI/screenshot debugging, scene/object questions), audio (transcription checks, speakers, music, sound events), video (scenes, actions, on-screen text).
- `question` specific: inspection target; constraints (e.g. "quote visible text verbatim", "only report confirmed findings"); output format (bullets/table/JSON/short answer).
- Ground `question` in observable evidence; request uncertainty for unclear details.
- For media analysis, use over `read`.
</instruction>

<output>
- Model text-only analysis.
- Tool output: no media content blocks.
</output>

<critical>
- Configured model lacks the input modality (image/audio/video) → configure a capable model role before retrying.
</critical>
