# Conversion server

Used only by the web app (and as a desktop fallback) for the two jobs that can't run in the
browser yet: **Office → PDF** (Gotenberg / LibreOffice) and **PDF → DOCX** (native MuPDF).
Planned guarantees (Phase 4): uploads will always be opt-in, files will be deleted right
after conversion, and the API will sit behind authentication (Cloudflare Access or a token
check) so it can't be used by anyone who finds the hostname.

Not set up yet. See [PHASES.md](../../PHASES.md), Phase 4.

```bash
cp .env.example .env   # add your Cloudflare Tunnel token
```

```bash
docker compose up -d
```
