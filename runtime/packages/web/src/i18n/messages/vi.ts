// The Vietnamese catalogue (ADR 0072). It has exactly the keys of `en.ts` and the same placeholders: `Record<MessageKey, string>`
// makes a missing or extra key a compile error, and the catalogue test compares the placeholders and the plural forms.
//
// This file is UTF-8 with real Vietnamese characters, never escape sequences, in Unicode normalisation form NFC. It is the only
// file where the text gate allows Vietnamese letters. Vietnamese has no plural forms: the `other` branch of a plural is the one
// that is shown, so write it so that it reads correctly for every number.
//
// Tone: neutral and polite, the plain second person ("bạn") when the text has to address the reader, no slang, no exclamation
// marks. Keep sentences short; a Vietnamese string is longer than the English one, so check the layouts at 1024 px.
//
// Glossary: one term per concept, used in every entry.
//   session                Phiên
//   subagent               subagent (never translated)
//   token                  token (never translated); output = Đầu ra, new input = Đầu vào mới, cache read = Đọc từ cache
//   error / warning        Lỗi / Cảnh báo
//   live                   Trực tiếp
//   stale                  Lỗi thời
//   the ten states         working = Đang làm việc, running = Đang chạy, waiting for tool = Chờ công cụ,
//                          waiting for subagent = Chờ subagent, waiting for input = Chờ phản hồi,
//                          turn ended = Đã kết thúc lượt, completed = Hoàn tất, failed = Thất bại,
//                          stale = Lỗi thời, unknown = Không rõ
//   language names         shown in their own language: English, Tiếng Việt
//
// Add the entries of a work package between its own markers; do not move a marker or touch another block.
import type { MessageKey } from '../types.ts';

export const viMessages: Record<MessageKey, string> = {
  'common.close': 'Đóng',
  'common.retry': 'Thử lại',
  'common.copy': 'Sao chép',
  'common.copied': 'Đã sao chép',
  'common.loading': 'Đang tải...',
  'common.notAvailable': 'Không khả dụng',
  'common.viewFailed': 'Không thể hiển thị màn hình này.',
  'common.reloadPage': 'Tải lại trang',
  'lang.auto': 'Tự động',
  'lang.en': 'English',
  'lang.vi': 'Tiếng Việt',
  // @wp-begin WP-53
  // @wp-end WP-53
  // @wp-begin WP-54
  // @wp-end WP-54
  // @wp-begin WP-65
  // @wp-end WP-65
  // @wp-begin WP-66
  // @wp-end WP-66
  // @wp-begin WP-67
  // @wp-end WP-67
  // @wp-begin WP-112
  // @wp-end WP-112
  // @wp-begin WP-113
  // @wp-end WP-113
  // @wp-begin WP-114
  // @wp-end WP-114
  // @wp-begin WP-115
  // @wp-end WP-115
  // @wp-begin WP-116
  // @wp-end WP-116
  // @wp-begin WP-117
  // @wp-end WP-117
  // @wp-begin WP-118
  // @wp-end WP-118
  // @wp-begin WP-119
  // @wp-end WP-119
  // @wp-begin WP-120
  // @wp-end WP-120
  // @wp-begin WP-121
  // @wp-end WP-121
  // @wp-begin WP-124
  // @wp-end WP-124
};
