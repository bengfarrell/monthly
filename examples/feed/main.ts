import "../../src/index.js";

const feed = document.querySelector("monthly-feed")!;
feed.baseUrl = process.env.MONTHLY_FEED_URL;
