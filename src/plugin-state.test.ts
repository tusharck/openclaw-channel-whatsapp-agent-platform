/**
 * S6b: FileOffsetStore durability — atomic replace, corrupt-file recovery —
 * plus the media retention GC added for S3. Only MemoryOffsetStore was
 * previously exercised, so the on-disk path that actually runs in production
 * was untested.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOffsetStore, deleteLocalFile, gcMediaDir, resolveStateRoot } from "./plugin-state.js";
import { DedupeTracker } from "./whatsapp/offset-store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-plugin-state-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function offsetFile(accountId: string): string {
  return path.join(root, "state", `${accountId}.offset.json`);
}

describe("FileOffsetStore", () => {
  it("round-trips offset + seen ids through disk", async () => {
    const store = new FileOffsetStore(root, "default");
    await store.save({ nextOffset: "cursor-7", seenMessageIds: ["a", "b"] });

    const reopened = new FileOffsetStore(root, "default");
    const loaded = await reopened.load();
    expect(loaded.nextOffset).toBe("cursor-7");
    expect(loaded.seenMessageIds).toEqual(["a", "b"]);
  });

  it("returns empty state when the file does not exist yet", async () => {
    const loaded = await new FileOffsetStore(root, "fresh").load();
    expect(loaded.nextOffset).toBeUndefined();
    expect(loaded.seenMessageIds).toEqual([]);
  });

  it("writes atomically via tmp+rename and leaves no tmp file behind", async () => {
    const store = new FileOffsetStore(root, "default");
    await store.save({ nextOffset: "c1", seenMessageIds: [] });

    const stateDir = path.join(root, "state");
    const entries = await fs.readdir(stateDir);
    expect(entries).toContain("default.offset.json");
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
  });

  it("recovers from a corrupt (truncated) offset file instead of throwing", async () => {
    const store = new FileOffsetStore(root, "default");
    await store.save({ nextOffset: "c1", seenMessageIds: ["x"] });
    // Simulate a torn/garbage file.
    await fs.writeFile(offsetFile("default"), '{"nextOffset":"c1","seenMess', "utf8");

    const loaded = await store.load();
    expect(loaded.nextOffset).toBeUndefined();
    expect(loaded.seenMessageIds).toEqual([]);
  });

  it("ignores non-string entries in a tampered seen list", async () => {
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    await fs.writeFile(offsetFile("default"), JSON.stringify({ nextOffset: 42, seenMessageIds: ["ok", 5, null] }), "utf8");

    const loaded = await new FileOffsetStore(root, "default").load();
    expect(loaded.nextOffset).toBeUndefined(); // 42 is not a string
    expect(loaded.seenMessageIds).toEqual(["ok"]);
  });

  it("keeps separate state per account id", async () => {
    await new FileOffsetStore(root, "work").save({ nextOffset: "w1", seenMessageIds: [] });
    await new FileOffsetStore(root, "home").save({ nextOffset: "h1", seenMessageIds: [] });

    expect((await new FileOffsetStore(root, "work").load()).nextOffset).toBe("w1");
    expect((await new FileOffsetStore(root, "home").load()).nextOffset).toBe("h1");
  });

  it("survives a restart through DedupeTracker (resume without reprocessing)", async () => {
    const store = new FileOffsetStore(root, "default");
    const first = new DedupeTracker(store);
    await first.init();
    first.markSeen("wamid.1");
    await first.commit("cursor-2");

    const afterRestart = new DedupeTracker(new FileOffsetStore(root, "default"));
    await afterRestart.init();
    expect(afterRestart.nextOffset).toBe("cursor-2");
    expect(afterRestart.has("wamid.1")).toBe(true);
    expect(afterRestart.has("wamid.2")).toBe(false);
  });
});

describe("media retention (S3)", () => {
  async function writeMedia(name: string, bytes: number, ageMs = 0): Promise<string> {
    const dir = path.join(root, "media");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fs.writeFile(file, Buffer.alloc(bytes));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await fs.utimes(file, when, when);
    }
    return file;
  }

  it("deletes files older than the max age", async () => {
    const old = await writeMedia("old.bin", 10, 48 * 60 * 60 * 1000);
    const fresh = await writeMedia("fresh.bin", 10);

    const res = await gcMediaDir(root);
    expect(res.removed).toBe(1);
    await expect(fs.stat(old)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
  });

  it("evicts oldest-first when the directory exceeds the size ceiling", async () => {
    const a = await writeMedia("a.bin", 1000, 3000);
    const b = await writeMedia("b.bin", 1000, 2000);
    const c = await writeMedia("c.bin", 1000, 1000);

    const res = await gcMediaDir(root, { maxTotalBytes: 1500 });
    expect(res.removed).toBe(2);
    await expect(fs.stat(a)).rejects.toThrow();
    await expect(fs.stat(b)).rejects.toThrow();
    await expect(fs.stat(c)).resolves.toBeTruthy(); // newest survives
  });

  it("is a no-op when the media dir does not exist", async () => {
    await expect(gcMediaDir(path.join(root, "nope"))).resolves.toEqual({ removed: 0, freedBytes: 0 });
  });

  it("deleteLocalFile never throws on a missing path", async () => {
    await expect(deleteLocalFile(path.join(root, "ghost.bin"))).resolves.toBeUndefined();
    await expect(deleteLocalFile(undefined)).resolves.toBeUndefined();
  });

  it("defaults the state root under the OS temp dir when no mediaDir is set", () => {
    expect(resolveStateRoot(undefined).startsWith(os.tmpdir())).toBe(true);
    expect(resolveStateRoot("/custom/dir")).toBe("/custom/dir");
  });
});
