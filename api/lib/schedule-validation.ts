import { z } from "zod";

export const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use um horário válido entre 00:00 e 23:59");
export const timezoneSchema = z.string().min(3).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: value }); return true; }
  catch { return false; }
}, "Fuso horário inválido");
export const openingRangeSchema = z.object({ open: clockTimeSchema, close: clockTimeSchema })
  .refine((range) => range.open < range.close, { message: "O fechamento deve ser depois da abertura no mesmo dia", path: ["close"] });

export const barberScheduleFields = {
  work_days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, "Não repita dias da semana"),
  work_start: clockTimeSchema,
  work_end: clockTimeSchema,
  break_start: clockTimeSchema,
  break_end: clockTimeSchema,
};
export const barberScheduleSchema = z.object(barberScheduleFields).superRefine((schedule, ctx) => {
  if (schedule.work_start >= schedule.work_end)
    ctx.addIssue({ code: "custom", path: ["work_end"], message: "O expediente deve terminar depois do início no mesmo dia" });
  // Horários iguais representam expediente sem pausa, inclusive 00:00–00:00.
  if (schedule.break_start !== schedule.break_end &&
      (schedule.break_start >= schedule.break_end || schedule.break_start < schedule.work_start || schedule.break_end > schedule.work_end))
    ctx.addIssue({ code: "custom", path: ["break_end"], message: "A pausa deve começar antes de terminar e ficar dentro do expediente" });
});
