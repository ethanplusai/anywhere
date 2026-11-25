import { gzipSync } from "fflate";

/** A gzipped tar of text files, enough for `tar -xz` to unpack the skill into a skills folder. */
export function tarGz(files: { path: string; content: string; mode?: number }[], mtime = 0): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  const field = (buf: Uint8Array, offset: number, length: number, value: string) => {
    buf.set(enc.encode(value).subarray(0, length), offset);
  };
  const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;
  for (const file of files) {
    const body = enc.encode(file.content);
    const header = new Uint8Array(512);
    field(header, 0, 100, file.path);
    field(header, 100, 8, octal(file.mode ?? 0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(body.length, 12));
    field(header, 136, 12, octal(mtime, 12));
    field(header, 148, 8, "        ");
    field(header, 156, 1, "0");
    field(header, 257, 6, "ustar\0");
    field(header, 263, 2, "00");
    let sum = 0;
    for (const b of header) sum += b;
    field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += b.length;
  }
  return gzipSync(tar, { mtime: 0 });
}
