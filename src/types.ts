export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Error with a stable machine-readable code. Never put secret values in message/details. */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface BodyJson {
  json: { value: Json; contentType?: string };
}
export interface BodyForm {
  form: { fields: Record<string, Json>; contentType?: string };
}
export interface UploadPart {
  field: string;
  path: string;
  filename?: string;
  contentType?: string;
}
export interface BodyMultipart {
  multipart: { fields?: Record<string, Json>; files?: UploadPart[]; contentType?: string };
}
export interface BodyBinary {
  binary: { file: string; contentType: string };
}
export type BodyInput = BodyJson | BodyForm | BodyMultipart | BodyBinary;

export interface RequestInput {
  path?: Record<string, Json>;
  query?: Record<string, Json>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: BodyInput;
}

export interface Issue {
  pointer: string;
  keyword: string;
  message: string;
}
export interface Diagnostics {
  state: 'valid' | 'invalid' | 'not_available' | 'error';
  issues: Issue[];
}
