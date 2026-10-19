# Session monitor cho Claude Code

[English](README.md)

Công cụ theo dõi các phiên Claude Code, chạy cục bộ, chỉ đọc, có trang web. Claude Code ghi mọi phiên (phiên tương tác, lệnh
`claude -p`, subagent, workflow) vào một file transcript ngay trong lúc chạy. Monitor đọc trực tiếp các file đó, giữ một cơ sở dữ
liệu metadata nhỏ cho từng task và phục vụ một dashboard trên `127.0.0.1`: phiên nào đang chạy, đang làm gì, dùng bao nhiêu token,
phiên nào đã xong khi có bằng chứng bên ngoài (một daemon job đã kết thúc) xác nhận. Monitor không bao giờ khởi động,
dừng hay thay đổi một phiên.

Công cụ được đóng gói dưới dạng một skill của Claude Code (`monitoring-claude-sessions`), để agent có thể cài đặt giúp bạn, và
cũng dùng được như một dòng lệnh bình thường.

## Yêu cầu

- Node.js 22.22 trở lên (đã kiểm thử trên 22, 24 và 26). Không cần gì thêm: không trình biên dịch, không Python, không
  `npm install`, không build.
- Windows, macOS hoặc Linux (glibc), x64 hoặc arm64. Alpine (musl) được hỗ trợ ở mức cố gắng. Kết quả kiểm chứng theo nền tảng:
  [docs/platform-support.md](docs/platform-support.md). Dự án không dùng CI trên máy chủ: Linux được kiểm thử cục bộ trong
  Docker, Windows kiểm thử thủ công, còn macOS chưa được kiểm chứng tự động.

## Cài đặt

### A. Plugin của Claude Code (khuyên dùng)

Trong Claude Code:

```text
/plugin marketplace add <repo-url>
/plugin install session-monitor@session-monitor
```

Plugin chỉ chứa skill (không có hook, không có MCP server).

### B. Clone và chạy script cài đặt

```bash
git clone <repo-url> session-monitor
cd session-monitor
node install.mjs                  # vào <CLAUDE_CONFIG_DIR hoặc ~/.claude>/skills/monitoring-claude-sessions
node install.mjs --project <dir>  # hoặc vào <dir>/.claude/skills/monitoring-claude-sessions
```

`--dry-run` in ra những gì sẽ làm, `--force` thay thế bản cài do script tạo, `--uninstall` gỡ bản cài đó, `--dest <dir>` chọn
một thư mục skills khác. `node install.mjs --help` liệt kê các tùy chọn.

## Bắt đầu nhanh

Hãy nhờ Claude Code "theo dõi các phiên đang chạy", hoặc tự dùng launcher. Với cách cài B, launcher nằm ở
`~/.claude/skills/monitoring-claude-sessions/scripts/mcs.mjs` (bản cài plugin để skill trong bộ nhớ đệm plugin của Claude Code;
khi đó agent sẽ chạy launcher thay bạn). Chạy các lệnh trong repository có các phiên cần theo dõi, hoặc truyền `--repo PATH`.

```bash
MCS="node $HOME/.claude/skills/monitoring-claude-sessions/scripts/mcs.mjs"
$MCS init --name "Nightly build"                 # tạo .claude/monitor/tasks/nightly-build/ (hoặc dùng lại nếu đã có)
$MCS configure --task nightly-build --reason "chỉ các phiên build" \
  --set 'session_rules=[{"match":"STEP=([A-Z0-9]+)","label":"build step {1}"}]'
$MCS start --task nightly-build                  # in ra URL, ví dụ http://127.0.0.1:8765
$MCS verify --task nightly-build                 # monitor đang chạy trả về dữ liệu hợp lệ
$MCS status --task nightly-build                 # URL, pid, thời gian chạy, số phiên theo trạng thái
$MCS stop --task nightly-build
```

`$MCS help` liệt kê mọi lệnh, `$MCS help <command>` cho biết tùy chọn của từng lệnh. Một số lệnh hữu ích khác: `discover` (thư mục
transcript và các phiên gần đây), `inspect` (cấu hình đang có hiệu lực), `check` (kiểm tra cấu hình), `restart`,
`instances list`. Các khóa cấu hình và cú pháp biểu thức chính quy: [docs/configuration.md](docs/configuration.md) (tiếng Anh).

## Nâng cấp workspace tạo trước bản 4.0

Bản 4.0 chỉ đọc biểu thức chính quy cú pháp JavaScript. Một task workspace do phiên bản cũ tạo ra (cú pháp regex của Python như
`(?P<name>...)`, chưa có `instance.json`) cần chuyển đổi một lần:

```bash
$MCS stop --task <slug>
$MCS migrate-workspace --task <slug>            # chạy thử: cho thấy sẽ đổi gì, không ghi gì
$MCS migrate-workspace --task <slug> --apply    # sao lưu vào data/backups/ trước, rồi chuyển đổi
```

## Doctor

`$MCS doctor [--task <slug>]` kiểm tra Node, runtime, thư mục Claude và, khi có task, cả workspace, cấu hình, cơ sở dữ liệu và
cổng; mỗi vấn đề có một dòng `fix:` gợi ý cách sửa. Xem thêm [docs/troubleshooting.md](docs/troubleshooting.md) (tiếng Anh).

## Phát triển

Mã nguồn là một npm workspace trong `runtime/` (TypeScript: `shared`, `engine`, `server`, `cli`, `web`, `testkit`). Người dùng
chạy bundle đã commit sẵn trong `skills/monitoring-claude-sessions/bundle/`; lập trình viên build từ mã nguồn.

```bash
cd runtime
npm ci
npm run build          # TypeScript và giao diện web
npm test               # các bộ test unit, web, integration, isolation và resilience
npm run bundle         # build lại bundle được commit
npm run bundle:check   # chứng minh bundle đã commit trùng với một bản build mới
npm run docker:posix   # chạy các cổng kiểm tra trong container Linux dùng một lần (cần Docker)
```

Chi tiết: [docs/development.md](docs/development.md) và [docs/architecture.md](docs/architecture.md) (tiếng Anh).

## Quyền riêng tư và bảo mật

- Server chỉ lắng nghe trên `127.0.0.1` và kiểm tra header `Host` và `Origin`. Đó là lớp bảo vệ trước các trang web khác,
  **không phải xác thực**: ai truy cập được cổng thì đọc được trang.
- Transcript chứa prompt của bạn, nội dung file và có thể cả thông tin bí mật. Đừng bao giờ mở, chuyển tiếp hay tunnel cổng này
  ra ngoài.
- Monitor chỉ đọc: không bao giờ ghi vào transcript hay cấu hình của Claude Code. Cơ sở dữ liệu chỉ chứa metadata; nội dung
  transcript được đọc từ file khi trang cần.
- Không truy cập mạng nào ngoài server loopback; trang web không tải gì từ internet.

## Giấy phép

[MIT](LICENSE). Mã bên thứ ba được đóng gói: `skills/monitoring-claude-sessions/bundle/THIRD-PARTY-NOTICES.txt`.
