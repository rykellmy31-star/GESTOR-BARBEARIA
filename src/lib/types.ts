export interface ShopSettings {
  shop_name: string;
  tagline: string;
  about: string;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  maps_query: string;
  instagram: string;
  facebook: string;
  logo_url: string;
  banner_url: string;
  brand: { gold: string; ink: string; panel: string; line: string };
  opening_hours: Record<string, { open: string; close: string } | null>;
  currency: "BRL";
  timezone: string;
  min_lead_min: number;
  horizon_days: number;
  slot_step_min: number;
  allow_online_cancel: boolean;
  allow_online_reschedule: boolean;
  cancel_cutoff_min: number;
  reschedule_cutoff_min: number;
  cancel_policy_text: string;
  barber_can_conclude: boolean;
  barber_can_cancel: boolean;
  barber_can_block: boolean;
  reviews_enabled: boolean;
  products_enabled: boolean;
  whatsapp_buttons_enabled: boolean;
}

export interface Barber {
  id: number;
  slug: string;
  name: string;
  specialty: string;
  bio: string;
  photo: string;
  work_days: string; // JSON [0..6]
  work_start: string;
  work_end: string;
  break_start: string;
  break_end: string;
  rating: number;
  reviews_count: number;
  active?: number;
  demo?: number;
  upcoming?: number;
  service_ids?: number[];
}

export interface Service {
  id: number;
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  price: number;
  duration_min: number;
  category: string;
  photo: string;
  barber_ids: number[];
  active?: number;
  show_in_catalog?: number;
  demo?: number;
}

export interface Product {
  id: number;
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  price: number;
  stock: number;
  category: string;
  photo: string;
  featured?: number;
  active?: number;
  out_of_stock?: boolean;
  demo?: number;
}

export interface Slot { t: string; label: string }

export interface Booking {
  id: number;
  code: string;
  status: string;
  starts_at: string;
  ends_at: string;
  price_cents: number;
  price?: number;
  customer_name: string;
  customer_phone?: string;
  service_name?: string;
  service_id?: number;
  barber_id?: number;
  barber_name?: string;
  barber_photo?: string;
  duration_min?: number;
  notes?: string;
  origin?: string;
  label?: string;
  can_cancel?: boolean;
  can_reschedule?: boolean;
  allowed_cancel_until?: string | null;
  starts_local?: string;
}

export interface Notification {
  id: number;
  title: string;
  body: string;
  kind: string;
  read_at: string | null;
  created_at: string;
}

export interface SessionUser { id: number; role: "admin" | "barber"; name: string; email: string; barber_id: number | null }

export interface Order {
  id: number; code: string; customer_name: string; customer_phone: string; channel: string;
  status: string; total_cents: number; total?: number; created_at: string;
  items: { product_name: string; qty: number; unit_price_cents: number }[]; items_n?: number;
}
