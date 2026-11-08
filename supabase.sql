-- Выполнить в Supabase -> SQL Editor -> New query -> Run.
-- Скрипт предполагает, что public.wallets уже содержит user_id (уникальный),
-- tokens, pro_until, pro_forever.

create table if not exists public.payment_orders (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sku text not null,
  amount numeric(12,2) not null,
  currency text not null default 'RUB',
  tokens integer not null default 0,
  pro_days integer not null default 0,
  pro_forever boolean not null default false,
  status text not null default 'pending' check(status in ('pending','paid','failed')),
  invoice_id text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from anon, authenticated;

create or replace function public.pc_apply_crypto_payment(p_order_id uuid,p_invoice_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v public.payment_orders%rowtype;
begin
  select * into v from public.payment_orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v.status='paid' then return false; end if;
  if v.status<>'pending' then raise exception 'Order is not pending'; end if;
  if v.invoice_id is not null and v.invoice_id<>p_invoice_id then raise exception 'Invoice mismatch'; end if;

  if v.tokens>0 then
    update public.wallets set tokens=coalesce(tokens,0)+v.tokens where user_id=v.user_id;
    if not found then insert into public.wallets(user_id,tokens,pro_until,pro_forever) values(v.user_id,v.tokens,null,false); end if;
  elsif v.pro_forever then
    update public.wallets set pro_forever=true where user_id=v.user_id;
    if not found then insert into public.wallets(user_id,tokens,pro_until,pro_forever) values(v.user_id,0,null,true); end if;
  elsif v.pro_days>0 then
    update public.wallets set pro_until=greatest(coalesce(pro_until,now()),now())+make_interval(days=>v.pro_days) where user_id=v.user_id;
    if not found then insert into public.wallets(user_id,tokens,pro_until,pro_forever) values(v.user_id,0,now()+make_interval(days=>v.pro_days),false); end if;
  end if;

  update public.payment_orders set status='paid',invoice_id=p_invoice_id,paid_at=now() where id=p_order_id;
  return true;
end $$;
revoke all on function public.pc_apply_crypto_payment(uuid,text) from public,anon,authenticated;
grant execute on function public.pc_apply_crypto_payment(uuid,text) to service_role;
