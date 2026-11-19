import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";

//#region packages/shared/src/protocol/hook-envelope.ts
/** Version the handler reports (`--version`, envelope `handler.version`). Equals `RUNTIME_VERSION` (98 1.7, N2). */
const HANDLER_VERSION = "4.0.0";
/** Hard exit of the handler process, ms. */
const HANDLER_HARD_EXIT_MS = 1200;
/** Stdin bytes kept in memory by the handler. */
const STDIN_MAX_BYTES = 8388608;
/** Largest spool line; a longer one is replaced by the minimal envelope. */
const ENVELOPE_MAX_BYTES = 16384;
/** Above this segment size every new line is a minimal envelope. */
const SPOOL_SEGMENT_SOFT_CAP = 67108864;
/** Above this segment size nothing is written (`SPOOL_FULL`). */
const SPOOL_SEGMENT_HARD_CAP = 268435456;
/** Paths, chars (after normalization). */
const PATH_MAX_CHARS = 1024;
/** Largest route file, bytes. */
const ROUTE_FILE_MAX_BYTES = 16384;
/** `hooks-<YYYYMMDD>T<HH>Z.ndjson`: the UTC hour of `receivedAt`. */
function spoolSegmentName(receivedAt) {
	const date = new Date(receivedAt);
	const year = date.getUTCFullYear();
	if (!Number.isFinite(receivedAt) || Number.isNaN(year) || year < 0 || year > 9999) throw new RangeError("spoolSegmentName: not a time with a four digit UTC year");
	const two = (n) => String(n).padStart(2, "0");
	return "hooks-" + (String(year).padStart(4, "0") + two(date.getUTCMonth() + 1) + two(date.getUTCDate())) + "T" + two(date.getUTCHours()) + "Z.ndjson";
}
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_RE = /^[0-9A-Za-z_-]{3,64}$/;
const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,64}$/;
/** `event` when the payload carries a usable `hook_event_name`. */
const EVENT_NAME_RE = /^[A-Za-z]{1,64}$/;
/** A probe payload has a `session_id` starting with this prefix and Notification type `mcs_probe`. */
const PROBE_SESSION_PREFIX = "00000000-0000-4000-8000-";
const PROBE_NOTIFICATION_TYPE = "mcs_probe";
/** Keys of `data` that survive in a minimal envelope (02 2.3.4); `calls` is cut to `MINIMAL_CALLS_MAX` entries. */
const MINIMAL_DATA_KEYS = [
	"tool_name",
	"source",
	"reason",
	"notification_type",
	"trigger",
	"error",
	"exit_code",
	"calls"
];

