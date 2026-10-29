import type { SessionUser } from "../types";
import { audit } from "./audit";
import { nowIso } from "./utils";

export interface ManualRenewalInput {
  plan_code: "free" | "pro" | "scale";
  period_months: number;
  amount_cents: number;
  external_reference: string;
  note: string;
}

/**
 * Aprovação MANUAL de mensalidade já recebida fora do TIGU.
 * A referência externa impede dupla prorrogação em retries/replay.
 * NÃO chama gateway, não muda carteira e não toca nos pagamentos dos profissionais.
 */
export async function applyManualRenewal(db: D1Database, companyId: number,
  user: SessionUser, input: ManualRenewalInput
): Promise<{ok:boolean;already_applied?:boolean;error?:string;period_end?:string|null}> {
  const before=await db.prepare("SELECT plan_code,period_end FROM subscriptions WHERE company_id=?1")
    .bind(companyId).first<{plan_code:string;period_end:string|null}>();
  if(!before) return {ok:false,error:"Assinatura da empresa não encontrada."};
  const existing=await db.prepare("SELECT * FROM manual_subscription_renewals WHERE company_id=?1 AND external_reference=?2")
    .bind(companyId,input.external_reference).first<ManualRenewalInput & {applied_at:string|null}>();
  if(existing){
    const same=existing.plan_code===input.plan_code &&
      existing.period_months===input.period_months &&
      existing.amount_cents===input.amount_cents &&
      existing.note===input.note;
    if(!same) return {ok:false,error:"Referência já utilizada com dados diferentes."};
    if(existing.applied_at) return {ok:true,already_applied:true,period_end:before.period_end};
  }
  const at=nowIso();
  let results: D1Result[];
  try {
    results=await db.batch([
      db.prepare(`INSERT OR IGNORE INTO manual_subscription_renewals
        (company_id,plan_code,period_months,amount_cents,external_reference,note,operator_user_id,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS
          (SELECT 1 FROM subscriptions WHERE company_id=?1)`)
        .bind(companyId,input.plan_code,input.period_months,input.amount_cents,
          input.external_reference,input.note,user.id,at),
      db.prepare(`UPDATE subscriptions SET plan_code=?2,status='active',
        period_end=strftime('%Y-%m-%dT%H:%M:%SZ',
          CASE WHEN period_end>?3 THEN period_end ELSE ?3 END,'+'||?4||' months'),
        updated_at=?3 WHERE company_id=?1 AND EXISTS(
          SELECT 1 FROM manual_subscription_renewals m
          WHERE m.company_id=?1 AND m.external_reference=?5 AND m.applied_at IS NULL
          AND m.plan_code=?2 AND m.period_months=?4 AND m.amount_cents=?6 AND m.note=?7)`)
        .bind(companyId,input.plan_code,at,input.period_months,input.external_reference,input.amount_cents,input.note),
      db.prepare(`UPDATE companies SET plan_code=?2,updated_at=?3 WHERE id=?1 AND changes()=1`)
        .bind(companyId,input.plan_code,at),
      db.prepare(`UPDATE manual_subscription_renewals SET applied_at=?3
        WHERE company_id=?1 AND external_reference=?2 AND applied_at IS NULL AND changes()=1`)
        .bind(companyId,input.external_reference,at),
      db.prepare(`UPDATE subscription_plan_requests SET status='approved',handled_by=?3,
        handled_at=?4,note='Atendido pela renovação manual' WHERE company_id=?1
        AND plan_code=?2 AND status='pending' AND EXISTS(
          SELECT 1 FROM manual_subscription_renewals WHERE company_id=?1
          AND external_reference=?5 AND applied_at=?4)`)
        .bind(companyId,input.plan_code,user.id,at,input.external_reference),
    ]);
  } catch {
    return {ok:false,error:"Não foi possível salvar a renovação. Confira o banco de homologação."};
  }
  if(results[1].meta.changes!==1||results[2].meta.changes!==1||results[3].meta.changes!==1)
    return {ok:false,error:"Renovação não aplicada. Confira se a referência já foi registrada."};
  await audit(db,user,"subscription.manual_renewal","manual_subscription_renewal",
    input.external_reference,{...input,source:"external_payment",previous_period_end:before.period_end},
    {companyId,scope:"platform"});
  const after=await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=?1")
    .bind(companyId).first<{period_end:string|null}>();
  return {ok:true,period_end:after?.period_end};
}
