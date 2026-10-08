import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PAGES = 50;
const MAX_TEXT_CHARACTERS = 10_000;

export class PdfValidationError extends Error {
  readonly code = "invalid_pdf";
}

/** Reads text only: PDF actions, attachments, links and JavaScript are never invoked. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PAGES) {
      throw new PdfValidationError(`PDF exceeds the ${MAX_PAGES}-page limit`);
    }
    const pages: string[] = [];
    let length = 0;
    let readable = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item
        ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("")
        .replace(/[ \t]+/g, " ").trim();
      readable ||= /[\p{L}\p{N}]/u.test(text);
      const labelled = `[Page ${pageNumber}]\n${text}`;
      length += labelled.length + (pages.length ? 2 : 0);
      if (length > MAX_TEXT_CHARACTERS) {
        throw new PdfValidationError("PDF text exceeds the 10,000-character limit. Upload a shorter report.");
      }
      pages.push(labelled);
      page.cleanup();
    }
    if (!readable) {
      throw new PdfValidationError("PDF has no readable text. Upload a text-based PDF; scanned reports are not supported.");
    }
    return pages.join("\n\n");
  } catch (error) {
    if (error instanceof PdfValidationError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new PdfValidationError("PDF is password-protected. Upload an unlocked PDF.");
    }
    throw new PdfValidationError("PDF could not be read. Upload a valid text-based PDF.");
  } finally {
    await task.destroy();
  }
}
