import { Zip, ZipDeflate } from "fflate";
import type { Context } from "hono";
import { AppError } from "../service/errors.js";
import type { Page, Service } from "../service/projects.js";

/**
 * All pages at their paths under one top-level folder named after the slug, and nothing else.
 * Streamed: pages are pulled from the database a batch at a time and compressed one at a time as the
 * client reads, so memory is bounded by one batch however large the project (audit D3).
 */
export function exportZipStream(slug: string, pages: AsyncIterable<Page>, onDone: () => void = () => {}): ReadableStream<Uint8Array> {
  const iterator = pages[Symbol.asyncIterator]();
  const queue: Uint8Array[] = [];
  let finished = false;
  let failure: Error | null = null;
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      onDone();
    }
  };
  const zip = new Zip((err, chunk, final) => {
    if (err) failure = err;
    else queue.push(chunk);
    if (final) finished = true;
  });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (queue.length === 0 && !finished && !failure) {
          const next = await iterator.next();
          if (next.done) {
            zip.end();
            break;
          }
          const file = new ZipDeflate(`${slug}/${next.value.path}`, { level: 6 });
          zip.add(file);
          file.push(Buffer.from(next.value.content, "utf8"), true);
        }
      } catch (err) {
        failure = err as Error;
      }
      if (failure) {
        finish();
        controller.error(failure);
        return;
      }
      while (queue.length) controller.enqueue(queue.shift()!);
      if (finished) {
        finish();
        controller.close();
      }
    },
    async cancel() {
      finish();
      await iterator.return?.(undefined);
    },
  });
}

/** The export response shared by /api/v1 and the web page. Refuses projects over the size cap up front. */
export async function exportResponse(
  c: Context,
  service: Service,
  userId: string,
  slug: string,
  maxBytes: number,
  onDone?: () => void,
): Promise<Response> {
  const size = await service.exportSize(userId, slug);
  if (size.bytes > maxBytes) {
    throw new AppError(
      422,
      "too_large",
      `This project holds ${size.bytes} bytes, over the ${maxBytes}-byte export limit. Export it with the anywr command line tool instead.`,
    );
  }
  return c.body(exportZipStream(slug, service.iteratePages(userId, slug), onDone), 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${slug}.zip"`,
  });
}
