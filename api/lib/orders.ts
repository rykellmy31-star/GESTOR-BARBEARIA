import { nowIso } from "./utils";

type OrderStatus = "novo" | "pago" | "entregue" | "cancelado";
type Result = {ok:true;status:OrderStatus;changed:boolean} | {ok:false;status:number;message:string};

/** Transição e devolução de estoque na mesma transação, com consumo único. */
export async function changeOrderStatus(db:D1Database,companyId:number,orderId:number,next:OrderStatus):Promise<Result> {
  const order=await db.prepare("SELECT id,code,status,payment_choice FROM orders WHERE id=?1 AND company_id=?2")
    .bind(orderId,companyId).first<{id:number;code:string;status:OrderStatus;payment_choice:string}>();
  if(!order) return {ok:false,status:404,message:"Pedido não encontrado"};
  if(order.status===next) return {ok:true,status:next,changed:false};
  if(order.payment_choice==="pix"&&next==="pago")
    return {ok:false,status:409,message:"Pagamento Pix só pode ser confirmado pelo próprio Mercado Pago. Não marque como recebido manualmente."};
  const flow:Record<OrderStatus,OrderStatus[]>={novo:["pago","cancelado"],pago:["entregue","cancelado"],entregue:[],cancelado:[]};
  if(!flow[order.status].includes(next)) return {ok:false,status:409,message:`Transição ${order.status} → ${next} não permitida`};
  const at=nowIso();
  const statements=[
    db.prepare("UPDATE orders SET status=?1,updated_at=?2 WHERE id=?3 AND company_id=?4 AND status=?5")
      .bind(next,at,orderId,companyId,order.status),
    db.prepare(`INSERT INTO notifications(company_id,audience,title,body,kind)
      SELECT ?1,'admin',?2,'Status alterado no painel','order' WHERE changes()=1`)
      .bind(companyId,`Pedido ${order.code}: ${next}`),
  ];
  if(next==="cancelado") {
    // A notificação só existe quando a transição ganhou a disputa. A instrução
    // seguinte preserva esse gate para todos os itens; o UPDATE soma por produto.
    statements.push(
      db.prepare(`INSERT INTO stock_movements(company_id,product_id,delta,reason,ref,created_at)
        SELECT ?1,i.product_id,i.qty,'estorno de pedido cancelado',?2,?3
        FROM order_items i JOIN products p ON p.id=i.product_id AND p.company_id=?1
        WHERE i.order_id=?4 AND changes()=1`).bind(companyId,order.code,at,orderId),
      db.prepare(`UPDATE products SET stock=stock+(
        SELECT SUM(qty) FROM order_items WHERE order_id=?1 AND product_id=products.id)
        WHERE company_id=?2 AND id IN(SELECT product_id FROM order_items WHERE order_id=?1)
        AND changes()>0`).bind(orderId,companyId),
    );
  }
  const results=await db.batch(statements);
  if(results[0].meta.changes!==1) {
    const fresh=await db.prepare("SELECT status FROM orders WHERE id=?1 AND company_id=?2").bind(orderId,companyId).first<{status:OrderStatus}>();
    return fresh?.status===next ? {ok:true,status:next,changed:false}
      : {ok:false,status:409,message:"O pedido foi alterado por outra operação. Atualize a página."};
  }
  return {ok:true,status:next,changed:true};
}
