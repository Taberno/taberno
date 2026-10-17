import type { RepoClient, RemoteRecord, Write } from '../../src/atproto/repo';
import type { BlobRef } from '../../src/atproto/records';

// An in-memory atproto repo with the same rules as a PDS's applyWrites:
// atomic batches, create fails if the record exists, update and delete fail
// if it doesn't.

const VALID_CID = 'bafkreialrlq76mkl7jukpk3j2eadrtlthf4wxnaleefbp63nwkwpvsuf3e';

export class FakeRepo implements RepoClient {
  readonly did: string;
  records = new Map<string, { cid: string; value: Record<string, unknown> }>();
  batches: Write[][] = [];
  uploads = 0;
  failNextWrite = false;
  private n = 0;

  constructor(did = 'did:plc:fakeshopaaaaaaaaaaaaaaaa') {
    this.did = did;
  }

  async describeRepo() {
    return { handle: 'shop.example.com' };
  }

  async uploadBlob(data: Buffer, mimeType: string): Promise<BlobRef> {
    this.uploads++;
    return { $type: 'blob', ref: { $link: VALID_CID }, mimeType, size: data.byteLength };
  }

  async listRecords(collection: string): Promise<RemoteRecord[]> {
    return [...this.records]
      .filter(([k]) => k.startsWith(`${collection}/`))
      .map(([k, r]) => ({ uri: `at://${this.did}/${k}`, cid: r.cid, value: r.value }));
  }

  async applyWrites(writes: Write[]): Promise<(string | null)[]> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('InvalidRequest: Could not find blob');
    }
    const next = new Map(this.records);
    const cids = writes.map((w) => {
      const k = `${w.collection}/${w.rkey}`;
      if (w.action === 'delete') {
        if (!next.delete(k)) throw new Error(`delete: no record ${k}`);
        return null;
      }
      if (w.action === 'create' && next.has(k)) throw new Error(`create: ${k} exists`);
      if (w.action === 'update' && !next.has(k)) throw new Error(`update: no record ${k}`);
      const cid = `bafyreicid${++this.n}`;
      next.set(k, { cid, value: w.value });
      return cid;
    });
    this.records = next;
    this.batches.push(writes);
    return cids;
  }

  /** Writes made since the last call. */
  takeWrites(): Write[] {
    const all = this.batches.flat();
    this.batches = [];
    return all;
  }

  get(collection: string): Record<string, unknown>[] {
    return [...this.records].filter(([k]) => k.startsWith(`${collection}/`)).map(([, r]) => r.value);
  }
}
