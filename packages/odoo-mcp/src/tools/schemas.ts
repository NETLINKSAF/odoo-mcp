import { z } from 'zod';

// Threat-model US-5 AC-9 (extended to all tools as defense-in-depth):
// Reject model names with characters that could escape Odoo's expected dotted_snake_case.
const MODEL_NAME = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_.]*$/, 'model must match /^[a-z][a-z0-9_.]*$/');

// Reject method/action names with characters beyond safe snake_case identifiers.
const METHOD_NAME = z
  .string()
  .min(1)
  .regex(/^[a-z_][a-z0-9_]*$/, 'method must match /^[a-z_][a-z0-9_]*$/');

const companyContext = {
  allowed_company_ids: z.array(z.number().int().positive()).optional(),
  active_company_id: z.number().int().positive().optional(),
};

export const searchReadSchema = z.object({
  model: MODEL_NAME,
  domain: z.array(z.unknown()).default([]),
  fields: z.array(z.string()).default([]),
  limit: z.number().int().positive().default(80),
  offset: z.number().int().nonnegative().default(0),
  order: z.string().optional(),
  ...companyContext,
});

export type SearchReadInput = z.infer<typeof searchReadSchema>;

export const readSchema = z.object({
  model: MODEL_NAME,
  ids: z.array(z.number().int().positive()).min(1),
  fields: z.array(z.string()).default([]),
  ...companyContext,
});

export type ReadInput = z.infer<typeof readSchema>;

export const createSchema = z.object({
  model: MODEL_NAME,
  values: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]),
  ...companyContext,
});

export type CreateInput = z.infer<typeof createSchema>;

export const writeSchema = z.object({
  model: MODEL_NAME,
  ids: z.array(z.number().int().positive()).min(1),
  values: z.record(z.unknown()),
  ...companyContext,
});

export type WriteInput = z.infer<typeof writeSchema>;

export const unlinkSchema = z.object({
  model: MODEL_NAME,
  ids: z.array(z.number().int().positive()).min(1),
  ...companyContext,
});

export type UnlinkInput = z.infer<typeof unlinkSchema>;

export const searchCountSchema = z.object({
  model: MODEL_NAME,
  domain: z.array(z.unknown()).default([]),
  ...companyContext,
});

export type SearchCountInput = z.infer<typeof searchCountSchema>;

export const executeSchema = z.object({
  model: MODEL_NAME,
  method: METHOD_NAME,
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
  model: MODEL_NAME,
  ids: z.array(z.number().int().positive()).min(1),
  action_name: METHOD_NAME,
  context: z.record(z.unknown()).optional(),
  ...companyContext,
});

export type CallActionInput = z.infer<typeof callActionSchema>;

export const fieldsGetSchema = z.object({
  model: MODEL_NAME,
  attributes: z.array(z.string()).optional(),
  ...companyContext,
});

export type FieldsGetInput = z.infer<typeof fieldsGetSchema>;
