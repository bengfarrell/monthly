# AWS media API

The extracted Lambda preserves the existing three HTTP API payload-2.0 routes:

| Route | Purpose |
| --- | --- |
| `GET /media` | Query `bucket`, optional `month` (YYYY-MM) and pagination `cursor` |
| `POST /uploads` | JSON `bucket`, filename `name`, canonical `type`, `size`, `month` |
| `POST /sign` | JSON `bucket`, grant `key` / `ticket`, HTTP `method`, optional multipart fields |

Every route checks Basic authorization over HTTPS. Use **NONE** for API Gateway
authorization; do not add a JWT authorizer. Check the spelling of all routes,
their Lambda integrations and invoke permissions. Renaming a route can leave a
Lambda resource-policy permission pointing to the old path.

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
