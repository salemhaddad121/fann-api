# S3 bucket CORS setup (media uploads)

## Why this is needed

Media uploads work like this: the browser asks our API for a presigned S3
URL (`POST /media/presign`), then uploads the file **directly to S3** from
the browser via a `PUT` request to that URL (see `uploadMedia()` in the
frontend's `lib/media-api.ts`). That `PUT` goes straight from
`localhost:3000` (or wherever the frontend is deployed) to
`*.s3.amazonaws.com` — a different origin — so the browser enforces CORS
on it, same as it would for any other cross-origin request.

This is **not something fixable in the NestJS API code**. The API only
*generates* the presigned URL; it's never in the request path for the
actual file upload. The fix has to be applied to the S3 bucket itself, in
the AWS console (or via the AWS CLI/Terraform, if this project ever
adopts infrastructure-as-code).

Until this is set, uploads will fail in the browser with a generic
network error — the frontend now specifically detects this pattern and
points people at this doc (see `MediaManager.tsx`).

## The policy to add

In the AWS S3 console: open the bucket → **Permissions** tab → **Cross-origin
resource sharing (CORS)** section → paste this in (replacing the second
origin with your actual production frontend URL once you have one):

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "https://your-production-frontend-domain.com"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3000
  }
]
```

**Notes on each field:**

- `AllowedOrigins` — list every origin the upload will ever be initiated
  from. Add both your local dev origin and your real production domain
  once you have one (you can list as many as you need — one per
  environment). Wildcards like `https://*.vercel.app` are allowed if
  you're on a platform with preview-deploy subdomains.
- `AllowedMethods` — only `PUT` is needed; that's the only method the
  upload flow uses against S3 directly. You don't need to list `OPTIONS` —
  S3 handles the preflight automatically based on this same rule.
- `AllowedHeaders` — `Content-Type` is the only custom header the upload
  request sets (see `uploadMedia()`). If a future change to the upload
  flow adds more headers (e.g. `x-amz-*` metadata headers), they'd need
  to be added here too, or the browser will block the request the same
  way.
- `MaxAgeSeconds` — how long the browser caches the preflight response;
  3000 is the value AWS uses in its own docs and examples, no need to
  tune this.

## How to verify it worked

After saving the CORS policy, try uploading a photo or video from the
actual deployed frontend (not just locally, if this was a
production-only gap). If it still fails with the same generic error,
double check:

- The origin in the browser's address bar matches an entry in
  `AllowedOrigins` **exactly** (scheme + host + port; no trailing slash).
- You saved the change in the correct bucket (if there's more than one,
  e.g. separate staging/production buckets).
- It can take a minute or two for the change to propagate.
