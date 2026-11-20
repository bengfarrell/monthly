import "../src/index.js";
import { API_URL, BUCKET } from "./config.js";

const manager = document.querySelector("monthly-media")!;
manager.apiUrl = API_URL;
manager.bucket = BUCKET;
if (process.env.MONTHLY_DEV_MODE === "mock") {
  const notice = document.createElement("wa-callout");
  notice.variant = "neutral";
  notice.className = "monthly-demo-notice";
  notice.textContent = "Local mock API: use the demo credentials in README. Uploads are simulated and reset when the server restarts.";
  manager.before(notice);
  const feed = document.createElement("monthly-feed");
  feed.baseUrl = `${location.origin}/mock-assets/`;
  manager.after(feed);
  manager.addEventListener("monthly-posted", () => { void feed.observed?.load(); });
  manager.addEventListener("monthly-posts-saved", () => { void feed.observed?.load(); });
}
