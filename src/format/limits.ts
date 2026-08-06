//! Format limits (SPEC.md §1.3). The reader enforces every cap before
//! allocating or interpreting.

export const MAX_SECTION_COUNT = 64;
export const MAX_SECTION_DECODED_LEN = 2 * 1024 * 1024 * 1024; // 2 GiB
export const MAX_TOTAL_DECODED = 4 * 1024 * 1024 * 1024; // 4 GiB
export const MAX_FILE_LEN = 4 * 1024 * 1024 * 1024; // 4 GiB
export const MAX_CHUNK_COUNT = 2 ** 28;
export const MAX_STYLE_COUNT = 2 ** 24;
export const MAX_CONTENT_COUNT = 2 ** 24;
export const MAX_PAGE_DIM = 8192;
export const MAX_GLYPH_COUNT = 2 ** 16;
export const MAX_KERNING_COUNT = 2 ** 24;
export const MAX_IMAGE_COUNT = 2 ** 20;
export const MAX_IMAGE_DIM = 16384;
