import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const PRODUCTS = {
  t41:  { amount: 19,  tokens: 41,  proDays: 0,  forever: false, title: "41 токен" },
  t100: { amount: 39,  tokens: 100, proDays: 0,  forever: false, title: "100 токенов" },
  t300: { amount: 99,  tokens: 300, proDays: 0,  forever: false, title: "300 токенов" },
  p3d:  { amount: 39,  tokens: 0,   proDays: 3,  forever: false, title: "Strix PRO — 3 дня" },
  p21d: { amount: 99,  tokens: 0,   proDays: 21, forever: false, title: "Strix PRO — 21 день" },
  p3m:  { amount: 199, tokens: 0,   proDays: 90, forever: false, title: "Strix PRO — 3 месяца" },
  plife:{ amount: 499, tokens: 0,   proDays: 0,  forever: true,  title: "Strix PRO — навсегда" }
};
const out=(statusCode,body)=>({statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body:JSON.stringify(body)});

export const handler=async(event)=>{
  if(event.httpMethod!=="POST") return out(405,{error:"Method not allowed"});
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,CRYPTO_PAY_API_TOKEN}=process.env;
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!CRYPTO_PAY_API_TOKEN) return out(500,{error:"Не настроены переменные сервера."});
  const auth=event.headers.authorization||event.headers.Authorization||"";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if(!token) return out(401,{error:"Сначала войдите через Google."});
  let body; try{body=JSON.parse(event.body||"{}")}catch{return out(400,{error:"Некорректный запрос."})}
  const product=PRODUCTS[body.sku];
  if(!product) return out(400,{error:"Неизвестный товар."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData,error:userError}=await db.auth.getUser(token);
  if(userError||!userData?.user) return out(401,{error:"Сессия недействительна. Войдите снова."});
  const orderId=randomUUID();
  const {error:insertError}=await db.from("payment_orders").insert({
    id:orderId,user_id:userData.user.id,sku:body.sku,amount:product.amount,currency:"RUB",
    tokens:product.tokens,pro_days:product.proDays,pro_forever:product.forever,status:"pending"
  });
  if(insertError) return out(500,{error:"Не удалось создать заказ. Проверьте SQL-настройку Supabase."});
  try{
    const r=await fetch("https://pay.crypt.bot/api/createInvoice",{method:"POST",
      headers:{"Crypto-Pay-API-Token":CRYPTO_PAY_API_TOKEN,"Content-Type":"application/json"},
      body:JSON.stringify({currency_type:"fiat",fiat:"RUB",amount:String(product.amount),description:product.title,payload:orderId,expires_in:3600})
    });
    const j=await r.json();
    if(!r.ok||!j.ok||!j.result?.bot_invoice_url) throw new Error(j.error?.name||"Crypto Pay не создал счёт.");
    const invoice=j.result;
    const {error:updateError}=await db.from("payment_orders").update({invoice_id:String(invoice.invoice_id)}).eq("id",orderId);
    if(updateError) throw new Error("Не удалось сохранить номер счёта.");
    return out(200,{pay_url:invoice.bot_invoice_url});
  }catch(e){
    await db.from("payment_orders").update({status:"failed"}).eq("id",orderId);
    return out(502,{error:e.message||"Ошибка Crypto Pay."});
  }
};
