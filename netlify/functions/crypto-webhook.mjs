import { createClient } from "@supabase/supabase-js";
const out=(statusCode,body)=>({statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body:JSON.stringify(body)});
export const handler=async(event)=>{
  if(event.httpMethod!=="POST") return out(405,{ok:false});
  const expected=process.env.CRYPTO_PAY_WEBHOOK_SECRET;
  if(!expected) return out(500,{ok:false,error:"Webhook secret not configured"});
  const supplied=event.headers["crypto-pay-api-secret-token"]||event.headers["Crypto-Pay-API-Secret-Token"];
  if(!supplied||supplied!==expected) return out(401,{ok:false});
  let update; try{update=JSON.parse(event.body||"{}")}catch{return out(400,{ok:false})}
  const invoice=update.invoice;
  if(update.update_type!=="invoice_paid"||!invoice||invoice.status!=="paid") return out(200,{ok:true,ignored:true});
  if(!invoice.payload||!invoice.invoice_id) return out(400,{ok:false});
  const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.rpc("pc_apply_crypto_payment",{p_order_id:invoice.payload,p_invoice_id:String(invoice.invoice_id)});
  if(error){console.error("Payment fulfillment failed:",error.message);return out(500,{ok:false})}
  return out(200,{ok:true,applied:data===true});
};
