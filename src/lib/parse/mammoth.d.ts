/**
 * mammoth ships no type declarations of its own, and the DefinitelyTyped
 * package would be a second dependency for a single function call. This
 * declares just the slice of its surface we use, the same way pdf-parse.d.ts
 * does -- see docx handling in pdf.ts.
 */
declare module "mammoth" {
  interface ConversionResult {
    value: string;
    /** Conversion notes (unsupported styles and the like). We do not surface them. */
    messages: unknown[];
  }
  export function convertToHtml(input: { buffer: Buffer }): Promise<ConversionResult>;
}