//#endregion
//#region packages/shared/src/protocol/hook-events.ts
/**
* The 21 installed hook events, their sync/async mode, ranks and the per-event field policy (02 2.4, 4.3;
* 98 11.5; ADR 0013). Data only: the handler applies the policy, the installer reads the event list and modes.
*/
/** Order of installation (98 11.5). */
const INSTALLED_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Notification",
	"SubagentStart",
	"SubagentStop",
	"TaskCreated",
	"TaskCompleted",
	"Stop",
	"StopFailure",
	"TeammateIdle",
	"PreCompact",
	"PostCompact",
	"PostModelSwitch",
	"CwdChanged",
	"SessionEnd"
];
const INSTALLED_SET = new Set(INSTALLED_HOOK_EVENTS);
function isInstalledHookEvent(name) {
	return INSTALLED_SET.has(name);
}
const str = (name, maxChars) => ({
	name,
	kind: "string",
	maxChars
});
const int = (name) => ({
	name,
	kind: "int"
});
const bool = (name) => ({
	name,
	kind: "bool"
});
const path = (name) => ({
	name,
	kind: "path",
	maxChars: 1024
});
const NATURAL = (key) => ({
	mode: "natural",
	key
});
const CONTENT = { mode: "content" };
const TOOL_NAMES = [str("tool_name", 128), str("mcp_server_name", 128)];
const DEFAULT_TIMEOUT_S = 5;
const SESSION_END_TIMEOUT_S = 2;
function policy(event, mode, body) {
	return {
		event,
		mode,
		timeoutSeconds: event === "SessionEnd" ? SESSION_END_TIMEOUT_S : DEFAULT_TIMEOUT_S,
		...body
	};
}
const TASK_POLICY = {
	kept: [
		str("task_id", 128),
		str("teammate_name", 64),
		str("team_name", 64)
	],
	summarized: [{
		from: "task_subject",
		into: ["subject_preview"],
		note: "at most 160 code points, redacted"
	}, {
		from: "task_description",
		into: ["description_len"]
	}],
	dropped: ["task_description"],
	dedupe: NATURAL("task_id")
};
const STOP_SUMMARY = [
	{
		from: "last_assistant_message",
		into: ["last_message_len"]
	},
	{
		from: "background_tasks",
		into: ["background_task_count"]
	},
	{
		from: "session_crons",
		into: ["cron_count"]
	}
];
const HOOK_EVENT_POLICY = {
	SessionStart: policy("SessionStart", "sync", {
		kept: [
			str("source", 16),
			str("model", 128),
			int("context_tokens")
		],
		summarized: [{
			from: "session_title",
			into: ["session_title_len"]
		}],
		dropped: [
			"session_title",
			"seconds_since_last_response",
			"prompt_cache_likely_expired",
			"estimated_cache_write_usd"
		],
		dedupe: CONTENT
	}),
	UserPromptSubmit: policy("UserPromptSubmit", "sync", {
		kept: [],
		summarized: [{
			from: "prompt",
			into: ["prompt_len", "prompt_slash"],
			note: "length in code points; slash = the first non-space character is /"
		}, {
			from: "session_title",
			into: ["session_title_len"]
		}],
		dropped: ["prompt", "session_title"],
		dedupe: CONTENT
	}),
	PreToolUse: policy("PreToolUse", "async", {
		kept: TOOL_NAMES,
		summarized: [
			{
				from: "tool_input",
				into: [
					"tool_summary",
					"tool_input_hash",
					"tool_input_bytes",
					"tool_input_keys"
				],
				note: "summary by summarizeToolInput, hash by canonicalJsonHash, keys = top-level names, comma-joined, at most 16"
			},
			{
				from: "tool_input.subagent_type",
				into: ["subagent_type"],
				when: "tool_name = Agent",
				note: "at most 64 chars"
			},
			{
				from: "tool_input.run_in_background",
				into: ["run_in_background"],
				when: "tool_name = Agent"
			},
			{
				from: "tool_input.name",
				into: ["workflow_name"],
				when: "tool_name = Workflow",
				note: "string, at most 128 chars"
			}
		],
		dropped: ["tool_input"],
		dedupe: NATURAL("tool_use_id")
	}),
	PermissionRequest: policy("PermissionRequest", "sync", {
		kept: TOOL_NAMES,
		summarized: [{
			from: "tool_input",
			into: ["tool_summary", "tool_input_hash"]
		}, {
			from: "permission_suggestions",
			into: ["suggestion_count"]
		}],
		dropped: ["tool_input", "permission_suggestions"],
		dedupe: CONTENT
	}),
	PermissionDenied: policy("PermissionDenied", "sync", {
		kept: [str("tool_name", 128)],
		summarized: [{
			from: "reason",
			into: ["reason_preview"],
			note: "at most 160 code points, redacted"
		}],
		dropped: ["tool_input"],
		dedupe: NATURAL("tool_use_id")
	}),
	PostToolUse: policy("PostToolUse", "async", {
		kept: [str("tool_name", 128), int("duration_ms")],
		summarized: [
			{
				from: "tool_response",
				into: ["response_bytes"]
			},
			{
				from: "tool_response.agentId",
				into: ["agent_link_id"],
				when: "tool_name = Agent",
				note: "must match AGENT_RE"
			},
			{
				from: "tool_response.status",
				into: ["agent_status"],
				when: "tool_name = Agent",
				note: "at most 32 chars"
			},
			{
				from: "tool_response.totalTokens",
				into: ["agent_total_tokens"],
				when: "tool_name = Agent",
				note: "informational, never summed"
			},
			{
				from: "tool_response.totalDurationMs",
				into: ["agent_total_duration_ms"],
				when: "tool_name = Agent"
			},
			{
				from: "tool_response.totalToolUseCount",
				into: ["agent_tool_use_count"],
				when: "tool_name = Agent"
			},
			{
				from: "tool_response.runId",
				into: ["run_id"],
				when: "tool_name = Workflow",
				note: "must match RUN_ID_RE"
			},
			{
				from: "tool_response.status",
				into: ["run_status"],
				when: "tool_name = Workflow",
				note: "at most 32 chars"
			},
			{
				from: "tool_response.taskId",
				into: ["task_id"],
				when: "tool_name = Workflow",
				note: "at most 128 chars"
			},
			{
				from: "tool_response.interrupted",
				into: ["interrupted"],
				when: "tool_name = Bash"
			}
		],
		dropped: ["tool_input", "tool_response"],
		dedupe: NATURAL("tool_use_id")
	}),
	PostToolUseFailure: policy("PostToolUseFailure", "async", {
		kept: [
			str("tool_name", 128),
			bool("is_interrupt"),
			int("duration_ms")
		],
		summarized: [{
			from: "error",
			into: ["exit_code", "error_len"],
			note: "exit_code only when the first line matches \"Exit code\" followed by 1 to 5 digits"
		}],
		dropped: ["error", "tool_input"],
		dedupe: NATURAL("tool_use_id")
	}),
	PostToolBatch: policy("PostToolBatch", "async", {
		kept: [],
		summarized: [{
			from: "tool_calls",
			into: ["calls"],
			note: "[{tool_use_id, tool_name}], at most 64, flag data_truncated:calls when cut"
		}],
		dropped: ["tool_input", "tool_response"],
		dedupe: NATURAL("ids_hash")
	}),
	Notification: policy("Notification", "sync", {
		kept: [str("notification_type", 64)],
		summarized: [{
			from: "title",
			into: ["title_preview"],
			note: "at most 80 code points, redacted"
		}, {
			from: "message",
			into: ["message_preview", "message_len"],
			note: "preview at most 160 code points, redacted"
		}],
		dropped: [],
		dedupe: CONTENT
	}),
	SubagentStart: policy("SubagentStart", "sync", {
		kept: [],
		summarized: [],
		dropped: [],
		dedupe: CONTENT
	}),
	SubagentStop: policy("SubagentStop", "sync", {
		kept: [path("agent_transcript_path"), bool("stop_hook_active")],
		summarized: STOP_SUMMARY,
		dropped: ["last_assistant_message"],
		dedupe: CONTENT
	}),
	TaskCreated: policy("TaskCreated", "sync", TASK_POLICY),
	TaskCompleted: policy("TaskCompleted", "sync", TASK_POLICY),
	Stop: policy("Stop", "sync", {
		kept: [bool("stop_hook_active")],
		summarized: STOP_SUMMARY,
		dropped: ["last_assistant_message"],
		dedupe: CONTENT
	}),
	StopFailure: policy("StopFailure", "sync", {
		kept: [str("error", 64)],
		summarized: [{
			from: "error_details",
			into: ["error_preview"],
			note: "at most 160 code points, redacted"
		}, {
			from: "last_assistant_message",
			into: ["last_message_len"]
		}],
		dropped: ["error_details", "last_assistant_message"],
		dedupe: CONTENT
	}),
	TeammateIdle: policy("TeammateIdle", "sync", {
		kept: [str("teammate_name", 64), str("team_name", 64)],
		summarized: [],
		dropped: [],
		dedupe: CONTENT
	}),
	PreCompact: policy("PreCompact", "sync", {
		kept: [str("trigger", 16)],
		summarized: [{
			from: "custom_instructions",
			into: ["custom_instructions_len"]
		}],
		dropped: ["custom_instructions"],
		dedupe: CONTENT
	}),
	PostCompact: policy("PostCompact", "sync", {
		kept: [str("trigger", 16)],
		summarized: [{
			from: "compact_summary",
			into: ["compact_summary_len"]
		}],
		dropped: ["compact_summary"],
		dedupe: CONTENT
	}),
	PostModelSwitch: policy("PostModelSwitch", "sync", {
		kept: [
			str("from_model", 128),
			str("to_model", 128),
			str("requested_model", 128),
			str("source", 32),
			int("context_tokens"),
			bool("prompt_cache_warm"),
			str("cache_ttl", 16)
		],
		summarized: [],
		dropped: ["pricing", "estimated_cache_write_usd"],
		dedupe: CONTENT
	}),
	CwdChanged: policy("CwdChanged", "sync", {
		kept: [path("old_cwd"), path("new_cwd")],
		summarized: [],
		dropped: [],
		dedupe: CONTENT
	}),
	SessionEnd: policy("SessionEnd", "sync", {
		kept: [str("reason", 32)],
		summarized: [],
		dropped: [],
		dedupe: CONTENT
	})
};
/** Any other event name: only the top-level key names are kept (02 2.4 last row). */
const UNKNOWN_HOOK_EVENT_POLICY = {
	kept: [],
	summarized: [{
		from: "*",
		into: ["data_keys"],
		note: "top-level key names, at most 32"
	}],
	dropped: [],
	dedupe: CONTENT
};

