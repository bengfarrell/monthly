import Uppy, { type Meta, type UppyFile, type UppyOptions } from "@uppy/core";
import AwsS3, { type AwsBody, type AwsS3Options } from "@uppy/aws-s3";
import { Store } from "./store.js";
import { MAX_FILE_SIZE, MULTIPART_THRESHOLD, PART_SIZE, currentMonth, mediaType, validateFile, validateMonth } from "../shared/media-types.js";
import type { MediaItem } from "../shared/media-types.js";
import type { MediaApi, SignRequest, UploadGrant } from "./api.js";
import { asError } from "../shared/errors.js";

export interface QueuedFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  complete: boolean;
  error: string | null;
}
export interface UploaderState {
  month: string;
  files: QueuedFile[];
  uploaded: MediaItem[];
  uploading: boolean;
  error: Error | null;
  summary: string;
}
export interface MediaUploaderOptions {
  month?: string;
  uppyFactory?: (options: Omit<UppyOptions<Meta, AwsBody>, "restrictions"> & {
    restrictions: Partial<NonNullable<UppyOptions<Meta, AwsBody>["restrictions"]>>;
  }) => Uppy<Meta, AwsBody>;
}

export class MediaUploader extends Store<UploaderState> {
  #grants = new Map<string, UploadGrant>();
  #proposals = new Map<string, UppyFile<Meta, AwsBody>>();
  api: Pick<MediaApi, "prepare" | "sign">;
  uppy: Uppy<Meta, AwsBody>;

  constructor(api: Pick<MediaApi, "prepare" | "sign">, { month = currentMonth(), uppyFactory = options => new Uppy<Meta, AwsBody>(options) }: MediaUploaderOptions = {}) {
    super({ month, files: [], uploaded: [], uploading: false, error: null, summary: "" });
    this.api = api;
    this.uppy = uppyFactory({
      restrictions: { maxFileSize: MAX_FILE_SIZE, maxNumberOfFiles: 20 },
      onBeforeFileAdded: file => {
        try { validateFile(file); return true; }
        catch (error) { this.setState({ error: asError(error) }); return false; }
      },
    }).use(AwsS3<Meta, AwsBody>, {
      limit: 3,
      shouldUseMultipart: file => file.size !== null && file.size > MULTIPART_THRESHOLD,
      getChunkSize: () => PART_SIZE,
      generateObjectKey: file => {
        const proposal = crypto.randomUUID();
        this.#proposals.set(proposal, file);
        return proposal;
      },
      signRequest: request => this.signRequest(request),
    } satisfies AwsS3Options<Meta, AwsBody>);
    for (const event of ["file-added", "file-removed", "upload-progress", "upload-retry", "retry-all"] as const) {
      this.uppy.on(event, () => this.#publish());
    }
    this.uppy.on("upload", () => this.setState({ uploading: true, error: null, summary: "" }));
    this.uppy.on("restriction-failed", (file, error) => this.setState({ error }));
    this.uppy.on("upload-error", (file, error) => {
      this.setState({ error });
      this.#publish();
    });
    this.uppy.on("upload-success", (file, result) => {
      const grant = result.body?.key ? this.#grants.get(result.body.key) : undefined;
      if (!grant || !file || file.size === null) {
        this.setState({ error: new Error("Upload finished but its public URL is missing. Refresh the library.") });
        return;
      }
      this.setState({ uploaded: [{ key: grant.key, url: grant.url, size: file.size }, ...this.state.uploaded] });
      this.#publish();
    });
    this.uppy.on("complete", result => {
      this.setState({
        uploading: false,
        summary: `${result.successful?.length ?? 0} uploaded; ${result.failed?.length ?? 0} failed.`,
      });
      this.#publish();
    });
    this.uppy.on("cancel-all", () => {
      this.#grants.clear();
      this.#proposals.clear();
      this.setState({ uploading: false, summary: "Uploads cancelled." });
      this.#publish();
    });
  }

  #publish() {
    this.setState({ files: this.uppy.getFiles().map(file => ({
      id: file.id, name: file.name, size: file.size ?? 0,
      progress: file.progress.percentage || 0,
      complete: file.progress.uploadComplete || false,
      error: file.error || null,
    })) });
  }

  async signRequest(request: SignRequest) {
    let grant = this.#grants.get(request.key);
    if (!grant) {
      const file = this.#proposals.get(request.key);
      if (!file || request.uploadId) throw new Error("Upload authorization is missing. Remove the file and add it again.");
      validateFile(file);
      grant = await this.api.prepare(file, this.state.month);
      this.#grants.set(request.key, grant);
      this.#grants.set(grant.key, grant);
    }
    return this.api.sign(request, grant);
  }

  addFiles(files: Iterable<File>) {
    if (this.state.uploading) {
      this.setState({ error: new Error("Wait for the current upload to finish before adding files.") });
      return;
    }
    this.setState({ error: null, summary: "" });
    for (const file of this.uppy.getFiles()) {
      if (file.progress.uploadComplete) this.uppy.removeFile(file.id);
    }
    for (const file of files) {
      try { this.uppy.addFile({ name: file.name, type: mediaType(file.name) ?? undefined, data: file }); }
      catch (error) { this.setState({ error: asError(error) }); }
    }
    this.#publish();
  }

  setMonth(month: string) {
    try {
      validateMonth(month);
      if (this.state.uploading || this.uppy.getFiles().some(file => file.progress.uploadStarted && !file.progress.uploadComplete)) {
        throw new Error("Remove partially uploaded files before changing the upload month.");
      }
      this.setState({ month, error: null });
      return true;
    } catch (error) { this.setState({ error: asError(error) }); return false; }
  }

  removeFile(id: string) {
    if (this.state.uploading) return;
    this.uppy.removeFile(id);
    this.#publish();
  }

  async upload() {
    if (this.state.uploading) return;
    this.setState({ error: null });
    try {
      if (!this.state.files.length) throw new Error("Choose files to upload.");
      return await this.uppy.upload();
    } catch (error) {
      this.setState({ uploading: false, error: asError(error) });
    }
  }

  cancel() { this.uppy.cancelAll(); }
  destroy() { this.uppy.destroy(); }
}
