import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MEDIA_TYPES as TYPES, isRecord, mediaType, mediaUrl, MAX_FILE_SIZE, PART_SIZE, THUMBNAILS_FILE, isVideoPoster, isMediaThumbnail, posterKey, thumbnailKey, readThumbnails, validateFile, validateThumbnails, uploadFilename, type Thumbnails } from "../src/shared/media-types.js";
import { asError } from "../src/shared/errors.js";
import { POSTS_FILE, MAX_POSTS_FILE_BYTES, readPosts, validatePostInput, validatePostMediaKeys, validatePostsJson, validatePostsFileSize, validatePostsEtag, type Post } from "../src/shared/posts.js";
export { MAX_FILE_SIZE, PART_SIZE };
export { mediaUrl };

const GRANT_LIFETIME = 24 * 60 * 60;

export interface MediaEvent {
  routeKey?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}
export type UploadCommand = PutObjectCommand | CreateMultipartUploadCommand | UploadPartCommand |
  ListPartsCommand | CompleteMultipartUploadCommand | AbortMultipartUploadCommand;
export interface MediaS3Client {
  send(command: ListObjectsV2Command | GetObjectCommand | PutObjectCommand): Promise<
    Pick<ListObjectsV2CommandOutput, "Contents" | "IsTruncated" | "NextContinuationToken"> &
    { Body?: { transformToString(): Promise<string> }; ETag?: string }
  >;
}
export interface HandlerOptions {
  config: { username?: string; password?: string; buckets: unknown };
  clientForRegion?: (region: string) => MediaS3Client;
  sign?: (client: MediaS3Client, command: UploadCommand, options: { expiresIn: number; signableHeaders: Set<string> }) => Promise<string>;
  now?: () => Date;
  logger?: Pick<Console, "error">;
}
interface BucketSettings { bucket: string; prefix: string; region: string; publicBaseUrl: string }
interface Grant {
  bucket: string; prefix: string; region: string; key: string;
  size: number; type: string; sub: string; exp: number;
}

