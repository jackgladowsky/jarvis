# Telegram document ingestion

JARVIS accepts ordinary Telegram document attachments as untrusted reference material. A caption is treated as the owner's request; when no caption is present JARVIS is asked to review the attachment.

## Supported formats

- UTF-8 text, Markdown, logs, source code, and common config files
- CSV/TSV, JSON/JSONL, XML, and YAML
- PDFs with an extractable text layer

Office archives, compressed archives, encrypted PDFs, OCR, and image-only PDFs are not supported. Office extraction can be added later through the extractor dispatch without changing the Telegram transport.

## Limits and storage

Downloads are limited by both Telegram's declared size and the streamed response body. Documents are capped at 15 MiB, extracted text at 100,000 characters, and PDFs at 100 pages. Archive signatures, binary/NUL-containing text, invalid UTF-8, unsupported MIME/extension combinations, and PDF signature mismatches are rejected.

Accepted originals are stored with sanitized, collision-safe names beneath `~/.jarvis/data/telegram-documents/<chat-id>/`. Directories are private and files are created with mode `0600`. The exact enriched prompt—including the user's caption, metadata, bounded extracted text, and an explicit untrusted-content boundary—is persisted through the normal session transcript.

Attachment content is never treated as system or owner instructions. It can still contain misleading text, so JARVIS is explicitly told to use it only as reference material for the independent user request.
