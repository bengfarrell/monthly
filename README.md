# Monthly

Small-scale media management for static sites, with a shared AWS Lambda,
framework-independent TypeScript models, and lightweight Lit Web Components.
Media management is implemented in this first pass. Microblog posting and a
public month-organized feed are future features, not placeholder APIs.

## Run locally

Use Node.js 22.12 or newer (required by Vite):

```sh
npm install
npm run dev
```

Open `https://localhost:8080` and accept the local self-signed certificate
warning. Sign in with **`demo` / `monthly-local-demo`**. No AWS credentials,
deployed API, or env file is needed for local mock development.

Vite runs the same `createHandler` exported by `lambda/handler.ts`, through a
local HTTP-to-Lambda adapter. Only S3 listing and signing/storage are replaced
with in-memory implementations. Authentication, validation, grants, routes,
filename sanitization, month filtering, and pagination use the real handler.
Local HTTPS preserves the application's normal HTTPS-only API/upload checks.
Do not expose this development server to the internet.

`dev/assets.json` contains **351 online image assets across January 2025 through
December 2026**, with **0-30 assets per month**, including empty and full months.
The local asset URLs redirect to the JSON's public image URLs; images require
internet access, but AWS is never contacted. Edit the JSON to change the
library; the dev server restarts when it changes. `npm run fixtures:generate`
regenerates two calendar years (the previous and current year).

Single and multipart uploads, progress, cancellation, and replacement of
matching filenames work against mock S3 endpoints. Uploaded bytes are discarded;
successful uploads appear in the library with stock image/audio/video previews.
Changes last until the dev server restarts; the JSON is never overwritten by
uploads. Override the local-only login using `MONTHLY_DEV_USERNAME` and
`MONTHLY_DEV_PASSWORD` in `.env.local` if needed (password: 16-1024 characters).

Vite serves TypeScript directly, hot-updates CSS,
and reloads the page automatically for TypeScript and HTML changes. Lit
component changes use full-page reloads, so in-memory login and upload state
are not preserved. Avoid editing source during an upload.
Source maps and a browser error overlay are available in development.

### Connect to the real AWS API

```sh
cp .env.example .env.local
# Set MONTHLY_API_URL and MONTHLY_BUCKET in .env.local.
npm run dev:aws
```

This explicit opt-in serves the frontend at `http://localhost:8080` and connects
to the configured HTTPS API and real bucket. No mocks are installed in this mode.
Configure `MONTHLY_API_URL` (the HTTPS API Gateway origin) and `MONTHLY_BUCKET`.
If `.env.local` already exists, edit it rather than replacing it with the
example. Shell environment variables override the file. Restart the dev
command after changing these values.

Only these two public values are exposed to the demo (and embedded in
`dist/config.js` by the production build);
the reusable library and standalone `dist/monthly.js` remain unconfigured.
Plain `npm run dev` ignores these AWS connection values and always uses mocks.
An env file keeps deployment-specific values out of source control, but does
not hide values used by the browser. Never add usernames, passwords, AWS keys,
or other secrets to the frontend configuration.

CloudFront endpoints are already backend configuration: each bucket's
`publicBaseUrl` lives in Lambda's `MEDIA_BUCKETS` environment variable, not in
frontend source. See [the AWS setup guide](lambda/README.md). Local env files
are not uploaded to Lambda and do not update its environment variables.

For real AWS connections, API and S3 CORS must allow your
frontend origin, including localhost when developing. The frontend may run
on local HTTP, but API calls always use HTTPS.

## Embed in a site

Build the assets with `npm run build`, copy **only** `dist/monthly.js` and
`dist/monthly.css` into the consumer site's public assets, then add:

```html
<link rel="stylesheet" href="/assets/monthly.css">
<script type="module" src="/assets/monthly.js"></script>
<monthly-media
  api-url="https://your-api.execute-api.us-east-1.amazonaws.com"
  bucket="your-site-bucket">
</monthly-media>
```

