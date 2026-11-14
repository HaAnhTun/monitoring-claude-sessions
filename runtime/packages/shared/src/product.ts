// The product's name and the name of its command line, in one place (07 section 5.1). Code that prints a hint, a fix line
// or a usage text spells the command through `CLI_NAME`, never as a literal.

/** The product's display name. */
export const PRODUCT_NAME = 'Claude Agent Workspace';

// The command line name is typed `string`, not the literal `'mcs'`, so that changing the value later is one line and no
// literal type breaks a comparison (neither a type assertion nor an annotation on the literal passes the lint rules).
const COMMAND: { readonly cli: string } = { cli: 'mcs' };

/** The command line name. */
export const CLI_NAME = COMMAND.cli;

/** The other name the launcher answers to. */
export const CLI_ALIAS = 'mcs';
