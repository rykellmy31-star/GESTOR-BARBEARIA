/** Subconjunto de booking usado pelo agendador de mensagens. */
export interface BookingRow {
  id: number;
  company_id: number;
  code: string;
  customer_name: string;
  customer_phone: string;
  whatsapp_optin: number;
  barber_name?: string;
  service_name?: string;
  starts_at: string;
  status: string;
  schedule_version?: number;
}