//#endregion
//#region packages/shared/src/protocol/sanitize.ts
const BACKSLASH = String.fromCharCode(92);
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pyString(text) {
	let out = "\"";
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		if (c >= 32 && c !== 34 && c !== 92) continue;
		let escape;
		switch (c) {
			case 34:
				escape = "\\\"";
				break;
			case 92:
				escape = "\\\\";
				break;
			case 10:
				escape = "\\n";
				break;
			case 13:
				escape = "\\r";
				break;
			case 9:
				escape = "\\t";
				break;
			case 8:
				escape = "\\b";
				break;
			case 12:
				escape = "\\f";
				break;
			default: escape = "\\u" + c.toString(16).padStart(4, "0");
		}
		out += text.slice(start, i) + escape;
		start = i + 1;
	}
	return out + text.slice(start) + "\"";
}
/**
* Python `repr(float)` for the numbers JSON text can carry. A JavaScript number cannot tell the integer 1 from the float
* 1.0, so an integer-valued number below 1e16 prints as an integer (the common case: counts, ids, timestamps) and one
* from 1e16 up prints as a float, like `1e+22` in the legacy golden.
*/
function pyNumber(n) {
	if (Number.isNaN(n)) return "NaN";
	if (n === Number.POSITIVE_INFINITY) return "Infinity";
	if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
	if (Object.is(n, -0)) return "-0.0";
	if (Number.isInteger(n) && Math.abs(n) < 0x2386f26fc10000) return String(n);
	const [mantissa = "", exponentText = "0"] = n.toExponential().split("e");
	const exponent = Number(exponentText);
	const sign = mantissa.startsWith("-") ? "-" : "";
	const digits = mantissa.replace("-", "").replace(".", "");
	if (exponent >= -4 && exponent < 16) {
		if (exponent >= 0) {
			const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
			const fraction = digits.slice(exponent + 1);
			return sign + whole + "." + (fraction === "" ? "0" : fraction);
		}
		return sign + "0." + "0".repeat(-exponent - 1) + digits;
	}
	return sign + (digits.slice(0, 1) + (digits.length > 1 ? "." + digits.slice(1) : "")) + "e" + (exponent < 0 ? "-" : "+") + String(Math.abs(exponent)).padStart(2, "0");
}
function pyDump(value, stack) {
	if (value === null) return "null";
	switch (typeof value) {
		case "undefined": return "null";
		case "boolean": return value ? "true" : "false";
		case "number": return pyNumber(value);
		case "bigint": return value.toString();
		case "string": return pyString(value);
		case "function":
		case "symbol": throw new TypeError("Object of type " + typeof value + " is not JSON serializable");
	}
	if (stack.includes(value)) throw new TypeError("Circular reference detected");
	stack.push(value);
	try {
		if (Array.isArray(value)) return "[" + value.map((item) => pyDump(item, stack)).join(", ") + "]";
		const parts = [];
		for (const key of Object.keys(value)) {
			const child = Reflect.get(value, key);
			if (child === void 0) continue;
			parts.push(pyString(key) + ": " + pyDump(child, stack));
		}
		return "{" + parts.join(", ") + "}";
	} finally {
		stack.pop();
	}
}
/**
* The compact JSON text of a value in the spaced form that spool summaries persist: the separators `", "` and `": "`,
* non-ASCII kept, insertion key order (02 2.5.1). `undefined` is `null` in a list and absent in an object. Functions and
* symbols throw `TypeError`. Integer-like object keys come out first in JavaScript's own order.
*/
function compactJsonText(value) {
	return pyDump(value, []);
}
/**
* Legacy-compatible clip (02 2.5.1, golden `clip.json`): a non-string is dumped by `compactJsonText` first, the length is
* counted in code points, and a longer text keeps its first `n` code points plus ` ... [truncated K chars]`.
* `n` follows Python slicing, so a negative `n` drops code points from the end.
*/
function clip(value, n) {
	if (!Number.isInteger(n)) throw new RangeError("clip: n must be an integer");
	const text = typeof value === "string" ? value : compactJsonText(value);
	const codePoints = Array.from(text);
	if (codePoints.length <= n) return text;
	return codePoints.slice(0, n).join("") + " ... [truncated " + String(codePoints.length - n) + " chars]";
}
/** Order matters. Each rule that changes the text sets the `redacted` flag (02 2.5.3). */
const REDACTION_RULES = [
	{
		id: "R1",
		re: /\b(authorization|proxy-authorization)\s*[:=]\s*(bearer|basic|token)?\s*[^\s"']+/gi,
		to: "$1: [redacted]"
	},
	{
		id: "R2",
		re: /\b((?=[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential))[A-Za-z0-9_.-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&]+)/gi,
		to: "$1=[redacted]"
	},
	{
		id: "R3",
		re: /(--?(token|password|passwd|secret|api-?key|auth|key)(=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
		to: "$1[redacted]"
	},
	{
		id: "R4",
		re: /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
		to: "[redacted]"
	},
	{
		id: "R5",
		re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
		to: "$1[redacted]@"
	},
	{
		id: "R6",
		re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		to: "[email]"
	},
	{
		id: "R7",
		re: /[A-Za-z0-9+/=_-]{40,}/g,
		to: "[redacted:<length>]"
	}
];
/**
* Hardening beyond R1-R7 (change request CR-WP-04-1): R1 and R2 need the separator right after the field name, so a
* quoted field of a JSON body or a Python dict (`"password":"x"`, `'api_key': 'x'`, nested at any depth in a
* stringified tool input) slips through them. The value of such a field is replaced; the name and quotes stay.
* Applied after R1-R7, idempotent. The keyword is looked up once, ahead of the name, for the reason given at R2.
*/
const QUOTED_SECRET_FIELD = /(["'])((?=[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization))[A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi;
const GIT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Longest text `redact` looks at; the rest is cut (with the clip marker) before any rule runs. */
const REDACT_INPUT_MAX_CP = 4096;
function applyRule(rule, text) {
	if (rule.id === "R7") return text.replace(rule.re, (match) => GIT_ID_RE.test(match) ? match : "[redacted:" + String(match.length) + "]");
	return text.replace(rule.re, rule.to);
}
/**
* `redact` plus whether any rule changed the text (the `redacted` flag of the envelope). The input is clipped to
* 4096 code points first, so the work is bounded.
*/
function redactDetailed(text) {
	let current = clip(text, REDACT_INPUT_MAX_CP);
	let redacted = false;
	for (const rule of REDACTION_RULES) {
		const next = applyRule(rule, current);
		if (next !== current) redacted = true;
		current = next;
	}
	const quoted = current.replace(QUOTED_SECRET_FIELD, "$1$2$1$3\"[redacted]\"");
	if (quoted !== current) redacted = true;
	return {
		text: quoted,
		redacted
	};
}
/** Legacy keys first (CS:C.2), then the keys added by this design. */
const SUMMARY_KEYS = [
	"command",
	"file_path",
	"pattern",
	"description",
	"prompt",
	"script",
	"url",
	"query",
	"path",
	"notebook_path",
	"skill",
	"subject"
];
/** Python truthiness: an empty list or object is falsy (JavaScript calls it truthy). */
function pyTruthy(value) {
	if (value === null || value === void 0 || value === false || value === 0 || value === "") return false;
	if (typeof value === "number" && Number.isNaN(value)) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (isRecord$2(value)) return Object.keys(value).length > 0;
	return true;
}
/** `JSON.stringify` returns `undefined` for a value that has no JSON form; its typing hides that. */
function stringifyJson(value) {
	return JSON.stringify(value);
}
/** `summarizeToolInput` plus the `redacted` flag. */
function summarizeToolInputDetailed(input) {
	if (!isRecord$2(input)) return {
		text: "",
		redacted: false
	};
	let key;
	for (const name of SUMMARY_KEYS) {
		const candidate = Reflect.get(input, name);
		if (pyTruthy(candidate)) {
			key = candidate;
			break;
		}
	}
	if (key === void 0) return {
		text: "",
		redacted: false
	};
	const redacted = redactDetailed((typeof key === "string" ? key : stringifyJson(key) ?? "").split("\n")[0] ?? "");
	return {
		text: clip(redacted.text, 160),
		redacted: redacted.redacted
	};
}
const SHA256_K = new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
/** UTF-8 bytes of a JavaScript string; a lone surrogate becomes U+FFFD, as the platform's own UTF-8 encoder does. */
function utf8Bytes(text) {
	const out = new Uint8Array(text.length * 3);
	let n = 0;
	for (let i = 0; i < text.length; i += 1) {
		let c = text.charCodeAt(i);
		if (c < 128) {
			out[n] = c;
			n += 1;
			continue;
		}
		if (c >= 55296 && c <= 56319) {
			const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (next >= 56320 && next <= 57343) {
				c = 65536 + (c - 55296 << 10) + (next - 56320);
				i += 1;
			} else c = 65533;
		} else if (c >= 56320 && c <= 57343) c = 65533;
		if (c < 2048) {
			out[n] = 192 | c >> 6;
			out[n + 1] = 128 | c & 63;
			n += 2;
		} else if (c < 65536) {
			out[n] = 224 | c >> 12;
			out[n + 1] = 128 | c >> 6 & 63;
			out[n + 2] = 128 | c & 63;
			n += 3;
		} else {
			out[n] = 240 | c >> 18;
			out[n + 1] = 128 | c >> 12 & 63;
			out[n + 2] = 128 | c >> 6 & 63;
			out[n + 3] = 128 | c & 63;
			n += 4;
		}
	}
	return out.subarray(0, n);
}
function rotr(x, n) {
	return x >>> n | x << 32 - n;
}
function sha256Hex(message) {
	const length = message.length;
	const paddedLength = length + 9 + 63 >> 6 << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(message);
	padded[length] = 128;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(length / 536870912), false);
	view.setUint32(paddedLength - 4, length << 3 >>> 0, false);
	const h = new Uint32Array([
		1779033703,
		3144134277,
		1013904242,
		2773480762,
		1359893119,
		2600822924,
		528734635,
		1541459225
	]);
	const w = /* @__PURE__ */ new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4, false);
		for (let t = 16; t < 64; t += 1) {
			const w15 = w[t - 15] ?? 0;
			const w2 = w[t - 2] ?? 0;
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ w15 >>> 3;
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ w2 >>> 10;
			w[t] = (w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1 | 0;
		}
		let a = h[0] ?? 0;
		let b = h[1] ?? 0;
		let c = h[2] ?? 0;
		let d = h[3] ?? 0;
		let e = h[4] ?? 0;
		let f = h[5] ?? 0;
		let g = h[6] ?? 0;
		let hh = h[7] ?? 0;
		for (let t = 0; t < 64; t += 1) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const choose = e & f ^ ~e & g;
			const t1 = hh + s1 + choose + (SHA256_K[t] ?? 0) + (w[t] ?? 0) | 0;
			const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
			hh = g;
			g = f;
			f = e;
			e = d + t1 | 0;
			d = c;
			c = b;
			b = a;
			a = t1 + t2 | 0;
		}
		h[0] = (h[0] ?? 0) + a;
		h[1] = (h[1] ?? 0) + b;
		h[2] = (h[2] ?? 0) + c;
		h[3] = (h[3] ?? 0) + d;
		h[4] = (h[4] ?? 0) + e;
		h[5] = (h[5] ?? 0) + f;
		h[6] = (h[6] ?? 0) + g;
		h[7] = (h[7] ?? 0) + hh;
	}
	let hex = "";
	for (const word of h) hex += word.toString(16).padStart(8, "0");
	return hex;
}
/** `undefined` means "leave out" (an undefined, function or symbol value of an object). */
function canonicalJson(value, stack) {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean": return value ? "true" : "false";
		case "number": return Number.isFinite(value) ? JSON.stringify(value) : "null";
		case "string": return JSON.stringify(value);
		case "bigint": throw new TypeError("canonicalJsonHash: a bigint is not JSON");
		case "undefined":
		case "function":
		case "symbol": return;
	}
	if (stack.includes(value)) throw new TypeError("canonicalJsonHash: circular reference");
	stack.push(value);
	try {
		if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, stack) ?? "null").join(",") + "]";
		const parts = [];
		for (const key of Object.keys(value).sort()) {
			const child = canonicalJson(Reflect.get(value, key), stack);
			if (child !== void 0) parts.push(JSON.stringify(key) + ":" + child);
		}
		return "{" + parts.join(",") + "}";
	} finally {
		stack.pop();
	}
}
/**
* First 32 hex characters of the SHA-256 of the JSON text of `value` with object keys sorted recursively (02 2.5.4).
* Correlates a PermissionRequest with its PreToolUse (`tool_input_hash`) and names a batch (`ids_hash`).
*/
function canonicalJsonHash(value) {
	return sha256Hex(utf8Bytes(canonicalJson(value, []) ?? "null")).slice(0, 32);
}
/** True on a Windows host; false elsewhere and in a browser. The one place this package reads the platform. */
function hostIsWin32() {
	if (typeof process === "undefined") return false;
	return process.platform === "win32";
}
/**
* Backslashes become `/`, repeated `/` collapse (a leading `//` stays, for UNC), a trailing `/` goes. The root of a
* drive (`C:/`) and of the file system (`/`, `//`) keep their slash. Case is kept (02 2.5.4).
*/
function normalizePath(path) {
	const slashed = path.split(BACKSLASH).join("/");
	let lead = 0;
	while (lead < slashed.length && slashed[lead] === "/") lead += 1;
	const prefix = lead === 0 ? "" : lead === 2 ? "//" : "/";
	let body = slashed.slice(lead).replace(/\/{2,}/g, "/");
	if (body.endsWith("/")) {
		body = body.slice(0, -1);
		if (/^[A-Za-z]:$/.test(body)) body += "/";
	}
	return prefix + body;
}
/** `normalizePath`, lowercased on Windows (case-insensitive file system). Pass `win32` to override the host. */
function routeKey(path, win32 = hostIsWin32()) {
	const normalized = normalizePath(path);
	return win32 ? normalized.toLowerCase() : normalized;
}

