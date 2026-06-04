# Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Run `supabase/schema.sql`.
4. Copy `.env.example` to `.env`.
5. Fill in:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SESSION_SECRET`
   - `POS_USERS_JSON`
6. Generate password hashes:

```bash
npm run hash-password -- your-cashier-password
npm run hash-password -- your-admin-password
```

Paste those generated hashes into `POS_USERS_JSON` in `.env`.

7. Start the backend:

```bash
npm start
```

8. Open:

```text
http://127.0.0.1:3000
```

When Supabase env vars are present, the backend stores orders and closeouts in Supabase. Without them, it falls back to `data/db.json`.

Security note: keep `SUPABASE_SERVICE_ROLE_KEY` private. It belongs only in `.env` on the backend machine, never in `index.html`.

## Vercel Deployment

Add these environment variables in Vercel Project Settings:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SESSION_SECRET
POS_USERS_JSON
```

Generate password hashes locally:

```bash
npm run hash-password -- cashier-password
npm run hash-password -- admin-password
```

Then set `POS_USERS_JSON` in Vercel to one line like:

```json
[{"username":"cashier","name":"Cashier","role":"cashier","passwordHash":"paste-cashier-hash"},{"username":"admin","name":"Admin","role":"admin","passwordHash":"paste-admin-hash"}]
```

Use a long random value for `SESSION_SECRET`. Example format:

```text
SESSION_SECRET=make-this-long-random-and-private
```

After deployment, check:

```text
https://your-vercel-app.vercel.app/api/health
```

You want:

```json
{
  "storage": "supabase",
  "auth": {
    "configured": true
  },
  "supabase": {
    "ok": true
  }
}
```
