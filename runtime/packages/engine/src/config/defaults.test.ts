import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { layoutOfModule } from '../platform/layout.ts';
import { toPlain } from '../json/index.ts';
import {
  checkSchemaVersion,
  defaultRuntimeDir,
  defaultSkillDir,
  loadSkillDefaults,
  parseLegacyConfig,
  readConfigJson,
  readOptionalConfigJson,
  schemaVersionOf,
  SKILL_FOLDER_NAME,
  skillDirOfRuntimeDir,
} from './defaults.ts';
import { LEGACY_KEYS } from './validate-legacy.ts';

const makeTemp = useTempDirs();

async function failure(run: () => unknown): Promise<McsError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof McsError) return e;
    throw e;
  }
  throw new Error('expected McsError');
}

function skillWith(files: Record<string, string>): string {
  const dir = makeTemp('cfg-defaults').path;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

describe('the shipped files', () => {
  it('defaultSkillDir is the skill folder that holds config/defaults.json and runtime/defaults.json', () => {
    const skill = defaultSkillDir();
    expect(path.basename(skill)).toBe(SKILL_FOLDER_NAME);
    expect(path.basename(path.dirname(skill))).toBe('skills');
    expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toContain(`name: ${SKILL_FOLDER_NAME}`);
    expect(readFileSync(path.join(skill, 'config', 'defaults.json'), 'utf8')).toContain('"schema_version": 1');
  });

  it('defaultRuntimeDir is the runtime workspace next to the skills folder', () => {
    const runtime = defaultRuntimeDir();
    expect(readFileSync(path.join(runtime, 'package.json'), 'utf8')).toContain('"@mcs/runtime"');
    expect(path.dirname(runtime)).toBe(path.dirname(path.dirname(defaultSkillDir())));
  });

  it('both defaults come from the layout resolver (source layout in a checkout)', () => {
    const layout = layoutOfModule(import.meta.url);
    expect(layout.mode).toBe('source');
    expect(defaultRuntimeDir()).toBe(layout.runtimeDir);
    expect(defaultSkillDir()).toBe(layout.skillDir);
  });

  it('skillDirOfRuntimeDir maps the checkout runtime to the skill folder and any other runtime to its parent', () => {
    expect(skillDirOfRuntimeDir(defaultRuntimeDir())).toBe(defaultSkillDir());
    const other = makeTemp('cfg-runtime-parent').path;
    expect(skillDirOfRuntimeDir(path.join(other, 'runtime'))).toBe(other);
  });

  it('<skill>/runtime/defaults.json is exactly {"schema_version": 1}', () => {
    const text = readFileSync(path.join(defaultSkillDir(), 'runtime', 'defaults.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ schema_version: 1 });
  });

  it('loadSkillDefaults reads the 22 L keys of config/defaults.json and drops underscore keys', async () => {
    const skill = defaultSkillDir();
    const loaded = await loadSkillDefaults(skill);
    expect(loaded.path).toBe(path.join(skill, 'config', 'defaults.json'));
    const plain = toPlain(loaded.doc);
    expect(Object.keys(plain as object)).toEqual([...LEGACY_KEYS]);
    const raw: unknown = JSON.parse(readFileSync(loaded.path, 'utf8'));
    expect(raw).toHaveProperty('_comment');
    expect(plain).toEqual(Object.fromEntries(Object.entries(raw as object).filter(([k]) => !k.startsWith('_'))));
  });

  it('the shipped defaults parse into the typed LegacyConfig', async () => {
    const loaded = await loadSkillDefaults(defaultSkillDir());
    const cfg = parseLegacyConfig(toPlain(loaded.doc));
    expect(cfg.port).toBe(8765);
    expect(cfg.title).toBe('Claude sessions monitor');
    expect(cfg.panels['git']).toBe(true);
    expect(cfg.ui.theme).toBe('auto');
    expect(cfg.ui.newest_first).toBe(true);
    expect(cfg.poll['events_ms']).toBe(1500);
    expect(cfg.limits['event_window_mb']).toBe(8);
    expect(cfg.attempts).toBeNull();
    expect(cfg.session_rules).toEqual([]);
    expect(cfg.watched_processes).toHaveLength(9);
  });
});

describe('loadSkillDefaults failures', () => {
  it('reports a missing file as CONFIG_UNREADABLE with the legacy wording', async () => {
    const skill = skillWith({});
    const e = await failure(() => loadSkillDefaults(skill));
    expect(e.code).toBe('CONFIG_UNREADABLE');
    expect(e.message.startsWith(`cannot read shared defaults ${path.join(skill, 'config', 'defaults.json')}: `)).toBe(
      true,
    );
  });

  it('reports invalid JSON and a non-object the same way', async () => {
    for (const text of ['{"a": ', '[1]', '"x"']) {
      const skill = skillWith({ 'config/defaults.json': text });
      const e = await failure(() => loadSkillDefaults(skill));
      expect(e.code, text).toBe('CONFIG_UNREADABLE');
      expect(e.message, text).toContain('cannot read shared defaults');
    }
  });
});

describe('readConfigJson', () => {
  it('returns the parsed object with Python integer and float lexemes kept', async () => {
    const skill = skillWith({ 'a.json': '{"n": 1, "f": 1.0, "s": "x"}' });
    const doc = await readConfigJson(path.join(skill, 'a.json'));
    expect(doc.v.map(([k, v]) => `${k}:${v.k}`)).toEqual(['n:int', 'f:float', 's:str']);
  });

  it('a missing file is CONFIG_UNREADABLE "cannot read <path>: <reason>"', async () => {
    const skill = skillWith({});
    const file = path.join(skill, 'none.json');
    const e = await failure(() => readConfigJson(file));
    expect(e.code).toBe('CONFIG_UNREADABLE');
    expect(e.message.startsWith(`cannot read ${file}: `)).toBe(true);
  });

  it('readOptionalConfigJson returns null for a missing file only', async () => {
    const skill = skillWith({ 'bad.json': '{' });
    expect(await readOptionalConfigJson(path.join(skill, 'none.json'))).toBeNull();
    const e = await failure(() => readOptionalConfigJson(path.join(skill, 'bad.json')));
    expect(e.code).toBe('CONFIG_INVALID');
  });

  it('invalid JSON is CONFIG_INVALID with the Python decoder message', async () => {
    const skill = skillWith({ 'a.json': '{"a": 1,}', 'b.json': '', 'c.json': '{"a" 1}' });
    const a = await failure(() => readConfigJson(path.join(skill, 'a.json')));
    expect(a.code).toBe('CONFIG_INVALID');
    expect(a.message).toBe(
      `${path.join(skill, 'a.json')} is not valid JSON: Illegal trailing comma before end of object: line 1 column 8 (char 7)`,
    );
    const b = await failure(() => readConfigJson(path.join(skill, 'b.json')));
    expect(b.message).toBe(
      `${path.join(skill, 'b.json')} is not valid JSON: Expecting value: line 1 column 1 (char 0)`,
    );
    const c = await failure(() => readConfigJson(path.join(skill, 'c.json')));
    expect(c.message).toContain("Expecting ':' delimiter");
  });

  it('a BOM, invalid UTF-8 and a non-object are CONFIG_INVALID', async () => {
    const dir = makeTemp('cfg-bytes').path;
    writeFileSync(path.join(dir, 'bom.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
    writeFileSync(path.join(dir, 'bad.json'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    writeFileSync(path.join(dir, 'arr.json'), '[1]');
    const bom = await failure(() => readConfigJson(path.join(dir, 'bom.json')));
    expect(bom.code).toBe('CONFIG_INVALID');
    expect(bom.message).toContain('is not valid JSON: Unexpected UTF-8 BOM');
    const bad = await failure(() => readConfigJson(path.join(dir, 'bad.json')));
    expect(bad.code).toBe('CONFIG_INVALID');
    expect(bad.message).toContain('is not valid JSON: ');
    const arr = await failure(() => readConfigJson(path.join(dir, 'arr.json')));
    expect(arr.code).toBe('CONFIG_INVALID');
    expect(arr.message).toBe(`${path.join(dir, 'arr.json')} must contain a JSON object`);
  });
});

describe('schemaVersionOf and checkSchemaVersion (the gate of 01 2.6)', () => {
  async function doc(text: string) {
    const skill = skillWith({ 'f.json': text });
    return { value: await readConfigJson(path.join(skill, 'f.json')), where: path.join(skill, 'f.json') };
  }

  it('reads the version as a number, or null when absent or not a number', async () => {
    expect(schemaVersionOf((await doc('{"schema_version": 1}')).value)).toBe(1);
    expect(schemaVersionOf((await doc('{"schema_version": 7}')).value)).toBe(7);
    expect(schemaVersionOf((await doc('{}')).value)).toBeNull();
    expect(schemaVersionOf((await doc('{"schema_version": null}')).value)).toBeNull();
    expect(schemaVersionOf((await doc('{"schema_version": "1"}')).value)).toBeNull();
    expect(schemaVersionOf((await doc('{"schema_version": 1.0}')).value)).toBe(1);
  });

  it('accepts version 1, and (like Python 1 == True, 1 == 1.0) true and 1.0, leaving the type check to validation', async () => {
    for (const v of ['1', '1.0', 'true']) {
      const d = await doc(`{"schema_version": ${v}}`);
      expect(() => {
        checkSchemaVersion(d.value, d.where, 'config.json');
      }).not.toThrow();
    }
  });

  it('refuses a missing version with the legacy text (CONFIG_SCHEMA_MISSING), null counts as missing', async () => {
    for (const text of ['{}', '{"schema_version": null}']) {
      const d = await doc(text);
      const e = await failure(() => {
        checkSchemaVersion(d.value, d.where, 'config.json');
      });
      expect(e.code).toBe('CONFIG_SCHEMA_MISSING');
      expect(e.message).toBe(
        `${d.where} has no schema_version; refusing to guess (add "schema_version": 1 after checking the keys against reference/configuration.md in the skill folder)`,
      );
    }
  });

  it('refuses an unsupported version with the legacy text (CONFIG_SCHEMA_UNSUPPORTED)', async () => {
    const cases: [string, string][] = [
      ['2', '2'],
      ['0', '0'],
      ['2.5', '2.5'],
      ['"1"', '1'],
      ['false', 'False'],
      ['99999999999999999999', '99999999999999999999'],
    ];
    for (const [json, shown] of cases) {
      const d = await doc(`{"schema_version": ${json}}`);
      const e = await failure(() => {
        checkSchemaVersion(d.value, d.where, 'config.json');
      });
      expect(e.code, json).toBe('CONFIG_SCHEMA_UNSUPPORTED');
      expect(e.message, json).toBe(
        `${d.where} uses schema_version ${shown} but this skill supports [1]; update the skill or migrate the file explicitly`,
      );
    }
  });

  it('runtime.json uses the same texts and names mcs config migrate in the hint', async () => {
    const d = await doc('{"schema_version": 3}');
    const e = await failure(() => {
      checkSchemaVersion(d.value, d.where, 'runtime.json');
    });
    expect(e.code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
    expect(e.message).toBe(
      `${d.where} uses schema_version 3 but this skill supports [1]; update the skill or migrate the file explicitly`,
    );
    expect(e.hint).toContain('mcs config migrate');
    const m = await doc('{}');
    const missing = await failure(() => {
      checkSchemaVersion(m.value, m.where, 'runtime.json');
    });
    expect(missing.code).toBe('CONFIG_SCHEMA_MISSING');
    expect(missing.message).toContain('has no schema_version; refusing to guess');
  });
});

describe('parseLegacyConfig', () => {
  it('rejects a document that does not have the legacy shape (a defaults file that was edited wrongly)', () => {
    expect(() => parseLegacyConfig({ title: 5 })).toThrow(McsError);
    expect(() => parseLegacyConfig([])).toThrow(McsError);
  });
});
