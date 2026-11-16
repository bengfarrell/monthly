import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  ListPartsCommand, PutObjectCommand, UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { MediaS3Client, UploadCommand } from "../lambda/handler.js";
import type { MediaItem } from "../src/shared/media-types.js";
import { LOCAL_BUCKET, LOCAL_PREFIX } from "./fixtures.js";

export class LocalHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface MultipartUpload {
  key: string;
  type: string;
  parts: Map<number, { size: number; etag: string }>;
}
const escapeXml = (value: string) => value.replace(/[<>&"']/g, character =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);

export async function readBody(request: IncomingMessage, limit: number, collect = true) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (collect && size <= limit) chunks.push(bytes);
  }
  if (size > limit) throw new LocalHttpError(413, "Request body is too large.");
  return { size, text: collect ? Buffer.concat(chunks).toString("utf8") : "" };
}

export class MockS3 implements MediaS3Client {
  readonly assets: Map<string, MediaItem>;
  #signatures = new Map<string, { command: UploadCommand; expires: number }>();
  #uploads = new Map<string, MultipartUpload>();

  constructor(assets: MediaItem[]) {
    this.assets = new Map(assets.map(asset => [asset.key, { ...asset }]));
  }

  send: MediaS3Client["send"] = async command => {
    if (command.input.Bucket !== LOCAL_BUCKET) throw new Error("The mock S3 client only supports the local bucket.");
    const prefix = command.input.Prefix ?? "";
    let after = "";
    if (command.input.ContinuationToken) {
      after = Buffer.from(command.input.ContinuationToken, "base64url").toString();
      if (!after.startsWith(prefix) || Buffer.from(after).toString("base64url") !== command.input.ContinuationToken) {
        throw new Error("Invalid mock S3 continuation token.");
      }
    }
    const matching = [...this.assets.values()]
      .filter(asset => asset.key.startsWith(prefix) && asset.key > after)
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const items = matching.slice(0, command.input.MaxKeys ?? 50);
    const truncated = items.length < matching.length;
    return {
      Contents: items.map(asset => ({
        Key: asset.key, Size: asset.size, LastModified: new Date(asset.modified!),
      })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? Buffer.from(items.at(-1)!.key).toString("base64url") : undefined,
    };
  };

  sign(command: UploadCommand, origin: string, expiresIn: number) {
    const time = Date.now();
    for (const [token, signature] of this.#signatures) {
      if (signature.expires < time) this.#signatures.delete(token);
    }
    const token = randomUUID();
    this.#signatures.set(token, { command, expires: time + expiresIn * 1000 });
    return `${origin}/__monthly/s3/${token}`;
  }

  #save(key: string, size: number, type: string) {
    if (!key.startsWith(LOCAL_PREFIX)) throw new LocalHttpError(400, "Invalid mock upload key.");
    const url = type.startsWith("video/") ? "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" :
      type.startsWith("audio/") ? "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3" :
        "https://picsum.photos/seed/monthly-local-upload/800/600";
    this.assets.set(key, { key, size, modified: new Date().toISOString(), url });
  }

  async upload(token: string, request: IncomingMessage, response: ServerResponse) {
    const signature = this.#signatures.get(token);
    if (!signature || signature.expires < Date.now()) throw new LocalHttpError(403, "Mock upload signature is missing or expired.");
    const { command } = signature;
    const method = command instanceof PutObjectCommand || command instanceof UploadPartCommand ? "PUT" :
      command instanceof ListPartsCommand ? "GET" : command instanceof AbortMultipartUploadCommand ? "DELETE" : "POST";
    if (request.method !== method) throw new LocalHttpError(405, "Wrong method for mock upload signature.");
    const key = command.input.Key;
    if (!key || command.input.Bucket !== LOCAL_BUCKET) throw new LocalHttpError(400, "Invalid mock upload destination.");
    const xml = (body: string) => response.writeHead(200, {
      "Content-Type": "application/xml", "Cache-Control": "no-store",
    }).end(body);
    if (command instanceof PutObjectCommand || command instanceof UploadPartCommand) {
      const expected = command.input.ContentLength;
      if (expected === undefined) throw new LocalHttpError(400, "Mock upload length is missing.");
      const { size } = await readBody(request, expected, false);
      if (size !== expected) throw new LocalHttpError(400, "Mock upload size does not match the signed length.");
      const etag = `"${randomUUID()}"`;
      if (command instanceof PutObjectCommand) {
        this.#save(key, size, command.input.ContentType ?? "");
      } else {
        const upload = this.#uploads.get(command.input.UploadId!);
        if (!upload || upload.key !== key) throw new LocalHttpError(404, "Mock multipart upload does not exist.");
        upload.parts.set(command.input.PartNumber!, { size, etag });
      }
      response.writeHead(200, { ETag: etag, "Cache-Control": "no-store" }).end();
      return;
    }
    if (command instanceof CreateMultipartUploadCommand) {
      await readBody(request, 8192, false);
      const id = randomUUID();
      this.#uploads.set(id, { key, type: command.input.ContentType ?? "", parts: new Map() });
      xml(`<InitiateMultipartUploadResult><Bucket>${LOCAL_BUCKET}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    const id = command.input.UploadId!;
    const upload = this.#uploads.get(id);
    if (!upload || upload.key !== key) throw new LocalHttpError(404, "Mock multipart upload does not exist.");
    if (command instanceof ListPartsCommand) {
      const parts = [...upload.parts].sort(([left], [right]) => left - right).map(([number, part]) =>
        `<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag><Size>${part.size}</Size></Part>`).join("");
      xml(`<ListPartsResult><Bucket>${LOCAL_BUCKET}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${id}</UploadId><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
    } else if (command instanceof CompleteMultipartUploadCommand) {
      await readBody(request, 65536, false);
      const parts = [...upload.parts].sort(([left], [right]) => left - right);
      if (!parts.length || parts.some(([number], index) => number !== index + 1)) {
        throw new LocalHttpError(400, "Mock multipart upload has missing parts.");
      }
      this.#save(key, parts.reduce((total, [, part]) => total + part.size, 0), upload.type);
      this.#uploads.delete(id);
      xml(`<CompleteMultipartUploadResult><Location>${escapeXml(key)}</Location><Bucket>${LOCAL_BUCKET}</Bucket><Key>${escapeXml(key)}</Key><ETag>"mock-complete"</ETag></CompleteMultipartUploadResult>`);
    } else {
      this.#uploads.delete(id);
      response.writeHead(204).end();
    }
  }
}
