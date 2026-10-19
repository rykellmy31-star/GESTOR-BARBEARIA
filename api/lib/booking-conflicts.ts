/** Conflitos reais de intervalo e conflitos da grade resultam na mesma resposta HTTP. */
export function isBookingConflictError(error:unknown):boolean {
  const message=String((error as Error)?.message??error);
  return message.includes("UNIQUE constraint failed: booking_slots") || message.includes("TIGU_BOOKING_OVERLAP");
}
