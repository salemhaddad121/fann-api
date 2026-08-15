# Cloudflare console steps

Two outstanding jobs need the Cloudflare dashboard. Neither can be done from
the app: its R2 API token is scoped to reading and writing objects, so bucket
settings and DNS both return `AccessDenied`.

Read the second one before doing it. It is not safe as currently specified.

---

## 1. Allow uploads from Vercel preview deployments

**Low risk. Do this whenever preview uploads are worth having.**

Uploads go straight from the browser to R2 via a presigned `PUT`, so the
browser enforces CORS on them and R2 has to name every origin that is
allowed to start one. Today those are `http://localhost:3000`,
`https://fann.guru` and `https://www.fann.guru` — production and local work,
every Vercel preview URL fails.

**R2 → `fann-media` → Settings → CORS Policy → Edit**, and add the one line:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "https://fann.guru",
      "https://www.fann.guru",
      "https://*.vercel.app"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Keep `ExposeHeaders: ["ETag"]` exactly as it is. `docs/s3-cors-setup.md`
explains why at length: without it the uploader hangs at 100% instead of
failing, and orphans the file in the bucket.

**How to check it worked.** Open a preview deployment, upload a photo, and
watch it complete. If it fails, compare the origin in the address bar against
the list character for character — scheme, host, no trailing slash. Note that
`https://*.vercel.app` matches one label only, so `foo.vercel.app` matches and
`foo.bar.vercel.app` does not.

**Do not** verify this with a hand-made `curl` preflight. An `OPTIONS`
response never echoes `Access-Control-Expose-Headers`, so `ETag` looks missing
when it is present — that misreading is where the old, wrong "R2 has no CORS
policy" note in `CLAUDE.md` came from.

---

## 2. Bind `cdn.fann.guru` — ⚠️ NOT safe as specified

**Stop. Doing this as written publishes every artist's passport scan.**

`CDN_BASE_URL` is set to `https://cdn.fann.guru` and the handoff lists the
custom-domain binding as a routine remaining task. It is not, because of a
detail that is invisible from the config:

**`fann-media` holds both public media and identity documents.**

| Prefix | Written by | Contents |
|---|---|---|
| `uploads/` | `MediaService` | Profile pictures, galleries — meant to be public |
| `identity/` | `IdentityDocumentsService` | Government ID scans and selfies |

Both services read the same `S3_BUCKET`. An R2 custom domain grants public
read to **the whole bucket** — it serves `https://<domain>/<object-key>` for
any key and has no way to scope access to a prefix. So the moment
`cdn.fann.guru` is bound, this becomes a live public URL:

```
https://cdn.fann.guru/identity/<user-id>/id_document-<uuid>.jpg
```

Object keys contain a random UUID, so they cannot be enumerated. That is not
an access control. URLs leak through browser history, referrer headers, proxy
and CDN logs, and anything anyone pastes into a chat — and the thing behind
this one is a photograph of someone's ID.

It also contradicts the design the code deliberately implements.
`identity-documents.service.ts` says so in a comment at the top: identity
documents are kept out of `MediaService` specifically so that they never
acquire a CDN URL, and the only intended way to see one is a five-minute
presigned `GET` issued to an admin. Binding the domain would undo that from
the outside, without touching a line of the code that enforces it.

### What to do instead

**Split the buckets before binding anything.** Identity documents move to
their own bucket that no custom domain is ever attached to:

1. Create a second R2 bucket, `fann-identity`, with no public access and no
   custom domain.
2. Add `S3_IDENTITY_BUCKET=fann-identity` and have
   `IdentityDocumentsService` read that instead of `S3_BUCKET`. It is one
   constructor line — the service already keeps its own `bucket` field.
3. Copy existing `identity/` objects across, then delete the originals from
   `fann-media`. Stored keys are relative, so no database change is needed.
4. Only then bind `cdn.fann.guru` to `fann-media`.

This is the version that matches what the code already believes is true, and
it keeps working if someone later deletes a firewall rule.

**The weaker alternative** is to bind the domain and add a Cloudflare WAF
rule blocking `/identity/*` on that hostname. It works, and it is one rule
away from not working — a bucket that is fundamentally public, kept private
by a filter. Reasonable as a stopgap if the CDN is urgent; not a place to
stop.

### Binding the domain, once the bucket is safe

**R2 → `fann-media` → Settings → Public access → Custom Domains → Connect
Domain**, enter `cdn.fann.guru`, and let Cloudflare create the CNAME — it can
do this automatically because `fann.guru` is already a zone on the same
account. Status goes from *Initializing* to *Active* in a few minutes.

**How to check it worked.** Fetch any known public object by URL:

```bash
curl -I https://cdn.fann.guru/uploads/<user-id>/<file>.jpg
```

`200` with an `image/*` content type means public media is live. Then, on the
same day, confirm the other half:

```bash
curl -I https://cdn.fann.guru/identity/<user-id>/<file>.jpg
```

That one **must not** return `200`. If it does, the split above has not been
done and identity documents are public — unbind the domain immediately.

---

## Not Cloudflare, but on the same list

- **`SUPPORT_INBOX_EMAIL` is unset in Vercel.** Tickets are always saved, so
  nothing is lost; the notification currently falls back to `EMAIL_FROM`
  (`noreply@fann.app`). Set it in Vercel → `fann-api` → Environment
  Variables, then redeploy — env changes do not reach a running deployment.
- **Rotating the Neon password** is Neon Console → Connect → Reset password,
  then update `DATABASE_URL` in Vercel and redeploy. Do the two back to back:
  the API errors in between. The Vercel variable is marked Sensitive, so it
  is write-only — read the value from Neon, not from Vercel.
