// Exactness analysis of a parsed pattern (design 01 section 2.8, "Rejected" table, row INEXACT_SEMANTICS).
//
// The translator accepts a pattern only when JavaScript and Python give the same answer. Beyond the rules of the design
// table (a capture that an iteration can skip, IGNORECASE with non-ASCII text, handled while parsing), the engines
// differ in four more situations that this pass refuses: a loop whose body can match the empty string (Python stops at
// the first empty iteration, JavaScript backtracks into the body), a backreference to a group that may not have taken
// part in the match (Python fails, JavaScript matches the empty string), and captures or backreferences inside a
// lookbehind (JavaScript evaluates its body backwards).
import { PyRegexFailure, type Node } from './ast.ts';
import { widthOf } from './parser.ts';

type Width = readonly [number, number];

function refuse(message: string, pos: number): PyRegexFailure {
  return new PyRegexFailure('INEXACT_SEMANTICS', message, pos);
}

function isPrefix(prefix: readonly number[], of: readonly number[]): boolean {
  if (prefix.length > of.length) return false;
  return prefix.every((id, index) => of[index] === id);
}

class Analyzer {
  private readonly widths: (Width | null)[];
  private readonly groupScopes = new Map<number, number[]>();
  /** Ids of the conditional scopes around the node being visited: alternation branches, `min == 0` loops, negative lookarounds. */
  private readonly cond: number[] = [];
  /** Loops that can iterate more than once, with the depth of `cond` inside their own scope. */
  private readonly loops: { condLength: number }[] = [];
  private nextId = 0;
  private lookbehindDepth = 0;

  constructor(groupCount: number) {
    this.widths = Array.from({ length: groupCount + 1 }, () => null);
  }

  private scope<T>(push: boolean, run: () => T): T {
    if (push) this.cond.push(this.nextId++);
    try {
      return run();
    } finally {
      if (push) this.cond.pop();
    }
  }

  visit(node: Node): void {
    switch (node.t) {
      case 'lit':
      case 'any':
      case 'at':
      case 'set':
      case 'cat':
        return;
      case 'seq':
        for (const item of node.items) this.visit(item);
        return;
      case 'alt':
        for (const alt of node.alts) {
          this.scope(true, () => {
            this.visit(alt);
          });
        }
        return;
      case 'group':
        if (node.index !== null) this.visitCapture(node.index, node.pos);
        this.visit(node.body);
        if (node.index !== null) this.widths[node.index] = widthOf(node.body, this.widths);
        return;
      case 'rep': {
        const multi = node.max === null || node.max > 1;
        this.scope(node.min === 0, () => {
          if (multi) this.loops.push({ condLength: this.cond.length });
          this.visit(node.body);
          if (multi) this.loops.pop();
        });
        const [lowest] = widthOf(node.body, this.widths);
        if (lowest === 0 && (multi || (node.min === 0 && node.max === 1))) {
          throw refuse(
            'a repeated group that can match the empty string: Python and JavaScript treat an empty iteration differently',
            node.pos,
          );
        }
        return;
      }
      case 'look':
        this.scope(node.neg, () => {
          if (node.behind) this.lookbehindDepth += 1;
          this.visit(node.body);
          if (node.behind) this.lookbehindDepth -= 1;
        });
        return;
      case 'backref':
        this.visitBackreference(node.index, node.pos);
        return;
    }
  }

  private visitCapture(index: number, pos: number): void {
    if (this.lookbehindDepth > 0) {
      throw refuse('a capture group inside a lookbehind: JavaScript matches the body backwards', pos);
    }
    for (const loop of this.loops) {
      if (this.cond.length > loop.condLength) {
        throw refuse(
          'a capture group inside a repeated group that an iteration can skip: Python keeps the previous iteration, JavaScript resets it',
          pos,
        );
      }
    }
    this.groupScopes.set(index, this.cond.slice());
  }

  private visitBackreference(index: number, pos: number): void {
    if (this.lookbehindDepth > 0) {
      throw refuse('a backreference inside a lookbehind: JavaScript matches the body backwards', pos);
    }
    const scopes = this.groupScopes.get(index);
    if (scopes === undefined || !isPrefix(scopes, this.cond)) {
      throw refuse(
        'a backreference to a group that may not have taken part in the match: Python fails where JavaScript matches the empty string',
        pos,
      );
    }
  }
}

/** Throws `PyRegexFailure('INEXACT_SEMANTICS', ...)` for a pattern whose JavaScript translation could differ from Python. */
export function checkExactness(root: Node, groupCount: number): void {
  new Analyzer(groupCount).visit(root);
}
