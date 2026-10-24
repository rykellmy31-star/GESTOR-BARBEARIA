/** Fragmento interno usado dentro da própria escrita para serializar a vaga. */
export function barberCapacitySql(companyReference:"?1"|"barbers.company_id") {
  return `EXISTS(SELECT 1 FROM subscriptions s JOIN plans p ON p.code=s.plan_code
    WHERE s.company_id=${companyReference} AND (p.max_barbers<0 OR
    (SELECT COUNT(*) FROM barbers b WHERE b.company_id=${companyReference} AND b.active=1)<p.max_barbers))`;
}
