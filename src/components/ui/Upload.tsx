import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "./index";

/** Upload → R2 (ou /uploads local) via POST /uploads/upload, devolve URL pública. */
export function ImageUpload({ value, onChange, label = "Imagem", aspect = "aspect-video" }: { value: string; onChange: (url: string) => void; label?: string; aspect?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const pick = async (f?: File) => {
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp|avif)$/.test(f.type)) return toast.push("err", "Use PNG, JPG, WEBP ou AVIF.");
    if (f.size > 4.5 * 1024 * 1024) return toast.push("err", "Imagem muito grande (máx. ~4 MB).");
    try {
      setBusy(true);
      const url = await api.upload(f);
      onChange(url);
      toast.push("ok", "Imagem enviada.");
    } catch (e: any) {
      toast.push("err", e.message || "Falha no upload — verifique R2/uploads configurado.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div>
      <p className="mb-1.5 text-[12.5px] font-medium uppercase tracking-wide text-zinc-400">{label}</p>
      <div className={`group relative ${aspect} w-full overflow-hidden rounded-xl border border-dashed border-line bg-ink-soft`}>
        {value ? (
          <img src={value} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-zinc-600">
            <ImagePlus size={22} />
            <span className="text-[11px]">clique para enviar (JPG/PNG/WEBP ≤ 4MB)</span>
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
          {busy ? <Loader2 className="animate-spin text-white" size={22} /> : <span className="text-xs font-semibold text-white">Trocar imagem</span>}
        </div>
        {value && !busy && (
          <button type="button" onClick={() => onChange("")} className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-zinc-200 hover:text-white">remover</button>
        )}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        <button type="button" className="absolute inset-0" onClick={() => input.current?.click()} aria-label="Enviar imagem" disabled={busy} />
      </div>
    </div>
  );
}
