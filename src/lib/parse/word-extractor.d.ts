/**
 * word-extractor ships no type declarations of its own. As with mammoth and
 * pdf-parse, this declares only the slice of its surface used here -- see
 * legacy .doc handling in pdf.ts.
 */
declare module "word-extractor" {
  class Document {
    getBody(): string;
    getHeaders(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getTextboxes(): string;
  }
  class WordExtractor {
    extract(input: Buffer | string): Promise<Document>;
  }
  export = WordExtractor;
}
