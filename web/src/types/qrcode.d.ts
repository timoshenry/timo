/**
 * Minimal local typings for the `qrcode` package (the @types/qrcode package is not in this
 * workspace's dependency set). Only the API TIMO uses is declared.
 */
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  export function toString(text: string, options?: { type?: "svg" | "terminal" | "utf8" }): Promise<string>;
}
