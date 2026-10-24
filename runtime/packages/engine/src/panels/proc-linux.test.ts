import { describe, expect, it } from 'vitest';

import { parseProcStatus, readLinuxProcesses, type ProcFs } from './proc-linux.ts';

const status = (name: string, rssKb: number | null): string =>
  [
    `Name:\t${name}`,
    'Umask:\t0022',
    'State:\tS (sleeping)',
    'Tgid:\t1',
    ...(rssKb === null ? [] : [`VmRSS:\t${String(rssKb).padStart(8, ' ')} kB`]),
    'Threads:\t1',
  ].join('\n') + '\n';

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** An injected `/proc`: pid -> files; a value that is an Error is thrown when that file is read. */
function fakeProc(tree: Record<string, Record<string, string | Error>>, extraEntries: string[] = []) {
  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fs: ProcFs = {
    readdir: (dir) => {
      expect(dir).toBe('/proc');
      return Promise.resolve([...Object.keys(tree), ...extraEntries]);
    },
    readFile: async (file) => {
      reads.push(file);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      const match = /^\/proc\/([^/]+)\/([^/]+)$/.exec(file);
      const entry = match?.[1] === undefined ? undefined : tree[match[1]];
      const content = match?.[2] === undefined ? undefined : entry?.[match[2]];
      if (content === undefined) throw errno('ENOENT');
      if (content instanceof Error) throw content;
      return content;
    },
  };
  return { fs, reads, maxInFlight: () => maxInFlight };
}

describe('parseProcStatus', () => {
  it('reads Name and VmRSS (kB to bytes)', () => {
    expect(parseProcStatus(status('node', 20_480))).toEqual({ name: 'node', rssBytes: 20_480 * 1024 });
  });

  it('keeps spaces in a name and tolerates CRLF', () => {
    expect(parseProcStatus('Name:\tTabs Server\r\nVmRSS:\t 10 kB\r\n')).toEqual({
      name: 'Tabs Server',
      rssBytes: 10 * 1024,
    });
  });

  it('has no rss for a kernel thread and no result without a name', () => {
    expect(parseProcStatus(status('kworker/0:1', null))).toEqual({ name: 'kworker/0:1', rssBytes: null });
    expect(parseProcStatus('VmRSS:\t 10 kB\n')).toBeNull();
    expect(parseProcStatus('')).toBeNull();
  });

  it('ignores a malformed VmRSS', () => {
    expect(parseProcStatus('Name:\tx\nVmRSS:\tlots kB\n')).toEqual({ name: 'x', rssBytes: null });
    expect(parseProcStatus('Name:\tx\nVmRSS:\t-5 kB\n')).toEqual({ name: 'x', rssBytes: null });
  });

  it('does not take VmRSS lookalikes such as RssAnon', () => {
    expect(parseProcStatus('Name:\tx\nRssAnon:\t 99 kB\n')).toEqual({ name: 'x', rssBytes: null });
  });
});

describe('readLinuxProcesses', () => {
  it('lists name and rss of numeric entries and skips the rest of /proc', async () => {
    const { fs } = fakeProc(
      {
        '1': { status: status('init', 100) },
        '42': { status: status('node', 2000) },
      },
      ['self', 'cpuinfo', 'thread-self', '0', '12x'],
    );
    expect(await readLinuxProcesses(fs)).toEqual([
      { name: 'init', workingSetBytes: 100 * 1024 },
      { name: 'node', workingSetBytes: 2000 * 1024 },
    ]);
  });

  it('skips a kernel thread without VmRSS', async () => {
    const { fs } = fakeProc({ '2': { status: status('kthreadd', null) }, '3': { status: status('sh', 4) } });
    expect(await readLinuxProcesses(fs)).toEqual([{ name: 'sh', workingSetBytes: 4 * 1024 }]);
  });

  it('skips a pid that vanishes between readdir and read, and one that is not readable', async () => {
    const { fs } = fakeProc({
      '10': {},
      '11': { status: errno('ESRCH') },
      '12': { status: errno('EACCES') },
      '13': { status: status('ok', 1) },
    });
    expect(await readLinuxProcesses(fs)).toEqual([{ name: 'ok', workingSetBytes: 1024 }]);
  });

  it('widens a 15 character name from the first argument of cmdline', async () => {
    const { fs, reads } = fakeProc({
      '20': {
        status: status('com.docker.back', 500),
        cmdline: '/Applications/Docker/com.docker.backend\0--flag\0value\0',
      },
      '21': { status: status('node', 500), cmdline: 'node\0server.js\0' },
    });
    expect(await readLinuxProcesses(fs)).toEqual([
      { name: 'com.docker.backend', workingSetBytes: 500 * 1024 },
      { name: 'node', workingSetBytes: 500 * 1024 },
    ]);
    // cmdline is read for the truncated name only
    expect(reads.filter((f) => f.endsWith('/cmdline'))).toEqual(['/proc/20/cmdline']);
  });

  it('keeps a 15 character name when cmdline is empty, unreadable or does not extend it', async () => {
    const { fs } = fakeProc({
      '30': { status: status('abcdefghijklmno', 1), cmdline: '' },
      '31': { status: status('abcdefghijklmno', 1), cmdline: errno('EACCES') },
      '32': { status: status('abcdefghijklmno', 1), cmdline: '/usr/bin/other-program\0' },
      '33': { status: status('abcdefghijklmno', 1), cmdline: 'abcdefghijklmno\0' },
    });
    const names = (await readLinuxProcesses(fs)).map((p) => p.name);
    expect(names).toEqual(Array<string>(4).fill('abcdefghijklmno'));
  });

  it('reads 5,000 pids with a bounded number of reads in flight', async () => {
    const tree: Record<string, Record<string, string>> = {};
    for (let pid = 1; pid <= 5000; pid += 1) tree[String(pid)] = { status: status(`p${String(pid)}`, pid) };
    const { fs, maxInFlight } = fakeProc(tree);
    const list = await readLinuxProcesses(fs);
    expect(list).toHaveLength(5000);
    expect(list[4999]).toEqual({ name: 'p5000', workingSetBytes: 5000 * 1024 });
    expect(maxInFlight()).toBeLessThanOrEqual(64);
    expect(maxInFlight()).toBeGreaterThan(1);
  });

  it('stops reading when the signal is aborted', async () => {
    const tree: Record<string, Record<string, string>> = {};
    for (let pid = 1; pid <= 1000; pid += 1) tree[String(pid)] = { status: status('p', 1) };
    const { fs, reads } = fakeProc(tree);
    const controller = new AbortController();
    controller.abort();
    await expect(readLinuxProcesses(fs, controller.signal)).rejects.toThrow(/abort/i);
    expect(reads).toHaveLength(0);
  });

  it('rejects when /proc itself cannot be listed', async () => {
    const fs: ProcFs = {
      readdir: () => Promise.reject(errno('ENOENT')),
      readFile: () => Promise.reject(errno('ENOENT')),
    };
    await expect(readLinuxProcesses(fs)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