export const signUpload: NonNullable<HandlerOptions["sign"]> = (client, command, options) => {
  if (!(client instanceof S3Client)) throw new Error("Custom S3 clients require a signing function.");
  // The SDK presigner requires a concrete command rather than a union.
  if (command instanceof PutObjectCommand) return getSignedUrl(client, command, options);
  if (command instanceof CreateMultipartUploadCommand) return getSignedUrl(client, command, options);
  if (command instanceof UploadPartCommand) return getSignedUrl(client, command, options);
  if (command instanceof ListPartsCommand) return getSignedUrl(client, command, options);
  if (command instanceof CompleteMultipartUploadCommand) return getSignedUrl(client, command, options);
  return getSignedUrl(client, command, options);
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function reject(message: string): never { throw new HttpError(400, message); }

export function monthPrefix(month: unknown, prefix: string) {
  if (typeof month !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) reject("Month must use YYYY-MM.");
  return `${prefix}${month.replace("-", "/")}/`;
}
function json(statusCode: number, value: unknown) {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) };
}
export function requestBodyLimit(routeKey: string | undefined) {
  return routeKey === "POST /posts/edit" ? MAX_POSTS_FILE_BYTES * 6 + 8192 :
    routeKey === "POST /posts" ? 256 * 1024 : routeKey === "POST /thumbnails" ? 65536 : 8192;
}
function canonicalThumbnails(value: unknown, key: string, base: string): Thumbnails {
  validateThumbnails(value, key);
  return Object.fromEntries(Object.entries(value).map(([dimensions, file]) =>
    [dimensions, { key: file.key, size: file.size, url: mediaUrl(base, file.key), ...(file.time !== undefined && { time: file.time }) }]));
}
function readThumbnailIndex(value: unknown, folder: string, base: string): Record<string, Thumbnails> {
  if (!isRecord(value)) throw new Error("Invalid monthly thumbnails file.");
  return Object.fromEntries(Object.entries(value).map(([key, files]) => {
    validatePostMediaKeys([{ key, size: 1 }], folder);
    const thumbnails = readThumbnails(files, key);
    if (Object.values(thumbnails).some(file => file.url !== mediaUrl(base, file.key))) throw new Error("Invalid thumbnail CDN URL.");
    return [key, thumbnails];
  }));
}
function parseBody(event: MediaEvent): Record<string, unknown> {
  const limit = requestBodyLimit(event.routeKey);
  if (event.isBase64Encoded || typeof event.body !== "string" || Buffer.byteLength(event.body) > limit) reject("Expected a small JSON request.");
  let body: unknown;
  try { body = JSON.parse(event.body); }
  catch { reject("Invalid JSON."); }
  if (!isRecord(body)) reject("Expected a JSON object.");
  return body;
}
function mac(payload: string, secret: string) { return createHmac("sha256", secret).update(payload).digest(); }
function credentialDigest(value: string | Buffer) { return createHash("sha256").update(value).digest(); }
function authenticate(event: MediaEvent, expected: Buffer) {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const match = typeof header === "string" && header.length <= 8192 && /^Basic ([a-zA-Z0-9+/]+={0,2})$/i.exec(header);
  if (!match) throw new HttpError(401, "Invalid username or password.");
  const decoded = Buffer.from(match[1], "base64");
  if (decoded.toString("base64") !== match[1] || !timingSafeEqual(credentialDigest(decoded), expected)) {
    throw new HttpError(401, "Invalid username or password.");
  }
}
function createGrant(data: Grant, secret: string) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}
function readGrant(ticket: unknown, secret: string, subject: string, now: Date, prefix: string): Grant {
  if (typeof ticket !== "string" || ticket.length > 4096) reject("Invalid upload grant.");
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra) reject("Invalid upload grant.");
  const actual = Buffer.from(signature, "base64url");
  const expected = mac(payload, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(403, "Invalid upload grant.");
  let grant: unknown;
  try { grant = JSON.parse(Buffer.from(payload, "base64url").toString()); }
  catch { reject("Invalid upload grant."); }
  if (!isRecord(grant) || grant.sub !== subject || typeof grant.exp !== "number" || !Number.isSafeInteger(grant.exp) ||
      grant.exp <= Math.floor(now.getTime() / 1000) || typeof grant.key !== "string" || !grant.key.startsWith(prefix) ||
      typeof grant.size !== "number" || !Number.isSafeInteger(grant.size) || grant.size < 1 || grant.size > MAX_FILE_SIZE ||
      typeof grant.type !== "string" || !TYPES.has(grant.type) ||
      typeof grant.bucket !== "string" || typeof grant.prefix !== "string" || typeof grant.region !== "string") {
    throw new HttpError(403, "Upload grant expired or does not belong to this user.");
  }
  return {
    bucket: grant.bucket, prefix: grant.prefix, region: grant.region, key: grant.key,
    size: grant.size, type: grant.type, sub: subject, exp: grant.exp,
  };
}

export function parseBuckets(value: unknown) {
  let entries = value;
  if (typeof value === "string") {
    try { entries = JSON.parse(value); }
    catch { throw new Error("MEDIA_BUCKETS must contain a valid JSON object."); }
  }
  if (!isRecord(entries) || !Object.keys(entries).length) {
    throw new Error("MEDIA_BUCKETS must contain at least one configured bucket.");
  }
  const buckets = new Map<string, BucketSettings>();
  for (const [bucket, settings] of Object.entries(entries)) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
        !isRecord(settings) ||
        typeof settings.prefix !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(settings.prefix) ||
        typeof settings.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(settings.region) ||
        typeof settings.publicBaseUrl !== "string") {
      throw new Error("Each MEDIA_BUCKETS entry needs a valid bucket name, prefix, region, and HTTPS publicBaseUrl.");
    }
    let url;
    try { url = new URL(settings.publicBaseUrl); }
    catch { throw new Error("MEDIA_BUCKETS publicBaseUrl must be an HTTPS origin."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("MEDIA_BUCKETS publicBaseUrl must be an HTTPS origin without credentials, path, or query.");
    }
    buckets.set(bucket, { bucket, prefix: settings.prefix, region: settings.region, publicBaseUrl: url.origin });
  }
  return buckets;
}

