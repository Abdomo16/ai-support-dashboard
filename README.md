# Autexa AI Support Dashboard

A real browser-native, bilingual SaaS dashboard for AI support operations. Development takes place on `codex/ai-support-dashboard`; `main` remains unchanged.

## Run locally

This project uses the supplied workspace Node runtime and reads its public Supabase settings from `.env`. From the project root, run:

```powershell
& 'C:\Users\abdoa\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' server.mjs
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) in Chrome.

## Supabase

The dashboard reads upcoming bookings from the `appointments` table through `src/services/appointments.js`. The local server reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `.env` and exposes only the public browser configuration at runtime. The `.env` file is excluded from Git. `src/config/supabase.example.js` is the safe template to share.

If bookings show preview data, the Supabase Row Level Security policy is correctly blocking anonymous access. Add Supabase Auth and sign in as an organization member before requesting production data.

See `docs/architecture.md` for the directory map and conventions.
