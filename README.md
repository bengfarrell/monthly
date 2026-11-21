# Monthly

Small-scale media management for static sites, with a shared AWS Lambda,
framework-independent TypeScript models, and lightweight Lit Web Components.
Includes media management, microblog posting, and a public month-organized feed.

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

The **Post** tab publishes updates using the same handler and simulated uploads.
Monthly post JSON is held in memory locally and resets on restart. The demo
shows a public feed below the manager, refreshed automatically after posting.

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

Only these two public values are exposed to the manager demo (and embedded in
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

### View your deployed posts

Add your public CDN URL **including the media prefix** to your existing
`.env.local`:

```dotenv
MONTHLY_FEED_URL=https://your-distribution.cloudfront.net/wp-content/uploads/
```

Then run:

```sh
npm run dev:feed
```

Open `http://localhost:8080` for the standalone, read-only feed demo. It reads
real public monthly JSON from your CDN, without login, API Gateway calls, or
local mocks. API URL and bucket settings are not required for this command.
All demo modes use port 8080; stop the posting server before starting the feed
server. Vite fails if the port is occupied rather than switching to another port.
Reload the page after publishing to see new posts. Restart Vite after
changing the URL. If CDN CORS restricts origins, allow `http://localhost:8080`.
No changes to `.env.local` are made automatically.

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

## Microblog posts and public feed

Sign in to `<monthly-media>` and use **Post** to write a message, enter optional
comma-separated tags, and choose media. Publishing uploads the media using the
existing uploader, then saves the post. Text-only and media-only updates work.
Messages support up to 4000 characters, 32 tags of up to 64 characters each, and
20 media assets. Messages render as plain text, not HTML or Markdown.

Hashtags remain in the message and are also merged with explicit tags. Tags
are Unicode-normalized, lowercased, and deduplicated; hashtags support letters,
numbers, and underscores. Posting always uses the **current UTC month**, with
no month picker. The ordinary Upload tab retains its existing month picker.
Uploads keep the existing filenames, supported types, limits, and replacement
behavior, so reusing a filename can also change media referenced by an old post.

Videos are decoded locally before uploading. If the current browser cannot
decode a video or capture its poster, uploading is blocked; remove it or convert
it to a supported format first. This checks the uploader's browser, not every
viewer's codec support, and does not validate every frame of the video.
The original video is never transcoded. A default frame is selected near the
start; use the queued video's **Poster frame** slider to choose another.
The JPEG poster is scaled to at most 1280 pixels on its longest side and uploaded
alongside the original. It does not count toward the 20 assets or appear as a
separate attachment.

Images **over 1 MiB** default to creating a JPEG thumbnail with a **960-pixel
longest edge**. Smaller images can opt in. The queued image's controls allow
320-2048 pixels or disabling the thumbnail; resizing preserves aspect ratio and
never upscales. Transparent areas become white. Generated JPEGs use quality 0.82
and must fit within 1 MiB; choose a smaller size if capture exceeds that limit.
The original image is uploaded unchanged. A selected image thumbnail must decode
and capture successfully, or be explicitly disabled; disabling uses the original
in previews and does not prevent uploading an image the browser cannot decode.

Media entries use optional **`thumbnails`**, keyed by actual pixel dimensions,
with `{ key, url, size, time? }` file values. `time` is a video frame's position
in seconds. Maps accept up to 20 thumbnails in insertion order, although the
current upload controls create one per original. The feed uses
**only the first thumbnail**: as the image source or video's poster. Links still
point to originals. Old posts without thumbnails, including legacy `poster`
entries, remain supported.

Dimension-specific JPEGs use reserved `<media-key>.thumb-<width>x<height>.jpg`
filenames. Originals and thumbnails use the existing upload/sign endpoints.
Upload completion waits only for those files; no thumbnail index or association
API is involved. Publishing embeds the association in that post's `posts.json`
entry. Ordinary uploads do not persist associations.
The media library lists originals, generated thumbnails, and legacy posters
as independent media files, using each file itself for its preview. Non-media
metadata files such as `posts.json` and old `thumbnails.json` indexes are omitted.
Disabling a thumbnail omits it from the new post; obsolete files and existing
posts are not changed. No `POST /thumbnails` route or thumbnail-index read
permission is required. Deploy the updated Lambda for the plain media listing;
see the [AWS guide](lambda/README.md).

Each month stores a JSON array at `<prefix>YYYY/MM/posts.json`, beside its media:

```json
[
  {
    "id": "6e809217-28d0-41bd-b722-4fc7b552486a",
    "created": "2026-11-17T12:00:00.000Z",
    "text": "A morning walk #outside",
    "tags": ["outside"],
    "media": [
      {
        "key": "media/2026/11/walk.jpg",
        "url": "https://cdn.example.com/media/2026/11/walk.jpg",
        "size": 2345678,
        "thumbnails": {
          "960x540": {
            "key": "media/2026/11/walk.jpg.thumb-960x540.jpg",
            "url": "https://cdn.example.com/media/2026/11/walk.jpg.thumb-960x540.jpg",
            "size": 65432
          }
        }
      }
    ]
  }
]
```

The Lambda reads the monthly file (or creates it if absent), appends the post,
and saves it using conditional S3 writes. Conflicting writes are retried.
Post IDs make retries idempotent. A failed JSON save leaves uploaded assets in
place; **Retry post** retries the same post without another upload. While a save
is uncertain, the draft is locked to avoid changing that retry. **New post**
discards the local draft without deleting uploaded media or a possibly saved post.
A post that crosses a UTC month boundary must be restarted.

### Edit a month's posts JSON

On **Browse**, select a single month and choose **Edit posts.json**. The editor
loads that month's existing file directly from S3 through the authenticated API,
not a possibly cached CDN copy. Edit the JSON in place; syntax, post fields,
timestamps, unique IDs, media keys/URLs, thumbnail maps and legacy posters are validated as you
type and again on the server. Invalid JSON can be loaded for repair, but cannot
be saved. Files up to **512 KiB (UTF-8)** are supported.

**Save posts.json** replaces the whole file exactly as edited, preserving
formatting and additional fields. You can change, reorder or remove posts,
including in past months. Additional fields are retained when new posts are
appended too. Timestamps and media must still belong to that month,
and media URLs must match their object keys on the configured CDN. Saving `[]`
removes all posts from that month without deleting any uploaded media.
Missing files produce an explicit error; this editor does not create new ones.

Changes must be saved or explicitly discarded before switching months or
signing out. **Reload posts.json** fetches the latest version after discarding
local changes. An S3 ETag guards every save: if another editor or a new post
changes the file, saving reports a conflict and keeps your edits instead of
overwriting it. Copy your edits before discarding and reloading to reconcile
them. Network/storage errors also preserve the draft. As with other drafts,
reloading or closing the page loses unsaved edits.

The model is `controller.postsEditor`, or construct `PostsEditor(api, { month })`
from the core entrypoint. `<monthly-posts-editor .model=${editor}>` is a standalone
view; `<monthly-library>` accepts an `.editor` alongside its `.model`.
Successful saves emit a bubbling `monthly-posts-saved` event with
`{ month, file }` in `event.detail`; refresh a public feed in response. The local
demo does this automatically. Deploy the updated Lambda and add its two editor
routes before deploying the frontend; see the [AWS guide](lambda/README.md).

Place a separate **public**, login-free feed on any page, including an Eleventy
template, using the same script and stylesheet:

```html
<monthly-feed base-url="https://cdn.example.com/media/"></monthly-feed>
```

### Optional full-post viewer and deep links

The default feed remains grid-only: it does not change the page URL, add
expansion controls, or load linked historical months. Enable the full-post
viewer explicitly:

```html
<monthly-feed
  base-url="https://cdn.example.com/media/"
  post-viewer
  post-label="Memo"
  post-prefix="note-">
</monthly-feed>
```

`post-label` defaults to `Post` and controls the viewer and link labels.
`post-prefix` defaults to `post-` and controls the fragment/card IDs; it must
start with a letter and contain only letters, numbers, underscores or hyphens.
The consumer owns the page route. For a feed embedded at `/memos/`, the example
preserves URLs such as `/memos/?month=2025-03#note-UUID`. Use one URL-managing
feed per page.

Every card, including text-only posts, has a **View post** link (or **View memo**
with the example label). Images also open on click/tap; each attachment has a
keyboard-accessible **Expand** button. The native modal displays the full
plain-text message, UTC date, bordered tags and all attachments, with readable
text beside media on desktop and stacked on mobile. Images and per-asset
**Open original** links use original URLs, not thumbnails. Videos retain their
thumbnail/legacy posters and audio/video have native controls without autoplay.
Unselected players use `preload="none"`. Opening pauses inline players and
closing transfers available playback positions, stops/releases expanded
players, and restores focus without automatically resuming playback.

The grid still loads only its normal current three-month window. Older direct
links fetch **only the linked month's JSON separately**, without replacing or
extending the grid. Opening from the grid sets a shareable URL. Back closes the
viewer and Forward reopens it; Close, Escape and backdrop dismissal return to
the current grid. Closing a direct link removes the month and post fragment
without navigating away. Invalid, missing or failed links show explicit status
messages. Disabling the viewer or disconnecting the element cleans up players,
scroll locking, listeners and pending historical requests; injected models
remain caller-owned. No Lambda changes or new post JSON fields are needed.

Viewer structure and responsive behavior ship in `monthly.css`; customize the
light-DOM `.monthly-post-viewer*` classes and inherited variables:
`--monthly-viewer-background`, `--monthly-viewer-color`, `--monthly-viewer-border`,
`--monthly-viewer-muted`, `--monthly-viewer-link`, and `--monthly-viewer-focus`.
Existing `--monthly-border` and `--monthly-radius` also apply.

For links outside the feed, use the core helper
`postUrl(post, new URL("/memos/", location.href), "note-")`; it returns a new URL
with the month query and fragment, leaving its base URL unchanged.
`await feed.loadPost(id, month, signal?)` reads a single validated linked post
independently of grid state, reuses already loaded posts, returns `undefined`
when unavailable, and rejects on invalid input, request/JSON failures or
cancellation. `destroy()` cancels both grid and independent post requests.

### Grid layout and loading

The feed uses a responsive card grid: one column by default, two when its
container reaches 46rem, and a maximum of three at 70rem. Column counts follow
the component's available width, so embedded feeds also adapt to narrower layouts.
Each month with posts has a full-width month/year heading and its own grid,
with the newest month first. Posts from different months never share a row.

`base-url` includes your configured media prefix, not just the CDN origin.
The feed requests exactly the current UTC month and the preceding two calendar
months, including across year boundaries; it does not search older months to
replace missing ones. It skips 404s and sorts posts newest-first. Missing files
and other fetch or JSON failures are logged with `console.warn`, not displayed
in the feed UI. Non-404 failures remain available in the model's `state.errors`
for diagnostics. Browsers may still show their own HTTP/network error entries;
frontend JavaScript cannot suppress those.
Requests send no credentials. Cross-origin JSON reads need CORS on the CDN;
see the [AWS guide](lambda/README.md#public-post-json-and-caching).

Headless consumers can use `PostComposer` (with an authenticated `MediaApi`)
and `PostFeed({ baseUrl })` from the core entrypoint. Both expose observable
state. Call `feed.load()` to refresh and `destroy()` when finished. The manager
owns `controller.composer`; `<monthly-post .model=${composer}>` provides a
standalone composer view. `<monthly-feed>` also accepts a `.model` property.
The composer view emits a bubbling `monthly-posted` event with the saved post
in `event.detail`; consumers can refresh a feed in response. Externally supplied
models remain caller-owned.

## Independent logic

`@bengfarrell/monthly/core` does not import Lit, HTML, CSS, or register elements.
It can back another UI framework, custom DOM code, or application logic.
The upload adapter uses headless Uppy Core/AWS-S3, not Uppy Dashboard.
`MediaUploader.ready()` waits for video preparation and rejects undecodable
videos; `upload()` also performs this check automatically.
`selectPoster(fileId, seconds)` selects a new frame before uploading.
Video preparation requires browser DOM/media APIs; other upload types remain
usable without them. Custom browser UIs can read `QueuedFile.video` for poster
previews, duration, selection and preparation status.

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
| `PostComposer` | Current-month posts, hashtag extraction, upload-before-save and retry state |
| `PostFeed` | Public three-calendar-month JSON loading and newest-first ordering |
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
| `<monthly-post>` | `.model` property containing a `PostComposer` |
| `<monthly-feed>` | `base-url` attribute including the public media prefix, or `.model` |

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

The handler remains compatible with the existing media routes and upload
grants. Posting adds `POST /posts` and requires S3 read permission for the
monthly JSON files; Lambda environment variables have not changed.

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
