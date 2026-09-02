export interface CommandEnvelope<TPayload = unknown> {
  readonly commandId: string;
  readonly kind: string;
  readonly payload: TPayload;
}