The attributes are public configuration, not credentials. Another site can
use the same API with its own bucket. No Eleventy dependency or build-time
environment variables are required.

For package consumers using a bundler:

```js
import "@bengfarrell/monthly/components";
import "@bengfarrell/monthly/styles.css";
```

The source, Lambda, tooling, and tests are written in strict TypeScript.
`npm run build` checks the whole project, emits JavaScript modules and `.d.ts`
declarations in `dist/modules`, and bundles the standalone browser assets.
Package exports include types for the core models, state snapshots, options,
and custom element properties. JavaScript consumers need no TypeScript tooling.
Use `npm run typecheck` to check types without generating files, or run
`npm run typecheck:watch` in a second terminal for continuous type checking.
Vite's error overlay reports compilation errors, not TypeScript type errors.
Local scripts and tests run with `tsx`. Production package and Lambda builds
still use esbuild; Vite is the frontend development server.

The package is not yet published. `npm pack` creates a local release tarball
that consumers can install; use versioned releases rather than copying source
or depending on a moving Git branch.

For Eleventy, copy the built assets with passthrough copy and place the custom
element in a `/media/` template. Its layout should remain private: `noindex`,
`no-referrer`, no analytics, and exclusion from Pagefind. The consumer owns its
page shell, branding, navigation, deployment, and configuration.

## Independent logic

`@bengfarrell/monthly/core` does not import Lit, HTML, CSS, or register elements.
It can back another UI framework, custom DOM code, or application logic.
The upload adapter uses headless Uppy Core/AWS-S3, not Uppy Dashboard.

```js
import { MediaController } from "@bengfarrell/monthly/core";

const media = new MediaController({
  apiUrl: "https://your-api.execute-api.us-east-1.amazonaws.com",
  bucket: "your-site-bucket",
});
const unsubscribe = media.subscribe(state => renderYourToolbar(state));
const stopLibrary = media.library.subscribe(state => renderYourLibrary(state));

// Obtain these values from your own login form, never source code.
await media.signIn(username, password);
await media.library.load("2026-11");
await media.library.more();
media.uploader.addFiles(fileInput.files);
await media.uploader.upload();

// When the consumer is finished:
unsubscribe();
stopLibrary();
media.destroy();
```

| Export | Responsibility |
| --- | --- |
| `MediaAuth` | In-memory Basic authorization, input validation, session revision |
| `MediaApi` | HTTPS requests, bucket binding, response validation and explicit errors |
| `MediaLibrary` | Month filtering, pagination, loading state and stale-request cancellation |
| `MediaUploader` | File validation, queue/progress, signed single/multipart uploads and cancellation |
| `MediaController` | Compose the models, sign-in/out, tab and upload-session state |
| `copyMediaUrl` | Clipboard operation independent of the view |
| Shared helpers | Media types, size formatting, month and URL validation |

Stores expose `.state` and `.subscribe(listener)`, returning an unsubscribe
function. Subscribers receive the initial snapshot immediately.
Model errors are exposed in state and shown by the views; API operations reject
with explicit errors. Superseded library responses cannot overwrite newer
filters or restore private data after logout.

`MediaUploader` uses browser File/Blob APIs. Inject `fetch` into `MediaApi` and
`uppyFactory` into `MediaUploader` for testing or other integrations.
Destroy owned controllers when removing a manager. Do not share an
authenticated controller across sites or unrelated users.

## Thin views and styling

The views use [Web Awesome](https://webawesome.com/)'s free buttons, cards,
badges, callouts, and progress bars, plus its default theme's colors, spacing,
type scale, and radii. Components are imported individually from npm and
bundled locally; no CDN loader, remote fonts, icon requests, or Pro license is
required. The headless core has no Web Awesome dependency.

Monthly's own components still use **light DOM intentionally**. Native
credential inputs, month pickers, file inputs, and accessible keyboard-operated
tabs retain their browser behavior. Web Awesome controls have their own shadow
DOM; customize them using design tokens and CSS parts. Native credential inputs
retain standard form names, validation, password-manager autocomplete, and
Enter-to-submit behavior.

Styles remain opt-in for component-only consumers. `styles.css` includes Web
Awesome's default theme (including global `--wa-*` tokens and default root
font/color), but not its global native-element reset. Monthly-specific layout
rules use `monthly-` names. Load consumer overrides after the default stylesheet.

