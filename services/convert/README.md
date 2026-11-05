# Conversion server

Used only by the web app (and as a desktop fallback) for the two jobs that can't run in the
browser yet: **Office → PDF** (Gotenberg / LibreOffice) and **PDF → DOCX** (native MuPDF).
Uploads are always opt-in, and files are deleted right after conversion.

Not set up yet. See [PHASES.md](../../PHASES.md), Phase 4.

```bash
cp .env.example .env   # add your Cloudflare Tunnel token
```

```bash
docker compose up -d
```