//#endregion
//#region packages/shared/src/protocol/routes.ts
/**
* Routing of hook events to instances and the per-user `MCS_HOME` folder (02 2.6; ADR 0011).
*
* Zod-free so the handler and the engine share it (98 1.7, N8). The zod mirror of `HookRouteV1` is
* `HookRouteV1Schema` in `schemas/ingest.ts`.
*/
/**
* Project folder name Claude Code derives from a launch directory: every character outside `[A-Za-z0-9]` becomes `-`
* (TS:1, `docs/research/transcript-survey.md`). Counted per UTF-16 unit, as the JavaScript original does.
*/
function sanitizeProjectName(directory) {
	return directory.replace(/[^A-Za-z0-9]/g, "-");
}
/** Directory part of an already normalized path; '' when there is none, the root keeps its slash. */
function dirnameOf(normalized) {
	const slash = normalized.lastIndexOf("/");
	if (slash < 0) return "";
	if (slash === 0) return "/";
	const dir = normalized.slice(0, slash);
	return /^[A-Za-z]:$/.test(dir) ? dir + "/" : dir;
}
function lastSegment(normalized) {
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}
/**
* Why `route` takes this event, or `null` when it does not (02 2.6.2). All of these must hold: version 1, enabled,
* `spoolDir` and `stateFile` inside the workspace, running or inside its spool window (`now < spoolUntil`), and one
* of: the folder of `transcript_path` is a known transcripts folder; the session id is pinned; or, without a
* `transcript_path`, the sanitized `cwd` names a known transcripts folder (case-insensitive).
*/
function matchRoute(route, ids, now, options = {}) {
	const untrusted = route;
	if (untrusted.v !== 1 || untrusted.enabled !== true) return null;
	if (route.spoolDir !== route.workspace + "/data/spool" || route.stateFile !== route.workspace + "/state.json") return null;
	if (route.stoppedAt !== null && !(route.spoolUntil !== null && now < route.spoolUntil)) return null;
	const win32 = options.win32 ?? hostIsWin32();
	if (ids.transcript_path !== null) {
		const folder = routeKey(dirnameOf(normalizePath(ids.transcript_path)), win32);
		if (route.match.transcriptsDirs.includes(folder)) return "transcript";
	}
	if (ids.session_id !== null && route.match.sessionIds.includes(ids.session_id)) return "session_pin";
	if (ids.transcript_path === null && ids.cwd !== null && ids.cwd !== "") {
		const project = sanitizeProjectName(normalizePath(ids.cwd)).toLowerCase();
		if (project !== "" && route.match.transcriptsDirs.some((dir) => lastSegment(dir).toLowerCase() === project)) return "cwd";
	}
	return null;
}
function isAbsolutePath(path, win32) {
	if (win32) return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
	return path.startsWith("/");
}
function stripTrailingSeparators(path) {
	let end = path.length;
	while (end > 1 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
	const stripped = path.slice(0, end);
	return /^[A-Za-z]:$/.test(stripped) ? stripped + path.slice(end, end + 1) : stripped;
}
/**
* The per-user monitor folder (02 2.6.1): `MCS_HOME` if it is absolute; else on Windows `%LOCALAPPDATA%/mcs`
* (fallback `<home>/AppData/Local/mcs`); else `${XDG_STATE_HOME:-<home>/.local/state}/mcs`. A relative value of any of
* the variables is ignored (the handler must never write below its working directory). Throws when no home can be
* found.
*/
function resolveMcsHome(env, options = {}) {
	const win32 = options.win32 ?? hostIsWin32();
	const explicit = env["MCS_HOME"];
	if (explicit !== void 0 && explicit !== "" && isAbsolutePath(explicit, win32)) return stripTrailingSeparators(explicit);
	const home = () => {
		const found = options.homedir ?? (win32 ? env["USERPROFILE"] ?? env["HOME"] : env["HOME"]);
		if (found === void 0 || found === "") throw new Error("resolveMcsHome: no home directory (set MCS_HOME)");
		return stripTrailingSeparators(found);
	};
	if (win32) {
		const local = env["LOCALAPPDATA"];
		if (local !== void 0 && local !== "" && isAbsolutePath(local, true)) return stripTrailingSeparators(local) + "/mcs";
		return home() + "/AppData/Local/mcs";
	}
	const state = env["XDG_STATE_HOME"];
	if (state !== void 0 && state !== "" && isAbsolutePath(state, false)) return stripTrailingSeparators(state) + "/mcs";
	return home() + "/.local/state/mcs";
}

//#endregion
//#region packages/cli/src/hook/handler-log.ts
/** The file is renamed to `hook-handler.1.jsonl` (replacing the old one) before an append that would pass this size. */
const HANDLER_LOG_MAX_BYTES = 1048576;
const HANDLER_LOG_DETAIL_MAX = 120;
const FIRST_PRINTABLE = 32;
const LAST_PRINTABLE = 126;
/** Printable ASCII only, cut to 120 characters. */
function cleanDetail(text) {
	let out = "";
	for (let i = 0; i < text.length && out.length < 120; i += 1) {
		const code = text.charCodeAt(i);
		out += code >= FIRST_PRINTABLE && code <= LAST_PRINTABLE ? text.charAt(i) : "?";
	}
	return out;
}
function handlerLogLine(entry, now, pid) {
	const line = {
		at: now,
		code: entry.code,
		event: cleanDetail(entry.event).slice(0, 64),
		instanceId: entry.instanceId,
		pid,
		detail: cleanDetail(entry.detail ?? "")
	};
	return JSON.stringify(line) + String.fromCharCode(10);
}
/** Appends one line to `<mcsHome>/logs/hook-handler.jsonl`; `mcsHome === null` (no home found) and every I/O error are ignored. */
function logHandler(mcsHome, entry, now = Date.now(), pid = process.pid) {
	if (mcsHome === null) return;
	try {
		const dir = `${mcsHome}/logs`;
		const file = `${dir}/hook-handler.jsonl`;
		mkdirSync(dir, { recursive: true });
		try {
			if (statSync(file).size >= 1048576) renameSync(file, `${dir}/hook-handler.1.jsonl`);
		} catch {}
		appendFileSync(file, handlerLogLine(entry, now, pid));
	} catch {}
}

//#endregion
//#region packages/cli/src/hook/routes-reader.ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TRANSCRIPT_DIRS = 8;
const MAX_SESSION_IDS = 256;
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringList(value, max) {
	if (!Array.isArray(value) || value.length > max) return null;
	const list = value;
	return list.every((item) => typeof item === "string") ? list : null;
}
function timestampOrNull(value) {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/** The route in `text`, or `null` when it is not a version 1 route file named `<instanceId>.json`. */
function parseRoute(text, fileName) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord$1(raw) || raw["v"] !== 1) return null;
	const { instanceId, workspace, spoolDir, stateFile, enabled, match, updatedAt } = raw;
	if (typeof instanceId !== "string" || !UUID_RE.test(instanceId) || fileName !== `${instanceId}.json`) return null;
	if (typeof workspace !== "string" || typeof spoolDir !== "string" || typeof stateFile !== "string") return null;
	if (workspace === "" || typeof enabled !== "boolean" || !isRecord$1(match)) return null;
	const transcriptsDirs = stringList(match["transcriptsDirs"], MAX_TRANSCRIPT_DIRS);
	const sessionIds = stringList(match["sessionIds"], MAX_SESSION_IDS);
	const stoppedAt = timestampOrNull(raw["stoppedAt"]);
	const spoolUntil = timestampOrNull(raw["spoolUntil"]);
	if (transcriptsDirs === null || sessionIds === null) return null;
	if (stoppedAt === void 0 || spoolUntil === void 0) return null;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
	return {
		v: 1,
		instanceId,
		workspace,
		spoolDir,
		stateFile,
		enabled,
		match: {
			transcriptsDirs,
			sessionIds
		},
		stoppedAt,
		spoolUntil,
		updatedAt
	};
}
/** Reads at most `maxBytes + 1` bytes: more than `maxBytes` means the file is too large. */
function readBounded(path, maxBytes) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		let filled = 0;
		while (filled < buffer.length) {
			const n = readSync(fd, buffer, filled, buffer.length - filled, null);
			if (n === 0) break;
			filled += n;
		}
		return filled > maxBytes ? null : buffer.subarray(0, filled);
	} finally {
		closeSync(fd);
	}
}
function loadRoute(path, name) {
	try {
		const bytes = readBounded(path, ROUTE_FILE_MAX_BYTES);
		return bytes === null ? null : parseRoute(bytes.toString("utf8"), name);
	} catch {
		return null;
	}
}
/**
* Every valid route file of `<mcsHome>/routes` (at most `ROUTES_MAX_FILES`, in name order, each at most 16 KiB). A missing
* folder is silence; an unreadable folder or an invalid file is reported through `onProblem` and skipped.
*/
function readRoutes(mcsHome, onProblem) {
	const dir = `${mcsHome}/routes`;
	let names;
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().slice(0, 64);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : void 0;
		if (code !== "ENOENT") onProblem({
			code: "ROUTES_UNREADABLE",
			detail: typeof code === "string" ? code : "readdir"
		});
		return [];
	}
	const routes = [];
	for (const name of names) {
		const route = loadRoute(`${dir}/${name}`, name);
		if (route === null) onProblem({
			code: "ROUTE_INVALID",
			detail: name
		});
		else routes.push(route);
	}
	return routes;
}

