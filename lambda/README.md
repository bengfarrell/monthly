# AWS media API

The Lambda preserves the existing media HTTP API payload-2.0 routes and adds posting:

| Route | Purpose |
| --- | --- |
| `GET /media` | Query `bucket`, optional `month` (YYYY-MM) and pagination `cursor` |
| `GET /posts` | Authenticated raw monthly `posts.json` and ETag; query `bucket`, `month` |
| `POST /posts/edit` | Replace existing monthly JSON; body `bucket`, `month`, loaded `etag`, edited JSON text `content` |
| `POST /uploads` | JSON `bucket`, filename `name`, canonical `type`, `size`, `month`; thumbnails add original filename `thumbnailFor` and `dimensions` |
| `POST /sign` | JSON `bucket`, grant `key` / `ticket`, HTTP `method`, optional multipart fields |
| `POST /posts` | JSON `bucket`, current UTC `month`, UUID `id`, `text`, `tags`, `media` entries `{ key, size, thumbnails?: { "600x300": { key, size, time? } } }`; legacy `poster` is accepted |

Every route checks Basic authorization over HTTPS. Use **NONE** for API Gateway
authorization; do not add a JWT authorizer. Check the spelling of all routes,
their Lambda integrations and invoke permissions. Renaming a route can leave a
Lambda resource-policy permission pointing to the old path.
Existing deployments must add `POST /posts` with its Lambda integration and
invoke permission as well as uploading the new Lambda ZIP.
For the Browse JSON editor, also add **`GET /posts`** and **`POST /posts/edit`**
with their Lambda integrations and invoke permissions. Existing GET/POST CORS
and the execution role's posts.json read/write permissions cover these routes.
Thumbnails use the existing upload/sign routes; associations are stored only
in published posts. No thumbnail endpoint or thumbnail-index permissions are
required. Older deployments can remove the retired `POST /thumbnails` route
and its invoke permission; retained `thumbnails.json` objects are ignored.

Posts may contain text, media, or both. Text is limited to 4000 characters;
tags to 32 entries of 64 characters each; media to 20 supported assets in the
current month. The frontend merges hashtags into the separate tags array;
the API accepts tags as supplied and derives public media URLs from bucket
configuration. The API does not move or upload media as part of saving a post.
It reads `<prefix>YYYY/MM/posts.json`, appends to its JSON array, and conditionally
writes it back. Only `NoSuchKey` creates a new file; permission/read/JSON errors
never overwrite an existing file. ETag conflicts retry up to five times, then
return 409. Reposting the identical UUID/payload returns the saved post without
appending again; reusing an ID with different content returns 409. Existing media
listings omit `posts.json`.

The browser checks video decoding and generates JPEG thumbnails without
transcoding originals. Images over 1 MiB default to a 960-pixel longest edge;
users can resize or opt out. `thumbnailFor` plus `dimensions` requests a JPEG
grant for `<sanitized-original-media-key>.thumb-<dimensions>.jpg`.
Thumbnails must be at most 1 MiB, for an image or video, with positive dimensions
up to 8192 pixels per side. Maps accept at most 20 files; optional nonnegative
`time` applies only to video frames. The API derives canonical public URLs.
Ordinary uploads cannot use reserved generated filenames. Legacy `posterFor`
grants and `poster` metadata remain accepted. The API cannot independently
verify browser decoding or guarantee compatibility across viewers.
Deploy the updated Lambda before the updated frontend.

After originals and thumbnails finish uploading, completion requires no further
API call. Publishing carries the dimension-keyed thumbnail map in the existing
`POST /posts` payload and stores it in `posts.json`.

`GET /media` lists all supported media objects as independent files, including
generated thumbnail JPEGs and legacy `.poster.jpg` files, with normal pagination.
It does not read metadata indexes or search for companion files. Non-media JSON
files are omitted. The feed uses thumbnail associations from each post only.
Removing or editing a post's thumbnail references does not delete S3 objects.

## Editing monthly JSON

`GET /posts` reads the selected month's file directly from S3 and returns
`{ bucket, key, url, etag, content }`. It deliberately returns raw text even if
the JSON is corrupt, so the editor can repair it. Missing files return 404;
permission and storage failures are not treated as empty files. Files larger
than 512 KiB (UTF-8) are rejected by the editor endpoints.

`POST /posts/edit` validates syntax and the entire posts array, including unique
UUIDs, post limits, canonical timestamps in the selected month, same-month media
keys, configured CDN URLs, dimension-keyed thumbnails and legacy video posters. Any valid month can be
edited, not just the current month. It writes the submitted text unchanged to
the configured month's posts.json with `Content-Type: application/json` and
`Cache-Control: no-cache`. Extra fields and formatting are preserved by this
replacement; the editor validates the known post schema.
Subsequent post appends retain those extra fields in existing entries.

The loaded ETag is required and used as `If-Match`. A changed or removed file
returns 409 and is never automatically retried or unconditionally overwritten.
The editor cannot create a missing file. Saving an empty array removes posts,
not their uploaded media. Existing posting continues to append with its own
conditional writes, so publishing and editing cannot silently lose updates.

## Configuration and deployment

Use Node.js 22.x, handler `handler.handler`, memory 256 MiB, and a timeout of
20 seconds. Create or retain the basic execution-role logging permissions.
Build with `npm run build:lambda`, then upload `dist/monthly-lambda.zip`.
The handler source is `lambda/handler.ts`; the build checks TypeScript and
bundles JavaScript as `handler.mjs` in the ZIP. No TypeScript runtime is needed
on Lambda.
Code upload does not change environment variables.

