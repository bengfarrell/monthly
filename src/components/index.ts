import { MonthlyMedia } from "./media.js";
import { MonthlyLibrary } from "./library.js";
import { MonthlyUpload } from "./upload.js";
import { MonthlyAsset } from "./asset.js";
import { MonthlyPost } from "./post.js";
import { MonthlyFeed } from "./feed.js";
import { MonthlyPostsEditor } from "./posts-editor.js";

export { MonthlyMedia, MonthlyLibrary, MonthlyUpload, MonthlyAsset, MonthlyPost, MonthlyFeed, MonthlyPostsEditor };

export function defineMonthlyElements(registry = globalThis.customElements) {
  if (!registry) return;
  const elements: [string, CustomElementConstructor][] = [
    ["monthly-media", MonthlyMedia], ["monthly-library", MonthlyLibrary],
    ["monthly-upload", MonthlyUpload], ["monthly-asset", MonthlyAsset],
    ["monthly-post", MonthlyPost], ["monthly-feed", MonthlyFeed],
    ["monthly-posts-editor", MonthlyPostsEditor],
  ];
  for (const [name, element] of elements) {
    if (!registry.get(name)) registry.define(name, element);
  }
}

defineMonthlyElements();

declare global {
  interface HTMLElementTagNameMap {
    "monthly-media": MonthlyMedia;
    "monthly-library": MonthlyLibrary;
    "monthly-upload": MonthlyUpload;
    "monthly-asset": MonthlyAsset;
    "monthly-post": MonthlyPost;
    "monthly-feed": MonthlyFeed;
    "monthly-posts-editor": MonthlyPostsEditor;
  }
}