//#endregion
//#region packages/cli/src/hook/nudge.ts
const STATE_FILE_MAX_BYTES = 4096;
const NUDGE_PATH = "/api/v3/ingest/nudge";
/**
* The server to nudge for a route: only a running route (`stoppedAt === null`) whose `state.json` (at most 4 KiB) names
* this instance, `engine: "node"` and a port in 1..65535. `null` for anything else, including unreadable files.
*/
function readNudgeTarget(route) {
	if (route.stoppedAt !== null) return null;
	try {
		const bytes = readBounded(route.stateFile, STATE_FILE_MAX_BYTES);
		if (bytes === null) return null;
		const state = JSON.parse(bytes.toString("utf8"));
		if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
		const port = Reflect.get(state, "port");
		if (Reflect.get(state, "instanceId") !== route.instanceId || Reflect.get(state, "engine") !== "node") return null;
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
		return {
			instanceId: route.instanceId,
			port
		};
	} catch {
		return null;
	}
}
/**
* One POST. Resolves on the first of: response headers, request flushed (`finish`), `error`, `timeoutMs`. Never rejects.
* The request is not destroyed on a flush: the bytes are already with the operating system, and closing early could cost them.
*/
function nudge(target, timeoutMs = 300) {
	return new Promise((resolve) => {
		const body = JSON.stringify({ instanceId: target.instanceId });
		let timer;
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			resolve();
		};
		try {
			const req = request({
				host: "127.0.0.1",
				port: target.port,
				method: "POST",
				path: NUDGE_PATH,
				agent: false,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body)
				}
			});
			timer = setTimeout(() => {
				settle();
				req.destroy();
			}, timeoutMs);
			req.on("response", (res) => {
				res.resume();
				settle();
			});
			req.on("finish", settle);
			req.on("error", settle);
			req.end(body);
		} catch {
			settle();
		}
	});
}
/** Every target in parallel; resolves when all have settled (each within `timeoutMs`). */
async function nudgeAll(targets, timeoutMs = 300) {
	await Promise.all(targets.map((target) => nudge(target, timeoutMs)));
}

