// `board` section: declared work items for the board (02 section 7.11; 04 S-8 `tasks[]` is renamed `board.items`).
// 02 states the item shape without bounds; the length and count limits below are chosen by 01 to keep the file sane.
import { z } from 'zod';

import { type KeySpec, sectionSchema } from './section.ts';

const text = z.string().min(1).max(500);
const textList = z.array(text).max(1000);

export const BoardItemSchema = z.strictObject({
  key: text,
  title: text,
  match: z.strictObject({
    labels: textList.optional(),
    labelPrefix: text.optional(),
    sessionIds: textList.optional(),
    attemptParts: textList.optional(),
  }),
});

export type BoardItem = z.infer<typeof BoardItemSchema>;

const items: KeySpec<z.ZodArray<typeof BoardItemSchema>> = { schema: z.array(BoardItemSchema).max(1000), default: [] };

export const BoardSectionKeys = { items };

export const BoardSectionSchema = sectionSchema(BoardSectionKeys);
