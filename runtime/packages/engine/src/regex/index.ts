// The configuration regex dialect (ADR 0067): JavaScript `v`-mode patterns, one compiler for rules and attempts.
export type { CompiledRegex, RegexContext, RegexMatch } from './types.ts';
export {
  PYTHON_SYNTAX_HINT,
  RegexCompileError,
  compileRegex,
  pythonSyntaxHint,
  tryCompileRegex,
  type TryCompileResult,
} from './compile.ts';
export { applyLabelTemplate } from './label.ts';
