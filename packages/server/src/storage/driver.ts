import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { config } from '../config.js';

// A pluggable object-storage backend. Metadata (buckets/objects) always lives in
// Postgres; a driver only handles the raw bytes.
export interface StorageDriver {
  readonly name: string;
  put(bucket: string, name: string, data: Buffer, mime: string): Promise<void>;
  get(bucket: string, name: string): Promise<Readable | Buffer>;
  delete(bucket: string, name: string): Promise<void>;
  removeBucket(bucket: string): Promise<void>;
  ensureBucket(bucket: string): Promise<void>;
}

// Guard object keys against path traversal.
function safeKey(name: string): string {
  return name.replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '');
}

// ── Local filesystem driver ────────────────────────────────────────────────
class LocalDriver implements StorageDriver {
  name = 'local';
  private full(bucket: string, name: string): string {
    const root = path.resolve(config.storagePath, bucket);
    const full = path.resolve(config.storagePath, bucket, safeKey(name));
    if (!full.startsWith(root)) throw Object.assign(new Error('invalid object path'), { statusCode: 400 });
    return full;
  }
  async ensureBucket(bucket: string) {
    await fs.mkdir(path.resolve(config.storagePath, bucket), { recursive: true });
  }
  async put(bucket: string, name: string, data: Buffer) {
    const dest = this.full(bucket, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }
  async get(bucket: string, name: string): Promise<Readable> {
    const p = this.full(bucket, name);
    await fs.access(p); // throws if missing
    return createReadStream(p);
  }
  async delete(bucket: string, name: string) {
    await fs.rm(this.full(bucket, name), { force: true });
  }
  async removeBucket(bucket: string) {
    await fs.rm(path.resolve(config.storagePath, bucket), { recursive: true, force: true });
  }
}

// ── S3-compatible driver (AWS S3, MinIO, R2, …) ────────────────────────────
// Uses @aws-sdk/client-s3, imported lazily so it is only required when enabled.
class S3Driver implements StorageDriver {
  name = 's3';
  private client: any;
  private s3: any;
  private bucketName = config.s3Bucket;
  private prefix = config.s3Prefix;

  private key(bucket: string, name: string): string {
    return `${this.prefix}${bucket}/${safeKey(name)}`.replace(/^\//, '');
  }
  private async lib() {
    if (!this.s3) {
      // @ts-ignore - optional dependency, resolved at runtime when STORAGE_BACKEND=s3
      this.s3 = await import('@aws-sdk/client-s3');
      this.client = new this.s3.S3Client({
        region: config.s3Region,
        endpoint: config.s3Endpoint || undefined,
        forcePathStyle: config.s3ForcePathStyle,
        credentials:
          config.s3AccessKeyId && config.s3SecretAccessKey
            ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }
            : undefined,
      });
    }
    return this.s3;
  }
  async ensureBucket() {
    /* S3 buckets are provisioned out-of-band; object keys are namespaced per bucket. */
  }
  async put(bucket: string, name: string, data: Buffer, mime: string) {
    const s3 = await this.lib();
    await this.client.send(
      new s3.PutObjectCommand({ Bucket: this.bucketName, Key: this.key(bucket, name), Body: data, ContentType: mime }),
    );
  }
  async get(bucket: string, name: string): Promise<Readable> {
    const s3 = await this.lib();
    try {
      const res = await this.client.send(
        new s3.GetObjectCommand({ Bucket: this.bucketName, Key: this.key(bucket, name) }),
      );
      return res.Body as Readable;
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404)
        throw Object.assign(new Error('object data missing'), { statusCode: 404 });
      throw e;
    }
  }
  async delete(bucket: string, name: string) {
    const s3 = await this.lib();
    await this.client.send(new s3.DeleteObjectCommand({ Bucket: this.bucketName, Key: this.key(bucket, name) }));
  }
  async removeBucket(bucket: string) {
    const s3 = await this.lib();
    // Delete all keys under the bucket prefix.
    let ContinuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new s3.ListObjectsV2Command({ Bucket: this.bucketName, Prefix: this.key(bucket, ''), ContinuationToken }),
      );
      for (const obj of list.Contents ?? []) {
        await this.client.send(new s3.DeleteObjectCommand({ Bucket: this.bucketName, Key: obj.Key }));
      }
      ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
}

let driver: StorageDriver | null = null;
export function storageDriver(): StorageDriver {
  if (!driver) driver = config.storageBackend === 's3' ? new S3Driver() : new LocalDriver();
  return driver;
}