//#endregion
//#region packages/cli/src/hook/spool-writer.ts
/** The same envelope with only the keys of `MINIMAL_DATA_KEYS` (`calls` cut to 16 entries) and the flag `minimal`. */
function minimalEnvelope(envelope) {
	const data = {};
	for (const key of MINIMAL_DATA_KEYS) {
		const value = envelope.data[key];
		if (value === void 0) continue;
		data[key] = key === "calls" && Array.isArray(value) ? value.slice(0, 16) : value;
	}
	const flags = envelope.flags.includes("minimal") ? envelope.flags : [...envelope.flags, "minimal"];
	return {
		...envelope,
		flags,
		data
	};
}
const LF = String.fromCharCode(10);
function encode(envelope) {
	return Buffer.from(JSON.stringify(envelope) + LF, "utf8");
}
/** The full line, or the minimal one when `forceMinimal` or the full line is over `ENVELOPE_MAX_BYTES` (newline included). */
function encodeLine(envelope, forceMinimal) {
	if (!forceMinimal) {
		const full = encode(envelope);
		if (full.length <= 16384) return full;
	}
	return encode(minimalEnvelope(envelope));
}
function errorCode(error) {
	const code = error instanceof Error && "code" in error ? error.code : void 0;
	return typeof code === "string" ? code : "ERROR";
}
/** Creates `<workspace>/data/spool` when the workspace itself still exists (a deleted instance is never re-created). */
function ensureSpoolDir(route) {
	try {
		if (!statSync(route.workspace).isDirectory()) return false;
		mkdirSync(route.spoolDir, { recursive: true });
		return true;
	} catch {
		return false;
	}
}
function openSegment(route, segment) {
	try {
		return openSync(segment, "a");
	} catch (error) {
		if (errorCode(error) !== "ENOENT" || !ensureSpoolDir(route)) throw error;
		return openSync(segment, "a");
	}
}
/**
* Writes the envelope for `route` into the segment of the UTC hour of `received_at`. A segment at the hard cap is left
* alone (`full`); at the soft cap the line is the minimal envelope. Errors never escape.
*/
function appendEnvelope(route, envelope) {
	let fd = null;
	try {
		fd = openSegment(route, `${route.spoolDir}/${spoolSegmentName(envelope.received_at)}`);
		const size = fstatSync(fd).size;
		if (size >= 268435456) return {
			outcome: "full",
			detail: "hard cap"
		};
		const line = encodeLine(envelope, size >= SPOOL_SEGMENT_SOFT_CAP);
		return writeSync(fd, line) === line.length ? {
			outcome: "written",
			detail: ""
		} : {
			outcome: "failed",
			detail: "short write"
		};
	} catch (error) {
		return {
			outcome: "failed",
			detail: errorCode(error)
		};
	} finally {
		if (fd !== null) try {
			closeSync(fd);
		} catch {}
	}
}