export function createHandler({ clientForRegion, sign = signUpload, config, now = () => new Date(), logger = console }: HandlerOptions) {
  const { username, password } = config;
  const buckets = parseBuckets(config.buckets);
  const clients = new Map<string, S3Client>();
  const getClient = clientForRegion ?? ((region: string) => {
    let client = clients.get(region);
    if (!client) {
      client = new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED" });
      clients.set(region, client);
    }
    return client;
  });
  function destination(bucket: unknown) {
    if (typeof bucket !== "string" || !bucket) reject("A bucket name is required.");
    const settings = buckets.get(bucket);
    if (!settings) throw new HttpError(403, "This bucket is not allowed.");
    return settings;
  }
  if (typeof username !== "string" || !username || username.length > 128 || /[:\r\n]/.test(username) ||
      typeof password !== "string" || password.length < 16 || password.length > 1024 || /[\r\n]/.test(password)) {
    throw new Error("Set MEDIA_USERNAME (no colon) and MEDIA_PASSWORD (16-1024 characters) on Lambda.");
  }
  const expectedCredentials = credentialDigest(`${username}:${password}`);
  // Preserve the existing grant format so the extracted API remains compatible.
  const secret = createHmac("sha256", expectedCredentials).update("blog-media-upload-grants").digest("hex");
  return async (event: MediaEvent) => {
    try {
      authenticate(event, expectedCredentials);
      const route = event.routeKey;
      if (route === "GET /media") {
        const query = event.queryStringParameters || {};
        const { bucket, prefix, publicBaseUrl, region } = destination(query.bucket);
        const listPrefix = query.month ? monthPrefix(query.month, prefix) : prefix;
        if (query.cursor && (typeof query.cursor !== "string" || query.cursor.length > 4096)) reject("Invalid page cursor.");
        const result = await getClient(region).send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: listPrefix, MaxKeys: 50, ContinuationToken: query.cursor || undefined,
        }));
        const contents = result.Contents || [];
        const visible = contents.filter((item): item is typeof item & { Key: string } =>
          !!item.Key && !item.Key.endsWith("/") && !item.Key.endsWith(`/${POSTS_FILE}`) &&
          !item.Key.endsWith(`/${THUMBNAILS_FILE}`) && !isVideoPoster(item.Key) && !isMediaThumbnail(item.Key),
        );
        const folders = [...new Set(visible.filter(item => /^(image|video)\//.test(mediaType(item.Key) ?? ""))
          .map(item => item.Key.slice(0, item.Key.lastIndexOf("/") + 1)))];
        const indices = new Map<string, Record<string, Thumbnails>>(await Promise.all(folders.map(async folder => {
          try {
            const object = await getClient(region).send(new GetObjectCommand({ Bucket: bucket, Key: `${folder}${THUMBNAILS_FILE}` }));
            if (!object.Body) throw new Error("Monthly thumbnails object is missing its body.");
            return [folder, readThumbnailIndex(JSON.parse(await object.Body.transformToString()), folder, publicBaseUrl)] as const;
          } catch (error) {
            if (error instanceof Error && error.name === "NoSuchKey") return [folder, {}] as const;
            throw error;
          }
        })));
        const items = await Promise.all(visible.map(async item => {
          const folder = item.Key.slice(0, item.Key.lastIndexOf("/") + 1);
          const thumbnails = indices.get(folder)?.[item.Key];
          let poster;
          if (thumbnails === undefined && mediaType(item.Key)?.startsWith("video/")) {
            const key = posterKey(item.Key);
            // A companion may be on a different library page.
            const companion = contents.find(candidate => candidate.Key === key) ??
              (await getClient(region).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }))).Contents?.find(candidate => candidate.Key === key);
            if (companion) {
              if (typeof companion.Size !== "number" || companion.Size < 1) throw new Error("Video poster size is missing.");
              poster = { key, size: companion.Size, url: mediaUrl(publicBaseUrl, key) };
            }
          }
          return { key: item.Key, size: item.Size, modified: item.LastModified?.toISOString(), url: mediaUrl(publicBaseUrl, item.Key),
            ...(poster && { poster }), ...(thumbnails !== undefined && { thumbnails }) };
        }));
        return json(200, {
          bucket, items,
          cursor: result.IsTruncated ? result.NextContinuationToken : null,
        });
      }
      if (route === "POST /thumbnails") {
        const body = parseBody(event);
        const { bucket, prefix, publicBaseUrl, region } = destination(body.bucket);
        const folder = monthPrefix(body.month, prefix);
        if (typeof body.key !== "string") reject("A media key is required.");
        let thumbnails: Thumbnails;
        try {
          validatePostMediaKeys([{ key: body.key, size: 1 }], folder);
          thumbnails = canonicalThumbnails(body.thumbnails, body.key, publicBaseUrl);
        } catch (error) { reject(asError(error).message); }
        const client = getClient(region);
        const input = { Bucket: bucket, Key: `${folder}${THUMBNAILS_FILE}` };
        for (let attempt = 0; attempt < 5; attempt++) {
          let index: Record<string, Thumbnails> = {};
          let etag: string | undefined;
          try {
            const object = await client.send(new GetObjectCommand(input));
            if (!object.Body || !object.ETag) throw new Error("Monthly thumbnails object is missing its body or ETag.");
            index = readThumbnailIndex(JSON.parse(await object.Body.transformToString()), folder, publicBaseUrl);
            etag = object.ETag;
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "NoSuchKey") throw error;
          }
          try {
            await client.send(new PutObjectCommand({ ...input, Body: JSON.stringify({ ...index, [body.key]: thumbnails }),
              ContentType: "application/json", CacheControl: "no-cache", ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }) }));
            return json(200, { bucket, key: body.key, thumbnails });
          } catch (error) {
            if (!(error instanceof Error) || !["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name)) throw error;
          }
        }
        throw new HttpError(409, "The monthly thumbnails file changed repeatedly. Retry the upload to save its thumbnails.");
      }
      if (route === "GET /posts") {
        const query = event.queryStringParameters || {};
        const { bucket, prefix, publicBaseUrl, region } = destination(query.bucket);
        const key = `${monthPrefix(query.month, prefix)}${POSTS_FILE}`;
        try {
          const object = await getClient(region).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          if (!object.Body || !object.ETag) throw new Error("Monthly posts object is missing its body or ETag.");
          const content = await object.Body.transformToString();
          try { validatePostsFileSize(content); }
          catch (error) { throw new HttpError(413, asError(error).message); }
          return json(200, { bucket, key, url: mediaUrl(publicBaseUrl, key), etag: object.ETag, content });
        } catch (error) {
          if (error instanceof Error && error.name === "NoSuchKey") throw new HttpError(404, `No ${POSTS_FILE} exists for ${query.month}.`);
          throw error;
        }
      }
      if (route === "POST /posts/edit") {
        const body = parseBody(event);
        const { bucket, prefix, publicBaseUrl, region } = destination(body.bucket);
        const month = body.month;
        if (typeof month !== "string") reject("Month must use YYYY-MM.");
        const key = `${monthPrefix(month, prefix)}${POSTS_FILE}`;
        const url = mediaUrl(publicBaseUrl, key);
        if (typeof body.content !== "string") reject("Expected the edited JSON file as text.");
        try {
          validatePostsEtag(body.etag);
          validatePostsJson(body.content, month, { key, url });
        } catch (error) { reject(asError(error).message); }
        try {
          const result = await getClient(region).send(new PutObjectCommand({
            Bucket: bucket, Key: key, Body: body.content, IfMatch: body.etag,
            ContentType: "application/json", CacheControl: "no-cache",
          }));
          if (!result.ETag) throw new Error("The saved posts file is missing its ETag. Reload it before editing again.");
          return json(200, { bucket, key, url, etag: result.ETag, content: body.content });
        } catch (error) {
          if (error instanceof Error && ["PreconditionFailed", "ConditionalRequestConflict", "NoSuchKey"].includes(error.name)) {
            throw new HttpError(409, "The posts file changed or was removed. Copy your edits, then discard changes and reload before saving again.");
          }
          throw error;
        }
      }
      if (route === "POST /posts") {
        const body = parseBody(event);
        const { bucket, prefix, publicBaseUrl, region } = destination(body.bucket);
        try { validatePostInput(body); }
        catch (error) { reject(asError(error).message); }
        const date = now();
        const month = date.toISOString().slice(0, 7);
        if (body.month !== month) reject("Posts must use the current UTC month. Start a new post after the month changes.");
        const folder = monthPrefix(month, prefix);
        try { validatePostMediaKeys(body.media, folder); }
        catch (error) { reject(asError(error).message); }
        const media = body.media.map(item => {
          return { key: item.key, size: item.size, url: mediaUrl(publicBaseUrl, item.key),
            ...(item.poster && { poster: {
              key: item.poster.key, size: item.poster.size, url: mediaUrl(publicBaseUrl, item.poster.key),
              ...(item.poster.time !== undefined && { time: item.poster.time }),
            } }),
            ...(item.thumbnails !== undefined && { thumbnails: canonicalThumbnails(item.thumbnails, item.key, publicBaseUrl) }) };
        });
        const post: Post = {
          id: body.id, text: body.text.trim(), tags: [...new Set(body.tags.map(tag => tag.trim()))],
          media, created: date.toISOString(),
        };
        const client = getClient(region);
        const input = { Bucket: bucket, Key: `${folder}${POSTS_FILE}` };
        for (let attempt = 0; attempt < 5; attempt++) {
          let posts: Post[] = [];
          let storedPosts: unknown[] = [];
          let etag: string | undefined;
          try {
            const object = await client.send(new GetObjectCommand(input));
            if (!object.Body || !object.ETag) throw new Error("Monthly posts object is missing its body or ETag.");
            const value: unknown = JSON.parse(await object.Body.transformToString());
            if (!Array.isArray(value)) throw new Error("Invalid monthly posts file.");
            posts = readPosts(value, month);
            storedPosts = value;
            etag = object.ETag;
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "NoSuchKey") throw error;
          }
          const existing = posts.find(item => item.id === post.id);
          if (existing) {
            if (JSON.stringify({ ...existing, created: "" }) !== JSON.stringify({ ...post, created: "" })) {
              throw new HttpError(409, "This post ID already belongs to a different post.");
            }
            return json(200, { bucket, post: existing, url: mediaUrl(publicBaseUrl, input.Key) });
          }
          try {
            await client.send(new PutObjectCommand({
              ...input, Body: JSON.stringify([...storedPosts, post]), ContentType: "application/json",
              CacheControl: "no-cache", ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
            }));
            return json(201, { bucket, post, url: mediaUrl(publicBaseUrl, input.Key) });
          } catch (error) {
            if (!(error instanceof Error) || !["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name)) throw error;
          }
        }
        throw new HttpError(409, "The monthly posts file changed repeatedly. Retry your post.");
      }
      if (route === "POST /uploads") {
        const body = parseBody(event);
        const { bucket, prefix, publicBaseUrl, region } = destination(body.bucket);
        if (typeof body.name !== "string" || body.name.length > 255 || !body.name) reject("Invalid filename.");
        if (typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_FILE_SIZE) reject("Files must be between 1 byte and 2 GiB.");
        const type = mediaType(body.name);
        if (!type || body.type !== type) reject("Unsupported image/audio/video type or filename extension.");
        try { validateFile(body); }
        catch (error) { reject(asError(error).message); }
        if ([body.posterFor, body.thumbnailFor].some(name => typeof name === "string" && name.length > 255)) reject("Invalid original filename.");
        const date = now();
        const folder = monthPrefix(body.month || date.toISOString().slice(0, 7), prefix);
        const key = typeof body.thumbnailFor === "string" && typeof body.dimensions === "string" ?
          thumbnailKey(`${folder}${uploadFilename(body.thumbnailFor)}`, body.dimensions) :
          typeof body.posterFor === "string" ? posterKey(`${folder}${uploadFilename(body.posterFor)}`) :
          `${folder}${uploadFilename(body.name)}`;
        const ticket = createGrant({
          bucket, prefix, region, key, size: body.size, type, sub: "owner",
          exp: Math.floor(date.getTime() / 1000) + GRANT_LIFETIME,
        }, secret);
        return json(201, { bucket, key, ticket, url: mediaUrl(publicBaseUrl, key), partSize: PART_SIZE });
      }
      if (route === "POST /sign") {
        const body = parseBody(event);
        const { bucket, prefix, region } = destination(body.bucket);
        const grant = readGrant(body.ticket, secret, "owner", now(), prefix);
        if (grant.bucket !== bucket || grant.prefix !== prefix || grant.region !== region) {
          throw new HttpError(403, "Upload grant does not match this bucket configuration.");
        }
        if (body.key !== grant.key) throw new HttpError(403, "Upload key does not match its grant.");
        const input = { Bucket: bucket, Key: grant.key };
        const hasUploadId = body.uploadId !== undefined;
        if (hasUploadId && (typeof body.uploadId !== "string" || !body.uploadId || body.uploadId.length > 2048)) reject("Invalid multipart upload ID.");
        const uploadId = typeof body.uploadId === "string" ? body.uploadId : undefined;
        let command: UploadCommand;
        let headers: Record<string, string> | undefined;
        if (!hasUploadId) {
          if (body.partNumber !== undefined) reject("Part number requires a multipart upload ID.");
          headers = { "Content-Type": grant.type };
          const metadata = { ...input, ContentType: grant.type };
          if (body.method === "PUT") {
            if (grant.size > 100 * 1024 ** 2) reject("Files over 100 MiB require multipart upload.");
            command = new PutObjectCommand({ ...metadata, ContentLength: grant.size });
          } else if (body.method === "POST") command = new CreateMultipartUploadCommand(metadata);
          else reject("Unsupported upload operation.");
        } else if (body.method === "PUT") {
          const count = Math.ceil(grant.size / PART_SIZE);
          if (typeof body.partNumber !== "number" || !Number.isInteger(body.partNumber) || body.partNumber < 1 || body.partNumber > count) reject("Invalid multipart part number.");
          command = new UploadPartCommand({
            ...input, UploadId: uploadId, PartNumber: body.partNumber,
            ContentLength: Math.min(PART_SIZE, grant.size - (body.partNumber - 1) * PART_SIZE),
          });
        } else {
          if (body.partNumber !== undefined) reject("Part number is only valid for uploading a part.");
          const multipart = { ...input, UploadId: uploadId };
          if (body.method === "GET") command = new ListPartsCommand(multipart);
          else if (body.method === "POST") command = new CompleteMultipartUploadCommand(multipart);
          else if (body.method === "DELETE") command = new AbortMultipartUploadCommand(multipart);
          else reject("Unsupported upload operation.");
        }
        const url = await sign(getClient(region), command, {
          expiresIn: 300, signableHeaders: new Set(["content-length", ...(headers ? ["content-type"] : [])]),
        });
        return json(200, { bucket, url, key: grant.key, ...(headers && { headers }) });
      }
      throw new HttpError(404, "Unknown media endpoint.");
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      const failure = asError(error);
      logger.error("Media API request failed", { route: event.routeKey, name: failure.name, message: failure.message });
      return json(500, { error: "Media service failed. Check the Lambda logs and try again." });
    }
  };
}

let runtimeHandler: ReturnType<typeof createHandler> | undefined;
export async function handler(event: MediaEvent) {
  if (!runtimeHandler) {
    try {
      runtimeHandler = createHandler({
        config: { buckets: process.env.MEDIA_BUCKETS, username: process.env.MEDIA_USERNAME, password: process.env.MEDIA_PASSWORD },
      });
    } catch (error) {
      console.error("Media API configuration failed:", asError(error).message);
      return json(503, { error: "Media service is not configured. Check the Lambda environment variables." });
    }
  }
  return runtimeHandler(event);
}
