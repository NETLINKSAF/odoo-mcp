import { z } from 'zod';

const companyContext = {
  allowed_company_ids: z.array(z.number().int().positive()).optional(),
  active_company_id: z.number().int().positive().optional(),
};

export const searchReadSchema = z.object({
  model: z.string().min(1),
  domain: z.array(z.unknown()).default([]),
  fields: z.array(z.string()).default([]),
  limit: z.number().int().positive().default(80),
  offset: z.number().int().nonnegative().default(0),
  order: z.string().optional(),
  ...companyContext,
});

export type SearchReadInput = z.infer<typeof searchReadSchema>;

export const readSchema = z.object({
  model: z.string().min(1),
  ids: z.array(z.number().int().positive()).min(1),
  fields: z.array(z.string()).default([]),
  ...companyContext,
});

export type ReadInput = z.infer<typeof readSchema>;

export const createSchema = z.object({
  model: z.string().min(1),
  values: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]),
  ...companyContext,
});

export type CreateInput = z.infer<typeof createSchema>;

export const writeSchema = z.object({
  model: z.string().min(1),
  ids: z.array(z.number().int().positive()).min(1),
  values: z.record(z.unknown()),
  ...companyContext,
});

export type WriteInput = z.infer<typeof writeSchema>;

export const unlinkSchema = z.object({
  model: z.string().min(1),
  ids: z.array(z.number().int().positive()).min(1),
  ...companyContext,
});

export type UnlinkInput = z.infer<typeof unlinkSchema>;

export const searchCountSchema = z.object({
  model: z.string().min(1),
  domain: z.array(z.unknown()).default([]),
  ...companyContext,
});

export type SearchCountInput = z.infer<typeof searchCountSchema>;

export const executeSchema = z.object({
  model: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown()).default([]),
  kwargs: z.record(z.unknown()).default({}),
  ...companyContext,
});

export type ExecuteInput = z.infer<typeof executeSchema>;

export const runReportSchema = z.object({
  report_id: z.union([z.number().int().positive(), z.string().min(1)]),
  doc_ids: z.array(z.number().int().positive()).min(1),
  ...companyContext,
});

export type RunReportInput = z.infer<typeof runReportSchema>;

export const callActionSchema = z.object({
  model: z.string().min(1),
  ids: z.array(z.number().int().positive()).min(1),
  action_name: z.string().min(1),
  context: z.record(z.unknown()).optional(),
  ...companyContext,
});

export type CallActionInput = z.infer<typeof callActionSchema>;

export const fieldsGetSchema = z.object({
  model: z.string().min(1),
  attributes: z.array(z.string()).optional(),
  ...companyContext,
});

export type FieldsGetInput = z.infer<typeof fieldsGetSchema>;
