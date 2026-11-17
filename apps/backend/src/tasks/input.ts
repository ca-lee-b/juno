import { z } from "zod";

export const taskInputSchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .refine((v) => v !== "." && v !== ".."),
    issueNumber: z.number().int().positive(),
  })
  .strict();

export type TaskInput = z.infer<typeof taskInputSchema>;