```css
monthly-media {
  --monthly-button-background: #222;
  --monthly-button-hover: #444;
  --monthly-button-color: white;
  --monthly-border: #aaa;
  --monthly-radius: 0;
  --monthly-gap: 1.25rem;
  --monthly-preview-height: 180px;
}
monthly-asset .monthly-title { font-weight: bold; }
monthly-media .monthly-button::part(button) { font-weight: 600; }
monthly-media { --wa-color-focus: rebeccapurple; }
```

Other hooks include `--monthly-max-width`, `--monthly-error`, and
`--monthly-preview-background`. The views handle rendering, accessibility,
DOM input and focus; API, auth, upload, filter and clipboard behavior stays in
the core modules.

The existing `--monthly-button-*`, border, radius, gap, and preview hooks remain
supported, including for Web Awesome buttons. For broader light/dark theme
customization, use Web Awesome's `--wa-*` tokens and `wa-dark`/`wa-light` classes
on the document or a surrounding element.

| Element | Input |
| --- | --- |
| `<monthly-media>` | `api-url` / `bucket` attributes, or a `.controller` property |
| `<monthly-library>` | `.model` property containing a `MediaLibrary` |
| `<monthly-upload>` | `.model` property containing a `MediaUploader` |
| `<monthly-asset>` | `.item` property (`key`, `url`, `size`), optional `.preview = false` |

Use `<monthly-media>` for the complete manager or compose the smaller views.
An externally supplied controller remains owned by its caller; unmounting the
element does not destroy it. Reconfiguration clears the element's own session.
Credential form names and standard autocomplete tokens support password
managers; the app does not persist credentials in storage or cookies.

## Preserved behavior

- Browse and Upload tabs, with auth on the right and keyboard navigation.
- Month selection/clearing refreshes automatically; old requests are cancelled.
- Three-line filename titles, previews, size, public URL and inline copy icon.
- Images, video and audio, up to 2 GiB each and 20 queued files.
- Files over 100 MiB use 10 MiB multipart chunks, direct from browser to S3.
- `<prefix>YYYY/MM/<sanitized-filename>` keys, with no generated filename ID.
- Matching sanitized names in the same month replace the same S3 object.
  Invalidate that CloudFront path if an immediate cache refresh is needed.
- Uploads continue when changing tabs. Completed files are removed from the
  queue when adding more, but their uploaded URLs remain until logout.
- Errors remain visible. Empty-library and upload status messages remain
  visible; normal successful library announcements are screen-reader-only.
- No transcoding, thumbnails, public object ACLs or persisted/reload-resumable
  login/upload sessions.

## Backend

The ported handler remains compatible with the deployed API and existing upload
grants. Its routes and Lambda environment variables have not changed.

```sh
npm run build:lambda
```

Upload `dist/monthly-lambda.zip` through the Lambda console, with Node.js 22.x
and handler **`handler.handler`**. The ZIP bundles the SDK and shared definitions.
It is not produced by frontend builds and is not included in the npm package.
See [the AWS setup guide](lambda/README.md). No AWS resources are automatically
created or updated by these commands.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run build:lambda
npx playwright install chromium
npm run test:browser
```

With locally installed Chrome, use
`MONTHLY_BROWSER_CHANNEL=chrome npm run test:browser` instead.
Browser integration checks mock API/S3 and exercise the actual Lit views,
clipboard, login, image/audio uploads, a 101 MiB multipart upload, errors,
tab preservation, and consumer CSS overrides without contacting real AWS.
