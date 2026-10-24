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
  'common.loadingPage': 'Đang tải trang',
  'common.retryNow': 'Thử lại ngay',
  'common.reloadView': 'Tải lại màn hình',
  'common.copyErrorDetails': 'Sao chép chi tiết lỗi',
  'common.copyFailed': 'Không sao chép được: hãy chọn văn bản rồi nhấn Ctrl+C',
  'common.showMore': 'Xem thêm',
  'common.showLess': 'Thu gọn',
  'common.textTooLong': 'Văn bản quá dài để hiển thị ở đây ({length} ký tự). Hãy dùng nút Sao chép.',
  'common.loadMore.showing': 'Đang hiển thị {shown} {noun}',
  'common.loadMore.showingOf': 'Đang hiển thị {shown} trên {total} {noun}',
  'common.loadMore.showingOfAtLeast': 'Đang hiển thị {shown} trên ít nhất {total} {noun}',
  'common.loadMore.capped': 'Đang hiển thị {shown} {noun} đầu tiên; hãy thu hẹp bộ lọc để xem các mục khác',
  'common.loadMore.button': 'Tải thêm {count}',
  'common.noun.sessions': '{count, plural, other {phiên}}',
  'common.noun.agents': '{count, plural, other {subagent}}',
  'common.noun.events': '{count, plural, other {sự kiện}}',
  'common.noun.errors': '{count, plural, other {lỗi}}',
  'time.earlier': 'trước đó',
  'error.subject.data': 'dữ liệu',
  'error.subject.sessions': 'danh sách phiên',
  'error.subject.session': 'phiên',
  'error.subject.moreSessions': 'các phiên tiếp theo',
  'error.subject.agents': 'danh sách subagent',
  'error.subject.events': 'sự kiện',
  'error.subject.errors': 'danh sách lỗi',
  'error.subject.monitor': 'trình giám sát',
  'error.load': 'Không tải được {subject}. Đang tự động thử lại.',
  'error.loadDetail': 'Không tải được {subject}: {detail}. Đang tự động thử lại.',
  'error.refresh': 'Không làm mới được {subject}. Đang hiển thị dữ liệu từ {age}.',
  'error.refreshDetail': 'Không làm mới được {subject}: {detail}. Đang hiển thị dữ liệu từ {age}.',
  'error.contract': 'Trình giám sát trả về {subject} mà trang này không đọc được.',
  'error.contractDetail': 'Trình giám sát trả về {subject} mà trang này không đọc được: {detail}.',
  'error.sessionNotFound':
    'Trình giám sát không biết phiên này. Phiên có thể nằm ngoài khoảng thời gian theo dõi hoặc thuộc một tác vụ khác.',
  'error.api.timeout': 'Trình giám sát không trả lời trong {seconds} giây',
  'error.api.timeoutPlain': 'Trình giám sát không trả lời kịp thời',
  'error.api.network': 'Không kết nối được với trình giám sát (runtime còn chạy không? Hãy thử `$MCS status`)',
  'error.api.parse': 'Trình giám sát gửi về phản hồi không đọc được',
  'error.api.contract': 'Trình giám sát gửi về dữ liệu mà trang này không hiểu',
  'error.api.aborted': 'Yêu cầu đã bị hủy',
  'error.api.forbidden': 'Yêu cầu bị từ chối (403): hãy mở trang này qua 127.0.0.1 hoặc localhost',
  'error.api.notFound': 'Không tìm thấy (404)',
  'error.api.notFoundDetail': 'Không tìm thấy: {detail}',
  'error.api.server': 'Lỗi từ trình giám sát ({status})',
  'error.api.serverDetail': 'Lỗi từ trình giám sát ({status}): {detail}',
  'error.api.failed': 'Yêu cầu không thành công ({status})',
  'error.api.failedDetail': 'Yêu cầu không thành công ({status}): {detail}',
  'error.handling.listChanged': 'Danh sách đã thay đổi; đã tải lại từ đầu',
  'error.handling.rejectedFilter': 'Trình giám sát từ chối bộ lọc này',
  'error.handling.rejectedFilterDetail': 'Trình giám sát từ chối bộ lọc này: {detail}',
  'error.handling.refusedAddress':
    'Trình giám sát từ chối địa chỉ của trang này. Hãy mở URL do `$MCS status --task <slug>` in ra.',
  'error.handling.transcriptGone': 'Tệp bản ghi hội thoại không còn trên đĩa',
  'error.handling.busy': 'Trình giám sát đang bận xử lý yêu cầu khác. Hãy thử lại sau giây lát.',
  'error.handling.internal': 'Trình giám sát gặp lỗi nội bộ',
  'error.handling.internalRequest': 'Trình giám sát gặp lỗi nội bộ (yêu cầu {id})',
  'error.handling.diskFull': 'Đĩa của trình giám sát đã đầy',
  'error.handling.unknownCode': 'Trình giám sát gửi về mã lỗi mà trang này không biết: {code}',
  'notFound.documentTitle': 'Không tìm thấy',
  'notFound.title': 'Không tìm thấy trang',
  'notFound.body': 'Trình giám sát không có trang nào tại {path}.',
  'notFound.openOverview': 'Mở Tổng quan',
  'notFound.openSessions': 'Mở Phiên',
  // @wp-end WP-112
  // @wp-begin WP-113
  'state.working.label': 'Đang làm việc',
  'state.working.description': 'Một lượt đang diễn ra và hệ thống giám sát đã thấy nó bắt đầu.',
  'state.running.label': 'Đang chạy',
  'state.running.description':
    'Phiên đang hoạt động nhưng chưa rõ cấu trúc của lượt, ví dụ mới chỉ thấy thao tác ghi tệp.',
  'state.waiting_tool.label': 'Chờ công cụ',
  'state.waiting_tool.description': 'Một lệnh gọi công cụ đang mở và chưa trả kết quả.',
  'state.waiting_agent.label': 'Chờ subagent',
  'state.waiting_agent.description': 'Phiên đang chờ một subagent hoàn thành.',
  'state.waiting_input.label': 'Chờ phản hồi',
  'state.waiting_input.description': 'Phiên đang chờ bạn trả lời hoặc phê duyệt.',
  'state.turn_ended.label': 'Đã kết thúc lượt',
  'state.turn_ended.description': 'Lượt gần nhất đã xong và phiên đang chờ lời nhắc tiếp theo.',
  'state.completed.label': 'Hoàn tất',
  'state.completed.description': 'Phiên đã kết thúc bình thường.',
  'state.failed.label': 'Thất bại',
  'state.failed.description': 'Phiên đã kết thúc với lỗi.',
  'state.stale.label': 'Lỗi thời',
  'state.stale.description': 'Đã lâu không có hoạt động nên phiên có thể đã bị bỏ dở.',
  'state.unknown.label': 'Không rõ',
  'state.unknown.description': 'Chưa đủ bằng chứng để xác định trạng thái.',
  'state.group.active': 'Đang hoạt động',
  'state.group.needsInput': 'Cần phản hồi',
  'state.group.done': 'Đã xong',
  'state.group.stale': 'Lỗi thời hoặc không rõ',
  'state.board.waiting': 'Đang chờ',
  'badge.inferredLabel': '{label}?',
  'badge.inferredTip': '{description} {basis}, {confidence}.',
  'badge.inferredTipQuiet': '{description} {basis}, {confidence}. Im lặng {age}.',
  'evidence.inferred': 'suy đoán',
  'evidence.inferredQuiet': 'suy đoán, im lặng {age}',
  'evidence.basis.observed': 'Quan sát trực tiếp',
  'evidence.basis.inferred': 'Suy đoán',
  'evidence.basis.inferredSilence': 'Suy đoán từ sự im lặng',
  'evidence.basis.inferredTranscript': 'Suy đoán từ bản ghi',
  'evidence.confidence.high': 'Độ tin cậy cao',
  'evidence.confidence.medium': 'Độ tin cậy trung bình',
  'evidence.confidence.low': 'Độ tin cậy thấp',
  'evidence.basisTip': '{basis}, {confidence}.',
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
  'topbar.refresh': 'Làm mới',
  'topbar.updatedAgo': 'cập nhật {age} trước',
  'live.popover.label': 'Chi tiết kết nối và tiếp nhận dữ liệu',
  'live.popover.settings': 'Mở phần cài đặt',
  'live.bar.connecting': 'Đang kết nối...',
  'live.bar.live': 'Trực tiếp',
  'live.bar.waiting': 'Đang chờ dữ liệu',
  'live.bar.paused': 'Tạm dừng cập nhật',
  'live.bar.refreshFailing': 'Làm mới thất bại',
  'live.bar.reconnecting': 'Đang kết nối lại',
  'live.bar.lost': 'Mất kết nối',
  'live.bar.offline': 'Ngoại tuyến',
  'live.bar.ingestionDegraded': 'Tiếp nhận dữ liệu suy giảm',
  'live.bar.ingestionStalled': 'Tiếp nhận dữ liệu bị đình trệ',
  'live.bar.ingestionDown': 'Tiếp nhận dữ liệu đã ngừng',
  'live.bar.ingestionUnknown': 'Chưa rõ việc tiếp nhận dữ liệu',
  'live.conn.connecting': 'Đang kết nối...',
  'live.conn.live': 'Trực tiếp',
  'live.conn.liveWaiting': 'Trực tiếp, đang chờ dữ liệu',
  'live.conn.polling': 'Tạm dừng cập nhật trực tiếp, làm mới mỗi {seconds} giây',
  'live.conn.pollingFailing': 'Làm mới thất bại',
  'live.conn.reconnecting': 'Đang kết nối lại',
  'live.conn.reconnectingRetry': 'Đang kết nối lại (thử lại sau {seconds} giây)',
  'live.conn.lost': 'Mất kết nối',
  'live.conn.lostRetry': 'Mất kết nối (thử lại sau {seconds} giây)',
  'live.conn.offline': 'Ngoại tuyến',
  'live.ingest.ok': 'Tiếp nhận dữ liệu bình thường',
  'live.ingest.degraded': 'Tiếp nhận dữ liệu suy giảm',
  'live.ingest.stalled': 'Tiếp nhận dữ liệu bị đình trệ',
  'live.ingest.down': 'Tiếp nhận dữ liệu đã ngừng',
  'live.ingest.disabled': 'Hook đang tắt: chỉ đọc bản ghi hội thoại',
  'live.ingest.unknown': 'Chưa rõ việc tiếp nhận dữ liệu',
  'live.ingest.lastKnown': 'Biết gần nhất: {status}, cách đây {age}',
  'live.ingest.lastKnownNoAge': 'Biết gần nhất: {status}',
  'live.ingest.status.ok': 'bình thường',
  'live.ingest.status.degraded': 'suy giảm',
  'live.ingest.status.stalled': 'đình trệ',
  'live.ingest.status.down': 'đã ngừng',
  'live.ingest.status.disabled': 'hook đang tắt',
  'live.ingest.status.unknown': 'chưa rõ',
  'live.section.connection': 'Kết nối',
  'live.section.ingestion': 'Tiếp nhận dữ liệu',
  'live.section.server': 'Máy chủ',
  'live.section.errors': 'Lỗi',
  'live.stream.connected': 'Cập nhật trực tiếp đã kết nối từ {time}',
  'live.stream.notConnected': 'Cập nhật trực tiếp chưa kết nối ({status})',
  'live.stream.lastEvent': 'Sự kiện gần nhất: {seq}',
  'live.stream.noEvent': 'Chưa có sự kiện nào',
  'live.stream.invalid': '{count, plural, other {# thông điệp không hợp lệ}}',
  'live.stream.reset': 'Lần đặt lại luồng gần nhất: {reason}',
  'live.stream.status.idle': 'nghỉ',
  'live.stream.status.connecting': 'đang kết nối',
  'live.stream.status.open': 'đang mở',
  'live.stream.status.backoff': 'chờ thử lại',
  'live.stream.status.stopped': 'đã dừng',
  'live.endpoints.heading': 'Các yêu cầu',
  'live.endpoints.none': 'Chưa có yêu cầu nào được gửi.',
  'live.endpoint.ok': 'thành công cách đây {age}',
  'live.endpoint.never': 'chưa từng thành công',
  'live.endpoint.failing': '{count, plural, other {# lần thất bại}} liên tiếp',
  'live.endpoint.lastError': 'gần nhất:',
  'live.server.none': 'Chưa nhận được báo cáo sức khỏe nào.',
  'live.server.version': 'Phiên bản',
  'live.server.epoch': 'Epoch',
  'live.server.uptime': 'Thời gian hoạt động',
  'live.server.started': 'Khởi động lúc',
  'live.server.epochNote':
    'Epoch mới nghĩa là máy chủ đã khởi động lại. Thay đổi cấu hình chỉ có hiệu lực sau khi khởi động lại.',
  'live.server.restartNeeded': 'Cần khởi động lại: mã của máy chủ đã thay đổi.',
  'live.server.unclean': 'Lần chạy trước kết thúc mà không tắt máy chủ đúng cách.',
  'live.server.conflict': 'Một tiến trình khác đang giữ phiên bản này (xung đột quyền sở hữu).',
  'live.errors.none': 'Chưa ghi nhận lỗi nào từ máy chủ.',
  'live.errors.shown': 'Đang hiển thị {shown} lỗi mới nhất trong tổng số {total}.',
  'live.title.running': '{count} đang chạy',
  'live.title.failed': '{count} thất bại',
  'live.title.offline': 'Hệ thống giám sát ngoại tuyến',
  'live.title.format': '{prefix} - {title}',
  'freshness.announce.lost': 'Mất kết nối',
  'freshness.announce.restored': 'Đã kết nối lại',
  'freshness.announce.paused': 'Đã tạm dừng cập nhật trực tiếp',
  'freshness.announce.stale': 'Dữ liệu đã cũ: không có cập nhật nào trong {age}',
  'freshness.announce.upToDate': 'Dữ liệu đã được cập nhật',
  'freshness.announce.degraded': 'Việc tiếp nhận dữ liệu suy giảm: {reason}',
  'freshness.announce.degradedPlain': 'Việc tiếp nhận dữ liệu suy giảm',
  'freshness.announce.recovered': 'Việc tiếp nhận dữ liệu đã phục hồi',
  'freshness.asOf': '{scope} tính đến {time} (cách đây {age}): {reason}',
  'freshness.asOfUnknown': '{scope}: {reason}',
  'freshness.reason.refreshFailing': 'làm mới thất bại',
  'freshness.reason.disconnected': 'mất kết nối cập nhật trực tiếp',
  'freshness.reason.noUpdate': 'không có cập nhật nào trong {age}',
  'menu.trigger': 'Tùy chọn',
  'menu.theme': 'Giao diện',
  'menu.theme.auto': 'Tự động',
  'menu.theme.light': 'Sáng',
  'menu.theme.dark': 'Tối',
  'menu.density': 'Mật độ',
  'menu.density.comfortable': 'Thoải mái',
  'menu.density.compact': 'Gọn',
  'menu.language': 'Ngôn ngữ',
  'menu.shortcuts': 'Phím tắt',
  'menu.announce.theme': 'Giao diện: {value}',
  'menu.announce.density': 'Mật độ: {value}',
  'menu.announce.language': 'Ngôn ngữ: {value}',
  'shortcuts.title': 'Phím tắt',
  'shortcuts.group.navigation': 'Điều hướng',
  'shortcuts.group.search': 'Tìm kiếm',
  'shortcuts.group.transcript': 'Bản ghi hội thoại',
  'shortcuts.fixed.escape': 'Đóng hộp thoại, hoặc xóa ô tìm kiếm khi đang chọn ô đó',
  'shortcuts.fixed.sidebar': 'Di chuyển trong danh sách phiên ở thanh bên',
  'shortcuts.key.esc': 'Esc',
  'shortcuts.key.up': 'Lên',
  'shortcuts.key.down': 'Xuống',
  'shortcuts.key.home': 'Home',
  'shortcuts.key.end': 'End',
