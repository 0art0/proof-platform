import { z } from "zod";

export const todoStatusSchema = z.enum([
  "planned",
  "ready",
  "in_progress",
  "waiting",
  "blocked",
  "done",
  "cancelled",
]);

export const taskStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "verifying",
  "reviewing",
  "rework",
  "retry_wait",
  "needs_input",
  "awaiting_approval",
  "ready_to_integrate",
  "integrating",
  "needs_resolution",
  "blocked_dependency",
  "failed",
  "cancelled",
  "integrated",
]);

export const messageStatusSchema = z.enum([
  "pending",
  "running",
  "retry_wait",
  "needs_input",
  "completed",
  "failed",
]);

export type TodoNode = Readonly<{
  id: string;
  title: string;
  status: z.infer<typeof todoStatusSchema>;
  taskId: string | null;
  children: readonly TodoNode[];
}>;

export const todoNodeSchema: z.ZodType<TodoNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      status: todoStatusSchema,
      taskId: z.string().min(1).nullable(),
      children: z.array(todoNodeSchema),
    })
    .strict(),
);

export const taskSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: taskStatusSchema,
    attempt: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    todoPath: z.array(z.string()),
    dependencies: z.array(z.string().min(1)),
    summary: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const statusResponseSchema = z
  .object({
    todo: todoNodeSchema,
    tasks: z.array(taskSummarySchema),
  })
  .strict();

const rawMessageSchema = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    status: messageStatusSchema,
    reply: z.string().nullable(),
    thread_id: z.string().nullable(),
    next_wake_at: z.number().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const orchestratorMessageSchema = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    status: messageStatusSchema,
    reply: z.string().nullable(),
    threadId: z.string().nullable(),
    nextWakeAt: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export const mcpMessagesResponseSchema = z
  .object({ messages: z.array(rawMessageSchema) })
  .strict()
  .transform(({ messages }) => ({
    messages: messages.map((message) =>
      orchestratorMessageSchema.parse({
        id: message.id,
        content: message.content,
        status: message.status,
        reply: message.reply,
        threadId: message.thread_id,
        nextWakeAt: message.next_wake_at,
        lastError: message.last_error,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
      }),
    ),
  }));

export const messagesResponseSchema = z
  .object({ messages: z.array(orchestratorMessageSchema) })
  .strict();

export const submitIntentRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(12_000),
  })
  .strict();

export const submitIntentResponseSchema = z
  .object({
    messageId: z.string().min(1),
    status: z.literal("pending"),
    next: z.string().min(1),
  })
  .strict();

export const messagesQuerySchema = z
  .object({
    messageId: z
      .string()
      .regex(/^msg-[0-9a-f]{12}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const apiErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export function apiResponseSchema<T>(dataSchema: z.ZodType<T>) {
  return z.union([z.object({ ok: z.literal(true), data: dataSchema }).strict(), apiErrorSchema]);
}

export type OrchestratorStatus = z.infer<typeof statusResponseSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type OrchestratorMessage = z.infer<typeof orchestratorMessageSchema>;
export type SubmitIntentResponse = z.infer<typeof submitIntentResponseSchema>;
