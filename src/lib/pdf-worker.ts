import { parentPort } from "node:worker_threads";

interface Request {
  bytes: Uint8Array;
  maxChars: number;
  maxPages: number;
}

parentPort?.once("message", async (input: Request) => {
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: input.bytes, disableFontFace: true, maxImageSize: 0 });
    try {
      const pdf = await task.promise;
      const pageLimit = Math.min(pdf.numPages, input.maxPages);
      const parts: string[] = [];
      let chars = 0;
      let hasText = false;
      let truncated = pdf.numPages > pageLimit;
      for (let pageNumber = 1; pageNumber <= pageLimit && chars < input.maxChars; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .filter(Boolean)
          .join(" ")
          .trim();
        if (text) hasText = true;
        const section = `--- Page ${pageNumber} ---\n${text}`;
        const remaining = input.maxChars - chars;
        if (section.length > remaining) {
          parts.push(section.slice(0, remaining));
          truncated = true;
          break;
        }
        parts.push(section);
        chars += section.length + 2;
      }
      if (!hasText) throw new Error("PDF contained no extractable text within limits");
      parentPort?.postMessage({
        ok: true,
        result: { kind: "pdf", text: parts.join("\n\n"), pages: pdf.numPages, truncated },
      });
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
