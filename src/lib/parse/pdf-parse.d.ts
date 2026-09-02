/**
 * pdf-parse@1 ships no type declarations for its `lib` subpath, which is the
 * entry we must use (see pdf.ts for why the package root is unusable). This
 * declares just the slice of its surface we call.
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
  }
  function pdfParse(data: Buffer, options?: { max?: number }): Promise<PdfParseResult>;
  export = pdfParse;
}
