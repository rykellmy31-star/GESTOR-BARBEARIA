import { describe, expect, it } from "vitest";
import { MAX_CART_LINES, MAX_CART_QTY, normalizeCart, reconcileCart } from "../src/lib/cart";

describe("carrinho público: estoque e persistência não confiável",()=>{
  it("ignora formatos inválidos",()=>{
    for(const value of [null,undefined,[],"texto",1,false])
      expect(normalizeCart(value)).toEqual({});
  });
  it("recusa IDs e quantidades manipuladas",()=>{
    const value=JSON.parse('{"1":2,"2":0,"3":-1,"4":2.5,"5":"3","6":null,"abc":1,"__proto__":1,"7":9007199254740992,"8":99}');
    expect(normalizeCart(value)).toEqual({"1":2,"8":MAX_CART_QTY});
  });
  it("limita linhas e unidades ao máximo aceito pelo backend",()=>{
    const cart=Object.fromEntries(Array.from({length:MAX_CART_LINES+5},(_,i)=>[String(i+1),MAX_CART_QTY+50]));
    const normalized=normalizeCart(cart);
    expect(Object.keys(normalized)).toHaveLength(MAX_CART_LINES);
    expect(Object.values(normalized).every(v=>v===MAX_CART_QTY)).toBe(true);
  });
  it("reconcilia saldo, remoção e esgotamento",()=>{
    expect(reconcileCart({"1":7,"2":5,"3":3,"4":1},[
      {id:1,stock:2},{id:2,stock:0},{id:4,stock:30}
    ])).toEqual({"1":2,"4":1});
  });
});
