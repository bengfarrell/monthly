import { httpsUrl } from "../shared/media-types.js";

export async function copyMediaUrl(url: string, clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard) {
  httpsUrl(url);
  if (!clipboard) throw new Error("Clipboard access is unavailable. Copy the URL manually.");
  try { await clipboard.writeText(url); }
  catch (cause) { throw new Error("Clipboard access failed. Copy the selected URL manually.", { cause }); }
}
