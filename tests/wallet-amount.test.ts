import { describe, expect, it } from "vitest";
import { parseTopupAmountCents } from "../api/lib/wallet-amount";

describe("conversão do valor de recarga Pix",()=>{
  it("aceita centavos exatos e separadores brasileiros",()=>{
    expect(parseTopupAmountCents("35")).toBe(3500);
    expect(parseTopupAmountCents("35,00")).toBe(3500);
    expect(parseTopupAmountCents("35.50")).toBe(3550);
    expect(parseTopupAmountCents("1.000,50")).toBe(100050);
    expect(parseTopupAmountCents(" 15,9 ")).toBe(1590);
  });
  it("recusa entradas inválidas, ambíguas e fora de precisão segura",()=>{
    for(const v of ["","-10","10,999","R$35","1,000,50","35,","NaN","1e3","12 00","9999999999999999999"])
      expect(parseTopupAmountCents(v)).toBeNull();
  });
});