//#endregion
//#region packages/cli/src/hook/main.ts
const MAX_FLAGS = 32;
const MAX_UNKNOWN_KEYS = 32;
const MAX_CALLS = 64;
const MAX_TOOL_INPUT_KEYS = 16;
/** Source text handed to `redactDetailed`: previews are far shorter, so a longer body is cut before the work starts. */
const PREVIEW_SOURCE_MAX_UNITS = 8192;
const EXIT_CODE_RE = /^Exit code ([0-9]{1,5})$/;
const CLAUDE_PID_RE = /^[0-9]{1,10}$/;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseArgv(argv) {
	const at = argv.indexOf("--mcs-hook");
	const next = at < 0 ? void 0 : argv[at + 1];
	return {
		hookMode: at >= 0,
		event: next !== void 0 && EVENT_NAME_RE.test(next) ? next : "",
		async: argv.includes("--async")
	};
}
/** Reads `stream` to its end, keeping at most `maxBytes`. Resolves on end, close or error: the caller never blocks on it. */
function readStdin(stream, maxBytes) {
	return new Promise((resolve) => {
		const chunks = [];
		let kept = 0;
		let total = 0;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve({
				kept: Buffer.concat(chunks),
				total
			});
		};
		stream.on("data", (chunk) => {
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			total += buffer.length;
			if (kept < maxBytes) {
				const part = buffer.subarray(0, maxBytes - kept);
				chunks.push(part);
				kept += part.length;
			}
		});
		stream.on("end", finish);
		stream.on("close", finish);
		stream.on("error", finish);
	});
}
function hasControlCharacter(text) {
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code < 32 || code === 127) return true;
	}
	return false;
}
/** `[value, valid]`: `null` and a missing field are `null` and valid; anything else that fails the check is `null` and invalid. */
function checked(value, accept) {
	if (value === void 0 || value === null) return [null, true];
	if (typeof value !== "string") return [null, false];
	const accepted = accept(value);
	return accepted === null ? [null, false] : [accepted, true];
}
const byPattern = (re) => (text) => re.test(text) ? text : null;
const asName = (text) => text.length <= 64 && !hasControlCharacter(text) ? text : null;
const asPath = (text) => {
	const normalized = normalizePath(text);
	return normalized !== "" && normalized.length <= 1024 ? normalized : null;
};
/** The routing and correlation ids of a payload; a field that fails its check is `null` and adds `invalid_<field>`. */
function extractIds(payload) {
	const flags = [];
	const pick = (field, accept) => {
		const [value, valid] = checked(payload[field], accept);
		if (!valid) flags.push(`invalid_${field}`);
		return value;
	};
	return {
		ids: {
			session_id: pick("session_id", byPattern(SID_RE)),
			transcript_path: pick("transcript_path", asPath),
			cwd: pick("cwd", asPath),
			prompt_id: pick("prompt_id", byPattern(TOOL_ID_RE)),
			agent_id: pick("agent_id", byPattern(AGENT_RE)),
			agent_type: pick("agent_type", asName),
			tool_use_id: pick("tool_use_id", byPattern(TOOL_ID_RE)),
			permission_mode: pick("permission_mode", asName)
		},
		flags
	};
}
/** Code points of `text` without building an array (a prompt can be megabytes). */
function codePointLength(text) {
	let count = text.length;
	for (let i = 1; i < text.length; i += 1) {
		const high = text.charCodeAt(i - 1);
		const low = text.charCodeAt(i);
		if (high >= 55296 && high <= 56319 && low >= 56320 && low <= 57343) {
			count -= 1;
			i += 1;
		}
	}
	return count;
}
function cutUnits(text, max) {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 55296 && last <= 56319 ? cut.slice(0, -1) : cut;
}
function keptValue(field, value) {
	switch (field.kind) {
		case "string": return typeof value === "string" ? cutUnits(value, field.maxChars ?? 64) : void 0;
		case "path": {
			if (typeof value !== "string") return void 0;
			const normalized = normalizePath(value);
			return normalized === "" ? void 0 : cutUnits(normalized, field.maxChars ?? 1024);
		}
		case "int": return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
		case "bool": return typeof value === "boolean" ? value : void 0;
	}
}
function intOrUndefined(value) {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
}
function shortString(value, max) {
	return typeof value === "string" ? cutUnits(value, max) : void 0;
}
function jsonBytes(value) {
	if (typeof value === "string") return Buffer.byteLength(value);
	return Buffer.byteLength(JSON.stringify(value));
}
/** `undefined` values are not stored. */
function put(data, key, value) {
	if (value !== void 0) data[key] = value;
}
function preview(value, max, flags) {
	if (typeof value !== "string") return void 0;
	const { text, redacted } = redactDetailed(cutUnits(value, PREVIEW_SOURCE_MAX_UNITS));
	if (redacted) flags.add("redacted");
	return clip(text, max);
}
function lengthOf(value) {
	return typeof value === "string" ? codePointLength(value) : void 0;
}
function countOf(value) {
	return Array.isArray(value) ? value.length : void 0;
}
function toolInput(payload, data, flags, withBytes) {
	const input = payload["tool_input"];
	if (input === void 0) return;
	const summary = summarizeToolInputDetailed(input);
	if (summary.redacted) flags.add("redacted");
	data["tool_summary"] = summary.text;
	data["tool_input_hash"] = canonicalJsonHash(input);
	if (!withBytes) return;
	data["tool_input_bytes"] = jsonBytes(input);
	data["tool_input_keys"] = isRecord(input) ? Object.keys(input).slice(0, MAX_TOOL_INPUT_KEYS).join(",") : "";
}
function preToolUse(payload, data, flags) {
	toolInput(payload, data, flags, true);
	const input = payload["tool_input"];
	if (!isRecord(input)) return;
	const tool = payload["tool_name"];
	if (tool === "Agent") {
		put(data, "subagent_type", shortString(input["subagent_type"], 64));
		const background = input["run_in_background"];
		if (typeof background === "boolean") data["run_in_background"] = background;
	} else if (tool === "Workflow") put(data, "workflow_name", shortString(input["name"], 128));
}
function postToolUse(payload, data) {
	const response = payload["tool_response"];
	if (response !== void 0) data["response_bytes"] = jsonBytes(response);
	const tool = payload["tool_name"];
	if (!isRecord(response)) return;
	if (tool === "Agent") {
		const agentId = response["agentId"];
		if (typeof agentId === "string" && AGENT_RE.test(agentId)) data["agent_link_id"] = agentId;
		put(data, "agent_status", shortString(response["status"], 32));
		put(data, "agent_total_tokens", intOrUndefined(response["totalTokens"]));
		put(data, "agent_total_duration_ms", intOrUndefined(response["totalDurationMs"]));
		put(data, "agent_tool_use_count", intOrUndefined(response["totalToolUseCount"]));
	} else if (tool === "Workflow") {
		const runId = response["runId"];
		if (typeof runId === "string" && RUN_ID_RE.test(runId)) data["run_id"] = runId;
		put(data, "run_status", shortString(response["status"], 32));
		put(data, "task_id", shortString(response["taskId"], 128));
	} else if (tool === "Bash") {
		const interrupted = response["interrupted"];
		if (typeof interrupted === "boolean") data["interrupted"] = interrupted;
	}
}
function toolFailure(payload, data) {
	const error = payload["error"];
	if (typeof error !== "string") return;
	const firstLine = error.split(String.fromCharCode(10), 1)[0] ?? "";
	const code = EXIT_CODE_RE.exec(firstLine.endsWith(String.fromCharCode(13)) ? firstLine.slice(0, -1) : firstLine);
	if (code?.[1] !== void 0) data["exit_code"] = Number(code[1]);
	data["error_len"] = codePointLength(error);
}
function toolBatch(payload, data, flags) {
	const calls = payload["tool_calls"];
	if (!Array.isArray(calls)) return;
	const list = calls;
	data["calls"] = list.slice(0, MAX_CALLS).map((call) => {
		const record = isRecord(call) ? call : {};
		const id = record["tool_use_id"];
		return {
			tool_use_id: typeof id === "string" && TOOL_ID_RE.test(id) ? id : null,
			tool_name: shortString(record["tool_name"], 128) ?? null
		};
	});
	if (list.length > MAX_CALLS) flags.add("data_truncated:calls");
}
function stopSummary(payload, data) {
	put(data, "last_message_len", lengthOf(payload["last_assistant_message"]));
	put(data, "background_task_count", countOf(payload["background_tasks"]));
	put(data, "cron_count", countOf(payload["session_crons"]));
}
function summarize(event, payload, data, flags) {
	switch (event) {
		case "SessionStart":
			put(data, "session_title_len", lengthOf(payload["session_title"]));
			return;
		case "UserPromptSubmit": {
			const prompt = payload["prompt"];
			if (typeof prompt === "string") {
				data["prompt_len"] = codePointLength(prompt);
				data["prompt_slash"] = prompt.trimStart().startsWith("/");
			}
			put(data, "session_title_len", lengthOf(payload["session_title"]));
			return;
		}
		case "PreToolUse":
			preToolUse(payload, data, flags);
			return;
		case "PermissionRequest":
			toolInput(payload, data, flags, false);
			put(data, "suggestion_count", countOf(payload["permission_suggestions"]));
			return;
		case "PermissionDenied":
			put(data, "reason_preview", preview(payload["reason"], 160, flags));
			return;
		case "PostToolUse":
			postToolUse(payload, data);
			return;
		case "PostToolUseFailure":
			toolFailure(payload, data);
			return;
		case "PostToolBatch":
			toolBatch(payload, data, flags);
			return;
		case "Notification":
			put(data, "title_preview", preview(payload["title"], 80, flags));
			put(data, "message_preview", preview(payload["message"], 160, flags));
			put(data, "message_len", lengthOf(payload["message"]));
			return;
		case "SubagentStop":
		case "Stop":
			stopSummary(payload, data);
			return;
		case "TaskCreated":
		case "TaskCompleted":
			put(data, "subject_preview", preview(payload["task_subject"], 160, flags));
			put(data, "description_len", lengthOf(payload["task_description"]));
			return;
		case "StopFailure":
			put(data, "error_preview", preview(payload["error_details"], 160, flags));
			put(data, "last_message_len", lengthOf(payload["last_assistant_message"]));
			return;
		case "PreCompact":
			put(data, "custom_instructions_len", lengthOf(payload["custom_instructions"]));
			return;
		case "PostCompact":
			put(data, "compact_summary_len", lengthOf(payload["compact_summary"]));
			return;
		default: return;
	}
}
/**
* The `data` of an envelope (02 2.4): the kept fields of the event verbatim and capped, the derived values of the summarized
* ones, nothing else. A name that is not an installed event keeps only the top-level key names. Every free-text body is
* dropped; previews pass through `redact()`. Returns the flags it raised (`redacted`, `data_truncated:<field>`).
*/
function sanitizeEventData(event, payload) {
	const data = {};
	const flags = /* @__PURE__ */ new Set();
	const policy = isInstalledHookEvent(event) ? HOOK_EVENT_POLICY[event] : UNKNOWN_HOOK_EVENT_POLICY;
	for (const field of policy.kept) put(data, field.name, keptValue(field, payload[field.name]));
	if (isInstalledHookEvent(event)) summarize(event, payload, data, flags);
	else {
		const names = Object.keys(payload);
		data["data_keys"] = names.slice(0, MAX_UNKNOWN_KEYS).map((name) => cutUnits(name, 64)).join(",");
		if (names.length > MAX_UNKNOWN_KEYS) flags.add("data_truncated:data_keys");
	}
	const effort = payload["effort"];
	if (isRecord(effort)) put(data, "effort_level", shortString(effort["level"], 16));
	return {
		data,
		flags: [...flags]
	};
}
const VIA_FLAG = {
	session_pin: "routed_by_session_pin",
	cwd: "routed_by_cwd"
};
/** The envelope for one matched route: the shared fields, `instance_id`, and the `routed_by_*` flag of how it matched. */
function buildEnvelope(base, instanceId, via) {
	const flags = [...base.flags];
	if (via !== "transcript") flags.push(VIA_FLAG[via]);
	return {
		v: 1,
		kind: base.kind,
		instance_id: instanceId,
		event_uid: base.eventUid,
		received_at: base.receivedAt,
		event: base.event,
		argv_event: base.argvEvent,
		...base.ids,
		claude_pid: base.claudePid,
		payload_bytes: base.payloadBytes,
		content_hash: base.contentHash,
		handler: base.handler,
		flags: [...new Set(flags)].slice(0, MAX_FLAGS),
		data: base.data
	};
}
function parsePayload(bytes) {
	try {
		const parsed = JSON.parse(bytes.toString("utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function isProbe(ids, event, payload) {
	return ids.session_id?.startsWith("00000000-0000-4000-8000-") === true && event === "Notification" && payload["notification_type"] === "mcs_probe";
}
/**
* Steps 2-13 of 02 2.2 without the process-level parts (timers, exit): returns when the handler is done. Never throws for
* input reasons; an unexpected error propagates to `runHook`, which logs `UNCAUGHT` and exits 0.
*/
async function handleHook(argv, deps) {
	const t0 = deps.now();
	const args = parseArgv(argv);
	if (!args.hookMode) return;
	if (deps.env["MCS_HOOK_DISABLE"] === "1") {
		if (!deps.stdinIsTty) await deps.readStdin(0);
		return;
	}
	if (deps.stdinIsTty) return;
	const stdin = await deps.readStdin(STDIN_MAX_BYTES);
	let mcsHome;
	try {
		mcsHome = resolveMcsHome(deps.env);
	} catch {
		return;
	}
	const log = (code, detail, instanceId = null, event = args.event) => {
		logHandler(mcsHome, {
			code,
			event,
			instanceId,
			detail
		}, deps.now(), deps.pid);
	};
	const routes = readRoutes(mcsHome, (problem) => {
		log(problem.code, problem.detail);
	});
	if (routes.length === 0) return;
	const payload = parsePayload(stdin.kept);
	if (payload === null) {
		log("STDIN_PARSE_ERROR", "");
		return;
	}
	const { ids, flags: idFlags } = extractIds(payload);
	const matched = [];
	for (const route of routes) {
		const via = matchRoute(route, ids, t0);
		if (via !== null) matched.push({
			route,
			via
		});
	}
	if (matched.length === 0) return;
	const named = payload["hook_event_name"];
	const event = typeof named === "string" && EVENT_NAME_RE.test(named) ? named : args.event !== "" ? args.event : "Unknown";
	const flags = [...stdin.total > 8388608 ? ["stdin_truncated"] : [], ...idFlags];
	if (args.event !== "" && event !== args.event) flags.push("event_mismatch");
	let sanitized;
	try {
		sanitized = sanitizeEventData(event, payload);
	} catch (error) {
		log("UNCAUGHT", `sanitize: ${error instanceof Error ? error.name : "unknown"}`, void 0, event);
		sanitized = {
			data: {},
			flags: ["data_truncated:data"]
		};
	}
	flags.push(...sanitized.flags);
	const pidText = deps.env["CLAUDE_PID"];
	const base = {
		kind: isProbe(ids, event, payload) ? "probe" : "hook",
		eventUid: randomUUID(),
		receivedAt: t0,
		event,
		argvEvent: args.event,
		ids,
		claudePid: pidText !== void 0 && CLAUDE_PID_RE.test(pidText) ? Number(pidText) : null,
		payloadBytes: stdin.total,
		contentHash: createHash("sha256").update(stdin.kept).digest("hex").slice(0, 32),
		handler: {
			version: HANDLER_VERSION,
			pid: deps.pid,
			async: args.async
		},
		flags,
		data: sanitized.data
	};
	const targets = [];
	for (const { route, via } of matched) {
		const result = appendEnvelope(route, buildEnvelope(base, route.instanceId, via));
		if (result.outcome === "full") log("SPOOL_FULL", result.detail, route.instanceId, event);
		else if (result.outcome === "failed") log("SPOOL_WRITE_FAILED", result.detail, route.instanceId, event);
		const target = readNudgeTarget(route);
		if (target !== null) targets.push(target);
	}
	await nudgeAll(targets);
}
/** `process.stdin.isTTY` is undefined (not false) for a pipe or a file, and reading `process.stdin` can throw without a stdin. */
function isTerminal() {
	try {
		return Reflect.get(process.stdin, "isTTY") === true;
	} catch {
		return false;
	}
}
function errorName(error) {
	return error instanceof Error ? error.name : typeof error;
}
/**
* The handler entry (02 2.2): arms the hard exit, handles every error, and exits 0 when done. It prints nothing, ever.
* `argv` is the argument list after the script name.
*/
async function runHook(argv) {
	const remaining = Math.max(200, HANDLER_HARD_EXIT_MS - performance.now());
	setTimeout(() => process.exit(0), remaining).unref();
	const eventName = parseArgv(argv).event;
	const fatal = (error) => {
		try {
			logHandler(resolveMcsHome(process.env), {
				code: "UNCAUGHT",
				event: eventName,
				instanceId: null,
				detail: errorName(error)
			});
		} finally {
			process.exit(0);
		}
	};
	process.on("uncaughtException", fatal);
	process.on("unhandledRejection", fatal);
	try {
		await handleHook(argv, {
			env: process.env,
			now: Date.now,
			pid: process.pid,
			stdinIsTty: isTerminal(),
			readStdin: (maxBytes) => readStdin(process.stdin, maxBytes)
		});
	} catch (error) {
		fatal(error);
	}
	process.exit(0);
}

//#endregion
//#region packages/cli/src/hook.ts
function isMainModule() {
	try {
		const entry = process.argv[1];
		return entry !== void 0 && pathToFileURL(realpathSync(entry)).href === import.meta.url;
	} catch {
		return false;
	}
}
if (isMainModule()) {
	const argv = process.argv.slice(2);
	if (!argv.includes("--mcs-hook") && argv.includes("--version")) writeSync(1, `${HANDLER_VERSION}\n`);
	else runHook(argv);
}

//#endregion
export { HANDLER_VERSION, runHook };