For local development, `npm run dev` invokes this same handler through Vite's
local adapter with mock S3 clients. See the [local development guide](../README.md#run-locally).
The mock server, fixture data, and local TLS certificate are not included in
the Lambda ZIP.

Set these variables directly on Lambda, not the frontend:

| Variable | Value |
| --- | --- |
| `MEDIA_USERNAME` | 1-128 characters; no colon/newline |
| `MEDIA_PASSWORD` | Strong random password, 16-1024 characters; no newline |
| `MEDIA_BUCKETS` | JSON mapping actual bucket names to their settings |

```json
{
  "site-one-media": {
    "prefix": "wp-content/uploads/",
    "publicBaseUrl": "https://your-distribution.cloudfront.net",
    "region": "us-east-1"
  },
  "site-two-media": {
    "prefix": "media/",
    "publicBaseUrl": "https://another-distribution.cloudfront.net",
    "region": "us-west-2"
  }
}
```

Every prefix ends in `/`; every public base URL is an HTTPS origin without a
path, query or credentials. CloudFront must map to the bucket root, with an
empty Origin Path. Regions are explicit and can differ from Lambda's region.
Keep the entire Lambda environment within its 4 KiB limit.
Unknown buckets and malformed configuration fail closed.

Grants expire after 24 hours and bind bucket, prefix, region, filename, size,
type and user. Signed S3 URLs expire after 5 minutes. Rotating credentials
invalidates outstanding grants, but already signed S3 URLs last until expiry.
The legacy grant-signing context is retained for compatibility with the blog.

## Execution-role permissions

Add these statements without replacing logging or other existing permissions.
Repeat with the appropriate bucket and prefix for each allowlisted destination:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::site-one-media",
      "Condition": {
        "StringLike": { "s3:prefix": "wp-content/uploads/*" }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::site-one-media/wp-content/uploads/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::site-one-media/wp-content/uploads/*/posts.json"
    }
  ]
}
```

No object-delete or ACL permission is needed. The `s3:prefix` condition applies
only to listing, not writing. An inline policy appearing under the execution
role is already effective; managed policies must be attached separately.
Customer-managed KMS encryption additionally needs `kms:GenerateDataKey` and
`kms:Decrypt`, plus authorization in the key policy.

## CORS and cleanup

API Gateway HTTP API CORS: list exact frontend origins, GET/POST/OPTIONS,
Authorization/Content-Type, and leave Allow-Credentials disabled. Basic
authorization headers do not require cookie credentials.
Use the `$default` stage with automatic deployment.

Merge this rule into each S3 bucket's CORS array; do not replace unrelated rules:

```json
[
  {
    "AllowedOrigins": ["https://your-site.example", "http://localhost:8080"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

Add a lifecycle rule scoped to the configured prefix, aborting incomplete
multipart uploads after one day. Do not enable completed-object expiration.
Use API throttling appropriate for a personal app; it is not a complete
brute-force defense. Do not log credentials or request Authorization headers.

## CloudFront read access

Uploads do not set public ACLs. Use the existing CloudFront distribution and
an S3 Origin Access Control with **Always sign requests**. First merge a
distribution-scoped read statement into the bucket policy:

```json
{
  "Sid": "AllowCloudFrontMediaRead",
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::site-one-media/wp-content/uploads/*",
  "Condition": {
    "StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::YOUR_ACCOUNT:distribution/YOUR_DISTRIBUTION"
    }
  }
}
```

Then attach that OAC to the existing S3 origin. Keep the existing domain and
empty Origin Path. Do not change Object Ownership, Block Public Access or
existing object ACLs during this additive rollout. Preserve all existing
policy statements and permissions used by other prefixes or applications.
Check both old and new asset URLs after deployment. Invalidate an individual
path if CloudFront cached a previous 403 or an overwritten asset.

## Public post JSON and caching

The public feed reads JSON through the configured CDN, not through the
authenticated API. Its base URL includes the prefix, for example
`https://your-distribution.cloudfront.net/wp-content/uploads/`.
No Eleventy rebuild is needed when a post is published.

For cross-origin feeds, allow unauthenticated GET/HEAD from the site's origin
using a CloudFront response headers policy, or forward `Origin` to S3 and
include it in the cache key with the bucket CORS rule above. Keep these read
rules separate from the API's authenticated CORS settings.

Post JSON is written with `Content-Type: application/json` and
`Cache-Control: no-cache`. Configure the CloudFront behavior covering
`<prefix>*/posts.json` with **minimum TTL 0** so revalidation reaches S3.
Set error caching minimum TTL to 0 for 403/404 responses (S3 origins can still
cache errors briefly). Otherwise a previously missing month can stay missing
after its first post. Invalidate existing cached JSON/errors when changing the
policy. Retain the existing long-lived cache behavior for media.

S3 with OAC can return 403 for missing public objects rather than 404. The feed
keeps available months and logs failed monthly reads with `console.warn`,
without displaying request failures in the UI. Only 404 is treated as an
absent month; other failures remain in the model's `state.errors` for
diagnostics. Browsers can still show their own HTTP/network error entries,
which frontend JavaScript cannot suppress. Credentials are never required
for feed reads.
