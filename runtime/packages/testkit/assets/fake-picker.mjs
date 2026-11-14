// The fake folder picker of the testkit (design 08, section 2.7). It stands in for the PowerShell and WinForms dialog that the
// server starts to let a person choose a folder: the server resolves the picker command through a configuration key, a test
// points that key at `node fake-picker.mjs`. One self-contained ES module, Node built-ins only. It ignores its arguments.
//
// FAKE_PICKER_RESULT decides what happens:
//   a path       prints it and one line break, exits 0 (the person chose a folder)
//   empty/unset  prints nothing, exits 0 (the person cancelled)
//   !error       exits 1 with junk on stderr and nothing on stdout (the dialog failed)
//   !hang        never exits (a dialog nobody answers); a line on stderr says it started
//   !junk        exits 0 after printing several lines, a path with a NUL and a line of 100 KB
//   !unc         prints a UNC path of another machine (the server must refuse it)
// Any other value, including an unknown `!` word, is printed as a path.

const result = process.env['FAKE_PICKER_RESULT'] ?? '';
const JUNK_LINE_BYTES = 100 * 1024;

if (result === '') {
  process.exit(0);
} else if (result === '!error') {
  process.stderr.write('FAKE-PICKER: the dialog failed\n');
  process.stderr.write(`Exception calling "ShowDialog": ${'#'.repeat(512)}\n`);
  process.exit(1);
} else if (result === '!hang') {
  process.stderr.write('FAKE-PICKER: hang\n');
  // A timer keeps the event loop alive for good; the harness kills the process.
  setInterval(() => undefined, 2 ** 30);
} else if (result === '!junk') {
  const lines = [
    'FAKE-PICKER: first line of junk',
    'C:\\FIXTURE-junk\\with\0nul',
    '   ',
    'x'.repeat(JUNK_LINE_BYTES),
    'FAKE-PICKER: last line of junk',
  ];
  process.stdout.write(`${lines.join('\n')}\n`, () => {
    process.exit(0);
  });
} else if (result === '!unc') {
  process.stdout.write('\\\\attacker\\share\n', () => {
    process.exit(0);
  });
} else {
  process.stdout.write(`${result}\n`, () => {
    process.exit(0);
  });
}
